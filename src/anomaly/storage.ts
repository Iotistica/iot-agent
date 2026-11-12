/**
 * ANOMALY STORAGE SERVICE
 * ========================
 *
 * SQLite storage layer for anomaly detection alerts and baselines.
 * Uses the existing agent.sqlite database with dedicated tables.
 */

import type { DatabaseSync as Database } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import type { AgentLogger } from '../shared/types.js';
import type { CanonicalDeviceState, StatisticalBuffer } from './types.js';
import { getMedian, getMAD } from './buffer.js';

export interface AnomalyBaselineRecord {
	id?: number;
	metric: string;
	device_id: string;
	profile: string | null; // Profile config identifier (e.g., 'Generic', 'COMAP')
	time_slot: number; // -1 for overall, 0-1 for day/night, 0-23 for hourly, 0-167 for weekly
	device_state: CanonicalDeviceState;
	mean: number | null;
	median: number | null;
	std_dev: number | null;
	mad: number | null;
	min: number | null;
	max: number | null;
	q1: number | null;
	q3: number | null;
	iqr: number | null;
	sample_count: number;
	calculated_at: number;
	window_start: number | null;
	window_end: number | null;
	created_at?: Date;
	updated_at?: Date;
}

type AnomalyBaselineRow = Omit<AnomalyBaselineRecord, 'created_at' | 'updated_at'> & {
	created_at?: string | Date | null;
	updated_at?: string | Date | null;
};

type SQLiteResult<T> = T;
type StorageTableName = 'anomaly_baselines';

type AnomalyBaselineInsertRecord = Omit<
	AnomalyBaselineRecord,
	'id' | 'created_at' | 'updated_at' | 'time_slot' | 'device_state' | 'device_id'
> &
	Partial<Pick<AnomalyBaselineRecord, 'time_slot' | 'device_state' | 'device_id'>>;

type StorageInsertTableMap = {
	anomaly_baselines: AnomalyBaselineInsertRecord;
};

