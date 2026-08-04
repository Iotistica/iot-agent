import { EventEmitter } from 'events';
import { Pool } from 'pg';
import type { IPublishPlugin, PublishBatchItem, Logger } from '../core/types.js';
import { toDeviceUuid } from '../../db/models/device.model.js';
import type { PointIdentity } from '../../point-name/index.js';

interface TimescaleDbConfig {
	host: string;
	port: number;
	database: string;
	user: string;
	password?: string;
	ssl?: boolean;
	rejectUnauthorized?: boolean;
	poolSize?: number;
	maxRowsPerInsert?: number;
	connectTimeoutMs?: number;
	statementTimeoutMs?: number;
	applicationName?: string;
}

interface TagsPayload {
	timestamp?: number;
	node?: string;
	group?: string;
	// name is already normalizedName-preferred (falls back to the raw identifier) when the
	// point-name interceptor ran — see PublishManager.mapTagPayload(). rawName/provisionalPointId
	// are flat alongside it.
	tags?: Array<{ name: string; value: unknown; error?: unknown; rawName?: string; provisionalPointId?: string }>;
}

interface CustomPayload {
	timestamp?: string | number;
	protocol?: string;
	messages?: Array<Record<string, unknown>>;
}

interface ReadingRow {
	time: Date;
	agent_uuid: string;
	metric_name: string;
	value: number | null;
	quality: string;
	unit: string | null;
	protocol: string;
	extra: Record<string, unknown>;
}

function isTagsPayload(obj: unknown): obj is TagsPayload {
	return typeof obj === 'object' && obj !== null && 'tags' in obj && Array.isArray((obj as TagsPayload).tags);
}

function loadConfig(raw: Record<string, unknown> | null, logger?: Logger): TimescaleDbConfig {
	if (!raw) throw new Error('TimescaleDB destination requires configuration');

	const host = typeof raw.host === 'string' ? raw.host.trim() : '';
	const database = typeof raw.database === 'string' ? raw.database.trim() : '';
	const user = typeof raw.user === 'string' ? raw.user.trim() : '';

	if (!host) throw new Error('TimescaleDB config missing required field: host');
	if (!database) throw new Error('TimescaleDB config missing required field: database');
	if (!user) throw new Error('TimescaleDB config missing required field: user');

	const password = typeof raw.password === 'string' && raw.password.length > 0 ? raw.password : undefined;
	if (!password) {
		logger?.warn('TimescaleDB config has no password — only safe if the server uses trust/peer/mTLS auth');
	}

	return {
		host,
		port: typeof raw.port === 'number' && raw.port > 0 ? raw.port : 5432,
		database,
		user,
		password,
		ssl: raw.ssl === true,
		rejectUnauthorized: raw.rejectUnauthorized !== false,
		poolSize: typeof raw.poolSize === 'number' && raw.poolSize > 0 ? raw.poolSize : 5,
		maxRowsPerInsert: typeof raw.maxRowsPerInsert === 'number' && raw.maxRowsPerInsert > 0 ? raw.maxRowsPerInsert : 200,
		connectTimeoutMs: typeof raw.connectTimeoutMs === 'number' && raw.connectTimeoutMs > 0 ? raw.connectTimeoutMs : 10000,
		statementTimeoutMs: typeof raw.statementTimeoutMs === 'number' && raw.statementTimeoutMs > 0 ? raw.statementTimeoutMs : 30000,
		applicationName: typeof raw.applicationName === 'string' && raw.applicationName ? raw.applicationName : 'iotistica-agent',
	};
}

// Ported from ingestion/src/db/connection.ts — same transient-error classification and backoff schedule.
const TRANSIENT_PG_CODES = new Set(['57P01', '57P02', '57P03', '08000', '08006', '08001', '08004']);
const TRANSIENT_NODE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN']);
const TRANSIENT_MESSAGE_FRAGMENTS = [
	'server conn crashed',
	'server login has been failing',
	'Connection terminated unexpectedly',
	'connect failed',
];

function isTransientError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as Error & { code?: string }).code;
	if (code && (TRANSIENT_PG_CODES.has(code) || TRANSIENT_NODE_CODES.has(code))) return true;
	const msg = error.message ?? '';
	return TRANSIENT_MESSAGE_FRAGMENTS.some((fragment) => msg.includes(fragment));
}

async function queryWithRetry(
	pool: Pool,
	text: string,
	params: unknown[],
	logger?: Logger,
	maxAttempts = 8,
): Promise<void> {
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			await pool.query(text, params);
			return;
		} catch (error) {
			if (isTransientError(error) && attempt < maxAttempts) {
				const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 15000);
				logger?.warn(`TimescaleDB: transient error, retrying (attempt ${attempt}/${maxAttempts}, ${delayMs}ms)`, {
					error: (error as Error).message,
				});
				await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
				continue;
			}
			throw error;
		}
	}
	throw new Error('Unreachable retry state');
}

// Ported from ingestion/src/services/readings-normalizer.ts's normalizeQuality().
function normalizeQuality(quality: unknown): string {
	if (typeof quality === 'string') {
		const q = quality.toLowerCase().trim();
		if (['good', 'bad', 'uncertain', 'stale', 'unknown'].includes(q)) return q;
		if (q.includes('good') || q === 'ok' || q === 'valid') return 'good';
		if (q.includes('uncertain') || q === 'questionable') return 'uncertain';
		if (q.includes('stale') || q === 'old' || q === 'timeout') return 'stale';
		if (q.includes('bad') || q === 'error' || q === 'invalid' || q === 'fail') return 'bad';
		return 'unknown';
	}

	if (typeof quality === 'number') {
		if (quality === 0 || quality === 1) return 'good';
		if ((quality & 0xC0000000) === 0x00000000) return 'good';
		if ((quality & 0xC0000000) === 0x40000000) return 'uncertain';
		if ((quality & 0xC0000000) === 0x80000000) return 'bad';
		if (quality === 0x40940000 || quality === 0x409B0000) return 'stale';
		return quality > 0 ? 'unknown' : 'bad';
	}

	if (quality === true) return 'good';
	if (quality === false) return 'bad';
	return 'unknown';
}