const ALLOWED_TABLES = new Set<StorageTableName>([
	'anomaly_baselines',
]);

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class AnomalyStorageService {
	private db: Database;
	private logger?: AgentLogger;
	private retention: number;
	private eventRetentionDays: number;
	private incidentRetentionDays: number;
	private alertRetentionDays: number;
	private cleanupIntervalMs: number = 86400000; // 24 hours
	private cleanupTimer?: NodeJS.Timeout;
	private readonly tableColumns = new Map<string, Set<string>>();
	private readonly seasonalFallbackLogThrottleMs = 5 * 60 * 1000;
	private readonly seasonalFallbackLastLogAt = new Map<string, number>();
	private schemaCache?: {
		baselines: Set<string>;
	};

	constructor(
		db: Database,
		retention: number,
		logger?: AgentLogger,
		options?: {
			eventRetentionDays?: number;
			incidentRetentionDays?: number;
			alertRetentionDays?: number;
		},
	) {
		this.db = db;
		this.retention = retention;
		this.logger = logger;
		this.eventRetentionDays = options?.eventRetentionDays ?? retention;
		this.incidentRetentionDays = options?.incidentRetentionDays ?? retention;
		this.alertRetentionDays = options?.alertRetentionDays ?? retention;
	}

	private queryOne<T>(sql: string, params: readonly unknown[] = []): SQLiteResult<T | undefined> {
		return this.db.prepare(sql).get(...params as SQLInputValue[]) as T | undefined;
	}

	private queryAll<T>(sql: string, params: readonly unknown[] = []): SQLiteResult<T[]> {
		return this.db.prepare(sql).all(...params as SQLInputValue[]) as T[];
	}

	private getRetentionCutoff(now: number = Date.now()): number {
		return this.getCutoff(this.retention, now);
	}

	private getCutoff(days: number, now: number = Date.now()): number {
		return now - days * 24 * 60 * 60 * 1000;
	}

	private shouldLogSeasonalFallback(
		metric: string,
		timeSlot: number,
		deviceState: CanonicalDeviceState,
		profile: string | null,
		deviceId: string,
	): boolean {
		const now = Date.now();
		const key = `${metric}|${profile ?? 'null'}|${deviceId}|${deviceState}|${timeSlot}`;
		const lastLoggedAt = this.seasonalFallbackLastLogAt.get(key);

		if (
			typeof lastLoggedAt === 'number' &&
			now - lastLoggedAt < this.seasonalFallbackLogThrottleMs
		) {
			return false;
		}

		this.seasonalFallbackLastLogAt.set(key, now);
		if (this.seasonalFallbackLastLogAt.size > 1000) {
			this.seasonalFallbackLastLogAt.clear();
		}

		return true;
	}

	private hasTable(tableName: string): boolean {
		const row = this.queryOne<{ name?: string }>(
			`SELECT name
			FROM sqlite_master
			WHERE type = 'table' AND name = ?
			LIMIT 1`,
			[tableName],
		);

		return row?.name === tableName;
	}

	private getTableColumns(tableName: 'anomaly_baselines'): Set<string> {
		const cached = this.tableColumns.get(tableName);
		if (cached) {
			return cached;
		}

		const rows = this.queryAll<{ name: string }>(`PRAGMA table_info(${tableName})`);

		const columns = new Set(rows.map((row) => row.name));
		this.tableColumns.set(tableName, columns);
		return columns;
	}

	private getSchemaCache(): { baselines: Set<string> } {
		if (!this.schemaCache) {
			this.schemaCache = {
				baselines: this.getTableColumns('anomaly_baselines'),
			};
		}

		return this.schemaCache;
	}

	private hasColumn(tableName: 'anomaly_baselines', columnName: string): boolean {
		return this.getSchemaCache().baselines.has(columnName);
	}

	private mapBaselineRow(row: AnomalyBaselineRow): AnomalyBaselineRecord {
		return {
			...row,
			created_at: row.created_at ? new Date(row.created_at) : undefined,
			updated_at: row.updated_at ? new Date(row.updated_at) : undefined,
		};
	}

	private buildInsertStatement(
		tableName: StorageTableName,
		record: StorageInsertTableMap[StorageTableName],
		conflictColumns?: string[],
	): { sql: string; values: unknown[] } {
		if (!ALLOWED_TABLES.has(tableName)) {
			throw new Error(`Invalid table name: ${tableName}`);
		}

		const columns = Object.keys(record);
		for (const column of columns) {
			if (!SAFE_IDENTIFIER_PATTERN.test(column)) {
				throw new Error(`Invalid column name: ${column}`);
			}
		}

		const placeholders = columns.map(() => '?').join(', ');
		const values = columns.map((column) => (record as Record<string, unknown>)[column]);
		let sql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;

		if (conflictColumns && conflictColumns.length > 0) {
			for (const conflictColumn of conflictColumns) {
				if (!SAFE_IDENTIFIER_PATTERN.test(conflictColumn)) {
					throw new Error(`Invalid conflict column name: ${conflictColumn}`);
				}
			}

			const updateColumns = columns.filter((column) => !conflictColumns.includes(column));
			const updateClause = updateColumns
				.map((column) => `${column} = excluded.${column}`)
				.join(', ');
			sql += ` ON CONFLICT(${conflictColumns.join(', ')}) DO UPDATE SET ${updateClause}`;
		}

		return { sql, values };
	}

	private buildInsertStatementForTable<K extends keyof StorageInsertTableMap>(
		tableName: K,
		record: StorageInsertTableMap[K],
		conflictColumns?: Array<keyof StorageInsertTableMap[K] & string>,
	): { sql: string; values: unknown[] } {
		return this.buildInsertStatement(tableName, record, conflictColumns);
	}

	private getBaselineSchema() {
		return {
			hasTimeSlot: this.hasColumn('anomaly_baselines', 'time_slot'),
			hasDeviceState: this.hasColumn('anomaly_baselines', 'device_state'),
			hasDeviceId: this.hasColumn('anomaly_baselines', 'device_id'),
		};
	}

	private buildMetricMatchClause(metrics: string[]): { clause: string; params: unknown[] } {
		const exactClause = metrics.map(() => '?').join(', ');
		const likeClause = metrics.map(() => 'metric LIKE ?').join(' OR ');
		return {
			clause: `(metric IN (${exactClause}) OR ${likeClause})`,
			params: [...metrics, ...metrics.map((metric) => `%_${metric}`)],
		};
	}

	private buildBaselineWhere(
		metric: string,
		options: {
			timeSlot?: number;
			profile?: string | null;
			deviceState?: CanonicalDeviceState;
			deviceId?: string;
			minimumSamples?: number;
		},
	): { sql: string; params: unknown[] } {
		const whereParts = ['metric = ?'];
		const params: unknown[] = [metric];
		const schema = this.getBaselineSchema();

		if (typeof options.minimumSamples === 'number') {
			whereParts.push('sample_count >= ?');
			params.push(options.minimumSamples);
		}

		if (schema.hasTimeSlot && typeof options.timeSlot === 'number') {
			whereParts.push('time_slot = ?');
			params.push(options.timeSlot);
		}

		if (options.profile !== null && options.profile !== undefined) {
			whereParts.push('profile = ?');
			params.push(options.profile);
		}

		if (schema.hasDeviceState && options.deviceState) {
			whereParts.push('device_state = ?');
			params.push(options.deviceState);
		}

		if (schema.hasDeviceId && options.deviceId) {
			whereParts.push('device_id = ?');
			params.push(options.deviceId);
		}

		return {
			sql: whereParts.join(' AND '),
			params,
		};
	}

	private runBaselineQuery(whereSql: string, params: readonly unknown[]): AnomalyBaselineRecord | null {
		const row = this.queryOne<AnomalyBaselineRow>(
			`SELECT *
			FROM anomaly_baselines
			WHERE ${whereSql}
			ORDER BY calculated_at DESC
			LIMIT 1`,
			params,
		);

		return row ? this.mapBaselineRow(row) : null;
	}

	private queryBaseline(
		metric: string,
		options: {
			timeSlot?: number;
			profile?: string | null;
			deviceState?: CanonicalDeviceState;
			deviceId?: string;
			minimumSamples?: number;
		},
	): AnomalyBaselineRecord | null {
		const { sql, params } = this.buildBaselineWhere(metric, options);
		return this.runBaselineQuery(sql, params);
	}

	/**
	* Initialize storage service and start cleanup job
	*/
	async initialize(): Promise<void> {
		if (!this.hasTable('anomaly_baselines')) {
			throw new Error(
				'Anomaly detection tables not found. Run database migrations first.'
			);
		}

		this.schemaCache = {
			baselines: this.getTableColumns('anomaly_baselines'),
		};

		this.logger?.infoSync('Anomaly storage service initialized', {
			component: 'Anomaly',
			retention: this.retention,
		});

		// Start periodic cleanup
		this.startPeriodicCleanup();
	}

	/**
	* Store statistical baseline for a metric
	*/
	async storeBaseline(
		metric: string,
		buffer: StatisticalBuffer,
		calculatedAt: number,
		timeSlot: number = -1, // -1 = overall baseline (default)
		profile: string | null = null, // Profile identifier (null for system metrics)
		deviceState: CanonicalDeviceState = 'unknown',
		deviceId: string = 'unknown-device'
	): Promise<void> {
		try {
			const schema = this.getBaselineSchema();
			// Calculate percentiles for IQR
			const sortedValues = [...buffer.values].slice(0, buffer.size).sort((a, b) => a - b);
			const q1Index = Math.floor(buffer.size * 0.25);
			const q3Index = Math.floor(buffer.size * 0.75);
			const q1 = sortedValues[q1Index] || null;
			const q3 = sortedValues[q3Index] || null;
			const iqr = q1 !== null && q3 !== null ? q3 - q1 : null;

			const record: AnomalyBaselineInsertRecord = {
				metric,
				// Use '' not null: SQLite treats NULL != NULL in UNIQUE indexes so ON CONFLICT
				// would never fire and each save would create a new row instead of upserting.
				profile: profile ?? '',
				mean: buffer.mean,
				median: getMedian(buffer),
				std_dev: Math.sqrt(buffer.variance),
				mad: getMAD(buffer),
				min: Math.min(...buffer.values.slice(0, buffer.size)),
				max: Math.max(...buffer.values.slice(0, buffer.size)),
				q1,
				q3,
				iqr,
				sample_count: buffer.size,
				calculated_at: calculatedAt,
				window_start: buffer.timestamps[0] || null,
				window_end: buffer.timestamps[buffer.size - 1] || null,
			};

			if (schema.hasTimeSlot) {
				record.time_slot = timeSlot;
			}
			if (schema.hasDeviceState) {
				record.device_state = deviceState;
			}
			if (schema.hasDeviceId) {
				record.device_id = deviceId;
			}

			this.logger?.debugSync('Inserting baseline record', {
				component: 'Anomaly',
				metric,
				device_id: deviceId,
				device_state: deviceState,
				sample_count: buffer.size,
				mean: record.mean,
				median: record.median,
			});

			if (!schema.hasDeviceState || !schema.hasDeviceId) {
				this.logger?.debugSync('Storing baseline without full state/device schema', {
					component: 'Anomaly',
					metric,
					device_id: deviceId,
					device_state: deviceState,
					note: 'Run anomaly baseline schema migrations to enable full state-aware baselines',
				});
			}

			const conflictColumns: Array<keyof AnomalyBaselineInsertRecord & string> = ['metric', 'profile'];
			if (schema.hasTimeSlot) {
				conflictColumns.push('time_slot');
			}
			if (schema.hasDeviceState) {
				conflictColumns.push('device_state');
			}
			if (schema.hasDeviceId) {
				conflictColumns.push('device_id');
			}

			const { sql, values } = this.buildInsertStatementForTable('anomaly_baselines', record, conflictColumns);
			this.db.prepare(sql).run(...values as SQLInputValue[]);
		} catch (error) {
			this.logger?.errorSync('Failed to store anomaly baseline', error as Error, {
				component: 'Anomaly',
				metric,
				device_id: deviceId,
				device_state: deviceState,
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
		// Don't re-throw - baseline storage failures shouldn't break anomaly detection
		}
	}

	/**
	* Check if sufficient baselines exist for warm-up skip logic
	* Returns true if baselines exist for at least minCoveragePercent of metrics with minSamples each
	*/
	async checkBaselineCoverage(
		metrics: string[],
		minSamples: number = 30,
		minCoveragePercent: number = 0.8
	): Promise<{ hasCoverage: boolean; coveragePercent: number; metricsWithBaselines: number }> {
		if (metrics.length === 0) {
			return { hasCoverage: false, coveragePercent: 0, metricsWithBaselines: 0 };
		}

		try {
			const { clause, params } = this.buildMetricMatchClause(metrics);
			// Find metrics with ANY baselines (have been collected at least once)
			// Support both exact matches (e.g., "temperature") and canonical keys (e.g., "8602805f-..._c11224a6-..._temperature")
			const anyBaselines = this.queryAll<{ metric: string }>(
				`SELECT metric
				FROM anomaly_baselines
				WHERE ${clause}
				GROUP BY metric`,
				params,
			);

			const collectibleMetrics = anyBaselines.length;

			// If no metrics have ever been collected, can't skip warm-up
			if (collectibleMetrics === 0) {
				return { hasCoverage: false, coveragePercent: 0, metricsWithBaselines: 0 };
			}

			// Find metrics with SUFFICIENT baselines (minSamples+)
			const sufficientBaselines = this.queryAll<{ metric: string }>(
				`SELECT metric
				FROM anomaly_baselines
				WHERE sample_count >= ?
				AND ${clause}
				GROUP BY metric`,
				[minSamples, ...params],
			);

			const metricsWithBaselines = sufficientBaselines.length;
			// Coverage = sufficient / collectible (excludes never-collected metrics like cpu_temp on Windows)
			const coveragePercent = metricsWithBaselines / collectibleMetrics;
			const hasCoverage = coveragePercent >= minCoveragePercent;

			return { hasCoverage, coveragePercent, metricsWithBaselines };
		} catch (error: unknown) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.logger?.warnSync('Failed to check baseline coverage', {
				component: 'Anomaly',
				error: err.message,
			});
			return { hasCoverage: false, coveragePercent: 0, metricsWithBaselines: 0 };
		}
	}

	/**
	* Get the latest baseline for a metric by metric name only, ignoring device_id and device_state.
	* Used by live simulation interceptor to look up baselines using the full canonical metric key.
	*/
	async getBaselineForMetric(
		metric: string,
		minimumSamples: number = 10,
	): Promise<AnomalyBaselineRecord | null> {
		return this.queryBaseline(metric, { minimumSamples });
	}

	/**
	* Get latest baseline for a metric and time slot
	* Falls back to overall baseline (-1) if seasonal baseline not found or has insufficient data
	* Backward compatible: falls back to old schema if time_slot column doesn't exist
	* Automatically retries with pool recovery on timeout
	*/
	async getLatestBaseline(
		metric: string,
		timeSlot: number = -1,
		minimumSamples: number = 10,
		profile: string | null = null, // Filter by profile (null for system metrics)
		deviceState: CanonicalDeviceState = 'unknown',
		deviceId: string = 'unknown-device'
	): Promise<AnomalyBaselineRecord | null> {
		const schema = this.getBaselineSchema();
		const deviceCandidates = [deviceId];
		if (schema.hasDeviceId && deviceId !== 'unknown-device') {
			deviceCandidates.push('unknown-device');
		}

		// Try to get seasonal baseline first
		if (schema.hasTimeSlot && timeSlot !== -1) {
			let seasonalBaseline: AnomalyBaselineRecord | null = null;
			for (const candidateDeviceId of deviceCandidates) {
				seasonalBaseline = this.queryBaseline(metric, {
					timeSlot,
					profile,
					deviceState: schema.hasDeviceState ? deviceState : undefined,
					deviceId: schema.hasDeviceId ? candidateDeviceId : undefined,
				});

				if (!seasonalBaseline && schema.hasDeviceState && deviceState !== 'unknown') {
					seasonalBaseline = this.queryBaseline(metric, {
						timeSlot,
						profile,
						deviceState: 'unknown',
						deviceId: schema.hasDeviceId ? candidateDeviceId : undefined,
					});
				}

				if (seasonalBaseline) {
					break;
				}
			}

			if (seasonalBaseline && seasonalBaseline.sample_count >= minimumSamples) {
				return seasonalBaseline;
			}

			if (this.shouldLogSeasonalFallback(metric, timeSlot, deviceState, profile, deviceId)) {
				this.logger?.debugSync('Seasonal baseline insufficient, falling back to overall', {
					component: 'Anomaly',
					metric,
					deviceState,
					timeSlot,
					samples: seasonalBaseline?.sample_count || 0,
					minimumSamples,
				});
			}
		}

		// Get overall baseline (time_slot = -1) or legacy baseline (no time_slot)
		if (schema.hasTimeSlot) {
			for (const candidateDeviceId of deviceCandidates) {
				let baseline = this.queryBaseline(metric, {
					timeSlot: -1,
					profile,
					deviceState: schema.hasDeviceState ? deviceState : undefined,
					deviceId: schema.hasDeviceId ? candidateDeviceId : undefined,
				});

				if (!baseline && schema.hasDeviceState && deviceState !== 'unknown') {
					baseline = this.queryBaseline(metric, {
						timeSlot: -1,
						profile,
						deviceState: 'unknown',
						deviceId: schema.hasDeviceId ? candidateDeviceId : undefined,
					});
				}

				if (baseline) {
					return baseline;
				}
			}
			return null;
		}

		return this.queryBaseline(metric, { minimumSamples: undefined });
	}


	/**
	* Clear baselines for a specific profile (OPTIONAL - for manual cleanup only)
	* Normally not needed - profile field automatically filters baselines
	* Use only when permanently removing a profile config from system
	* @param profile - Profile identifier (e.g., 'Generic', 'COMAP')
	* @param metricPattern - Optional metric pattern (e.g., 'modbus_%' for all Modbus metrics)
	*/
	async clearBaselinesForProfile(profile: string, metricPattern?: string): Promise<number> {
		try {
			const whereParts = ['profile = ?'];
			const params: unknown[] = [profile];

			if (metricPattern) {
				whereParts.push('metric LIKE ?');
				params.push(metricPattern);
			}

			const deleted = Number(this.db
				.prepare(`DELETE FROM anomaly_baselines WHERE ${whereParts.join(' AND ')}`)
				.run(...params as SQLInputValue[]).changes);

			if (deleted > 0) {
				this.logger?.infoSync('Cleared baselines after profile change', {
					component: 'Anomaly',
					profile,
					metricPattern: metricPattern || 'all',
					deleted,
				});
			}

			return deleted;
		} catch (error) {
			this.logger?.errorSync('Failed to clear baselines for profile', error as Error, {
				component: 'Anomaly',
				profile,
				metricPattern,
			});
			return 0;
		}
	}

	/**
	* Clean up old records based on historyDays configuration
	*/
	async cleanup(): Promise<void> {
		try {
			// Delete old baselines
			const deletedBaselines = this.db
				.prepare('DELETE FROM anomaly_baselines WHERE calculated_at < ?')
				.run(this.getRetentionCutoff()).changes;

			// Delete old events. Events are immutable observations, so a plain age cutoff is safe.
			const deletedEvents = this.hasTable('anomaly_events')
				? this.db
					.prepare('DELETE FROM anomaly_events WHERE timestamp_ms < ?')
					.run(this.getCutoff(this.eventRetentionDays)).changes
				: 0;

			// Only prune resolved incidents — an open/active incident represents an ongoing
			// issue and shouldn't disappear out from under an operator just because it's old.
			const deletedIncidents = this.hasTable('anomaly_incidents')
				? this.db
					.prepare("DELETE FROM anomaly_incidents WHERE status = 'resolved' AND last_seen < ?")
					.run(this.getCutoff(this.incidentRetentionDays)).changes
				: 0;

			const deletedAlerts = this.hasTable('anomaly_alerts')
				? this.db
					.prepare('DELETE FROM anomaly_alerts WHERE created_at < ?')
					.run(this.getCutoff(this.alertRetentionDays)).changes
				: 0;

			if (deletedBaselines > 0 || deletedEvents > 0 || deletedIncidents > 0 || deletedAlerts > 0) {
				this.logger?.infoSync('Cleaned up old anomaly records', {
					component: 'Anomaly',
					deleted_baselines: deletedBaselines,
					deleted_events: deletedEvents,
					deleted_incidents: deletedIncidents,
					deleted_alerts: deletedAlerts,
					retention_days: this.retention,
					event_retention_days: this.eventRetentionDays,
					incident_retention_days: this.incidentRetentionDays,
					alert_retention_days: this.alertRetentionDays,
				});
			}
		} catch (error) {
			this.logger?.errorSync('Failed to cleanup old anomaly records', error as Error, {
				component: 'Anomaly',
			});
		}
	}

	/**
	* Start periodic cleanup job
	*/
	private startPeriodicCleanup(): void {
		// Run cleanup immediately
		this.cleanup();

		// Schedule periodic cleanup (every 24 hours)
		this.cleanupTimer = (globalThis as any).setInterval(() => {
			this.cleanup();
		}, this.cleanupIntervalMs);

		this.logger?.infoSync('Started periodic anomaly cleanup', {
			component: 'Anomaly',
			interval_hours: this.cleanupIntervalMs / (60 * 60 * 1000),
		});
	}

	/**
	* Stop the storage service and cleanup timers
	*/
	stop(): void {
		if (this.cleanupTimer) {
			(globalThis as any).clearInterval(this.cleanupTimer);
			this.cleanupTimer = undefined;
		}

		this.logger?.infoSync('Anomaly storage service stopped', {
			component: 'Anomaly',
		});
	}

	/**
	* Update retention period
	*/
	updateRetention(days: number): void {
		this.retention = days;
		this.logger?.infoSync('Updated anomaly retention period', {
			component: 'Anomaly',
			retention: days,
		});
	}

	/**
	* Update per-table retention overrides for events/incidents/alerts.
	* Pass `undefined` for a field to leave it unchanged.
	*/
	updateRecordRetention(options: {
		eventRetentionDays?: number;
		incidentRetentionDays?: number;
		alertRetentionDays?: number;
	}): void {
		if (options.eventRetentionDays !== undefined) this.eventRetentionDays = options.eventRetentionDays;
		if (options.incidentRetentionDays !== undefined) this.incidentRetentionDays = options.incidentRetentionDays;
		if (options.alertRetentionDays !== undefined) this.alertRetentionDays = options.alertRetentionDays;

		this.logger?.infoSync('Updated anomaly record retention periods', {
			component: 'Anomaly',
			eventRetentionDays: this.eventRetentionDays,
			incidentRetentionDays: this.incidentRetentionDays,
			alertRetentionDays: this.alertRetentionDays,
		});
	}
}