const KNOWN_PROTOCOLS = new Set(['modbus', 'opcua', 'snmp', 'can', 'mqtt', 'bacnet', 'system']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function detectProtocolFromTopic(topic: string, explicit?: unknown): string {
	if (typeof explicit === 'string') {
		const v = explicit.trim().toLowerCase();
		if (KNOWN_PROTOCOLS.has(v)) return v;
	}
	const seg = topic.split('/').filter(Boolean).pop()?.toLowerCase() ?? '';
	for (const p of ['modbus', 'opcua', 'snmp', 'can']) {
		if (seg === p || seg.startsWith(`${p}_`)) return p;
	}
	return 'mqtt';
}

function pickUuid(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed && UUID_REGEX.test(trimmed) ? trimmed : undefined;
}

function pickNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

// Some OPC-UA servers tag device groups with a human-readable identifier (e.g.
// "ahu-1") rather than a real UUID, despite the "device_uuid" field name — the
// devices table (device.model.ts) derives a stable UUID from that raw tag via
// the same toDeviceUuid() this reuses, so a reading's extra.device_uuid always
// agrees with the Devices page's UUID column for the same physical device,
// with no DB lookup needed.
function resolveDeviceUuid(msg: Record<string, unknown>): string | null {
	const raw = pickNonEmptyString(msg.device_uuid) ?? pickNonEmptyString(msg.deviceUuid) ?? pickNonEmptyString(msg.asset_uuid);
	return raw ? toDeviceUuid(raw) : null;
}

function coerceValue(rawValue: unknown): number | null {
	if (typeof rawValue === 'number' && isFinite(rawValue)) return rawValue;
	if (typeof rawValue === 'boolean') return rawValue ? 1 : 0;
	return null;
}

function resolveTimestamp(value: unknown, fallback: Date): Date {
	if (typeof value === 'number') return new Date(value);
	if (typeof value === 'string') return new Date(value);
	return fallback;
}

export class TimescaleDbPublishPlugin extends EventEmitter implements IPublishPlugin {
	private running = false;
	private pool: Pool | null = null;
	private lastSuccessTime = 0;
	private readonly config: TimescaleDbConfig;
	private readonly logger?: Logger;
	private readonly deviceUuid: string;

	constructor(config: TimescaleDbConfig, logger: Logger | undefined, deviceUuid: string) {
		super();
		this.config = config;
		this.logger = logger;
		this.deviceUuid = deviceUuid;
	}

	static fromConfig(raw: Record<string, unknown> | null, logger?: Logger, deviceUuid?: string): TimescaleDbPublishPlugin {
		const config = loadConfig(raw, logger);
		return new TimescaleDbPublishPlugin(config, logger, deviceUuid ?? 'unknown-agent');
	}

	async start(): Promise<void> {
		if (this.running) return;

		const c = this.config;
		this.pool = new Pool({
			host: c.host,
			port: c.port,
			database: c.database,
			user: c.user,
			password: c.password,
			max: c.poolSize,
			connectionTimeoutMillis: c.connectTimeoutMs,
			statement_timeout: c.statementTimeoutMs,
			application_name: c.applicationName,
			ssl: c.ssl ? { rejectUnauthorized: c.rejectUnauthorized } : false,
		});
		this.pool.on('error', (err) => {
			this.logger?.warn('TimescaleDB pool-level error (idle client)', { error: err.message });
		});
		this.pool.on('connect', (client) => {
			client.on('error', (err) => {
				this.logger?.warn('TimescaleDB client connection error', { error: err.message });
			});
		});

		this.running = true;
		this.emit('started');
		this.logger?.info(`TimescaleDB plugin started — ${c.host}:${c.port}/${c.database}`);
	}

	async stop(): Promise<void> {
		if (!this.running || !this.pool) return;
		try {
			await this.pool.end();
		} catch (err) {
			this.logger?.error('TimescaleDB pool close error on stop', err as Error);
		} finally {
			this.pool = null;
			this.running = false;
			this.emit('stopped');
		}
	}

	isRunning(): boolean {
		return this.running;
	}

	isConnected(): boolean {
		const staleAfterMs = 60000;
		return this.running && (this.lastSuccessTime === 0 || Date.now() - this.lastSuccessTime < staleAfterMs);
	}

	async publishBatch(batch: PublishBatchItem[]): Promise<void> {
		if (!this.running || !this.pool) throw new Error('TimescaleDB plugin not started');

		const rows: ReadingRow[] = [];
		for (const item of batch) {
			try {
				const text = Buffer.isBuffer(item.payload) ? item.payload.toString('utf-8') : item.payload;
				const raw = JSON.parse(text);
				const built = isTagsPayload(raw)
					? this.buildRowsFromTagsPayload(raw, item.topic)
					: this.buildRowsFromCustomPayload(raw as CustomPayload, item.topic);
				rows.push(...built);
			} catch (err) {
				this.logger?.error(`TimescaleDB: failed to process batch item on topic '${item.topic}'`, err as Error);
			}
		}
		if (rows.length === 0) return;

		// Throws on failure by design — PublishManager's SQLite durable-buffer retry only
		// engages when this promise rejects, so partial success must not be swallowed here.
		await this.insertRows(rows);
		this.lastSuccessTime = Date.now();
	}

	// Standardized (see manager.ts's mapTagPayload()): `metric_name` is now the normalized
	// point name when available, falling back to the raw protocol identifier otherwise —
	// consistent primary identifier across MQTT/ECP/ML/TimescaleDB. The raw value is never
	// lost — always carried as extra.raw_metric_name.
	private buildExtra(msg: Record<string, unknown>, rawMetricName?: string): Record<string, unknown> {
		const pointIdentity = msg.pointIdentity as PointIdentity | undefined;
		const rawObjectName = typeof msg.rawObjectName === 'string' ? msg.rawObjectName : undefined;

		return {
			endpoint_uuid: pickUuid(msg.endpoint_uuid) ?? pickUuid(msg.endpointUuid) ?? null,
			device_uuid: resolveDeviceUuid(msg),
			device_name: typeof msg.deviceName === 'string' ? msg.deviceName
				: (typeof msg.device_name === 'string' ? msg.device_name : null),
			ingested_at: new Date().toISOString(),
			...(rawMetricName && { raw_metric_name: rawMetricName }),
			...(pointIdentity?.provisionalPointId && { provisional_point_id: pointIdentity.provisionalPointId }),
			...(pointIdentity?.rulesVersion && { rules_version: pointIdentity.rulesVersion }),
			// The true, unsanitized protocol-reported name (currently BACnet/OPC-UA), distinct
			// from raw_metric_name (the adapter-sanitized identifier metric_name used to be).
			...(rawObjectName && { raw_object_name: rawObjectName }),
		};
	}

	// Some protocol adapters batch multiple readings under one wrapper object as
	// { readings: [...], timestamp } rather than emitting one flat reading per array
	// element (mirrors PublishManager.collectTagRecords(), which does the same
	// flattening for the tags/ecp/ml payload formats — the 'custom' format never
	// gets that treatment upstream, so it has to happen here).
	private flattenMessages(messages: Array<Record<string, unknown>>): Array<{ reading: Record<string, unknown>; wrapperTimestamp?: unknown }> {
		const out: Array<{ reading: Record<string, unknown>; wrapperTimestamp?: unknown }> = [];
		for (const message of messages) {
			if (Array.isArray(message.readings)) {
				for (const reading of message.readings as Record<string, unknown>[]) {
					out.push({ reading, wrapperTimestamp: message.timestamp });
				}
				continue;
			}
			out.push({ reading: message, wrapperTimestamp: undefined });
		}
		return out;
	}

	private buildRowsFromCustomPayload(payload: CustomPayload, topic: string): ReadingRow[] {
		const messages = Array.isArray(payload.messages) ? payload.messages : [];
		const batchTime = resolveTimestamp(payload.timestamp, new Date());
		const protocol = detectProtocolFromTopic(topic, payload.protocol);

		const rows: ReadingRow[] = [];
		for (const { reading: msg, wrapperTimestamp } of this.flattenMessages(messages)) {
			if (msg.nodeType === 'metadata') continue; // mirrors cloud ingestion: metadata nodes aren't stored

			const rawName = String(msg.metric ?? msg.metric_name ?? msg.nodeName ?? msg.name ?? msg.tag ?? msg.id ?? 'value');
			const pointIdentity = msg.pointIdentity as PointIdentity | undefined;
			const name = pointIdentity?.normalizedName ?? rawName;
			const rawValue = msg.value ?? msg.rawValue ?? msg.v;
			const fallbackTime = resolveTimestamp(wrapperTimestamp, batchTime);

			rows.push({
				time: resolveTimestamp(msg.timestamp, fallbackTime),
				agent_uuid: this.deviceUuid,
				metric_name: name,
				value: coerceValue(rawValue),
				quality: normalizeQuality(msg.quality),
				unit: typeof msg.unit === 'string' ? msg.unit : null,
				protocol,
				extra: this.buildExtra(msg, rawName),
			});
		}
		return rows;
	}

	private buildRowsFromTagsPayload(payload: TagsPayload, topic: string): ReadingRow[] {
		const time = resolveTimestamp(payload.timestamp, new Date());
		const protocol = detectProtocolFromTopic(topic);

		const rows: ReadingRow[] = [];
		for (const tag of payload.tags ?? []) {
			if (tag.error !== undefined) continue; // mirrors InfluxDB plugin: skip error tags entirely

			const value = coerceValue(tag.value);
			if (value === null) continue; // nothing numeric to store and no error to record

			rows.push({
				time,
				agent_uuid: this.deviceUuid,
				metric_name: String(tag.name), // already normalized-preferred, see manager.ts's mapTagPayload()
				value,
				quality: 'good',
				unit: null,
				protocol,
				extra: {
					device_name: payload.node ?? null,
					group: payload.group ?? null,
					ingested_at: new Date().toISOString(),
					...(tag.rawName && { raw_metric_name: tag.rawName }),
					...(tag.provisionalPointId && { provisional_point_id: tag.provisionalPointId }),
				},
			});
		}
		return rows;
	}

	private async insertRows(rows: ReadingRow[]): Promise<void> {
		const sorted = [...rows].sort((a, b) => {
			const u = a.agent_uuid.localeCompare(b.agent_uuid);
			if (u !== 0) return u;
			const m = a.metric_name.localeCompare(b.metric_name);
			if (m !== 0) return m;
			return a.time.getTime() - b.time.getTime();
		});

		const chunkSize = this.config.maxRowsPerInsert ?? 200;
		for (let i = 0; i < sorted.length; i += chunkSize) {
			const chunk = sorted.slice(i, i + chunkSize);
			const values: unknown[] = [];
			const placeholders: string[] = [];
			let p = 1;
			for (const r of chunk) {
				placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
				values.push(r.time, r.agent_uuid, r.metric_name, r.value, r.quality, r.unit, r.protocol, JSON.stringify(r.extra));
			}
			await queryWithRetry(
				this.pool!,
				`INSERT INTO readings (time, agent_uuid, metric_name, value, quality, unit, protocol, extra)
				 VALUES ${placeholders.join(', ')}
				 ON CONFLICT (agent_uuid, metric_name, time) DO NOTHING`,
				values,
				this.logger,
			);
		}
	}

	getDestinationInfo() {
		return [{
			destinationName: `timescaledb:${this.config.database}@${this.config.host}`,
			destinationType: 'timescaledb',
			subscriptionIds: [],
			topics: [],
		}];
	}
}
