import { PointNameMappingsModel } from '../db/models/index.js';
import type { PointNameMappingRecord } from '../db/models/index.js';
import { computeProvisionalPointId, computeShortHash, naturalKey } from './identity.js';
import { normalizePointName } from './normalize-point-name.js';
import { CURRENT_POINT_NAME_RULES_VERSION } from './types.js';
import type { Logger, PointIdentity } from './types.js';

const MAX_ROWS_PER_FLUSH = 200;
const MAX_QUEUE_SIZE = 5000;
const MAX_FLUSH_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;
const UNNAMED_POINT_PREFIX = 'unnamed_point';

interface InternalMapping {
	provisionalPointId: string;
	normalizedName: string;
	rawName: string;
	endpointName: string;
	deviceKey: string;
	sourceSystem: string | null;
	locked: boolean;
	method: 'algorithmic' | 'unresolved';
	sourceFields: string[];
	collisionSuffix?: string;
	rulesVersion: string;
	persistenceState: 'pending' | 'persisted' | 'failed';
	resolutionSource: 'runtime-generated' | 'persisted-cache';
}

export interface CatalogMetrics {
	algorithmicCount: number;
	unresolvedCount: number;
	collisionCount: number;
	queueDepth: number;
	flushDurationMs: number;
	flushSuccessCount: number;
	flushFailureCount: number;
	retryCount: number;
	overflowCount: number;
}

function baseKey(endpointName: string, deviceKey: string, base: string): string {
	return `${endpointName}\0${deviceKey}\0${base}`;
}

/**
 * In-memory point-identity index + deferred, batched, SYNCHRONOUS persistence
 * queue (plan §8). node:sqlite's DatabaseSync is a synchronous API — there is
 * no true non-blocking write on this driver. The design goal here is narrower
 * than "async": keep the (still-blocking-when-it-runs) DB write off the
 * telemetry hot path and small, via startup preload + a deferred/batched
 * flush, never a synchronous call from resolve()/the interceptor's own stack.
 */
class PointNameCatalog {
	private byNaturalKey = new Map<string, InternalMapping>();
	private baseOwner = new Map<string, string>(); // baseKey -> owning rawName (the mapping holding the bare, unsuffixed name)
	private pendingQueue = new Map<string, InternalMapping>();
	private flushing = false;
	private consecutiveFailureCount = 0;
	private nextRetryAtMs = 0;
	private loaded = false;
	private logger?: Logger;

	private metrics: CatalogMetrics = {
		algorithmicCount: 0,
		unresolvedCount: 0,
		collisionCount: 0,
		queueDepth: 0,
		flushDurationMs: 0,
		flushSuccessCount: 0,
		flushFailureCount: 0,
		retryCount: 0,
		overflowCount: 0,
	};

	init(logger?: Logger): void {
		this.logger = logger;
		this.reload();
	}

	/** One synchronous DB read at agent-init time (never per-batch) — mirrors getUnitCatalog().init()'s lifecycle. */
	reload(): void {
		this.byNaturalKey.clear();
		this.baseOwner.clear();

		for (const row of PointNameMappingsModel.getAll()) {
			const mapping: InternalMapping = {
				provisionalPointId: row.provisional_point_id,
				normalizedName: row.normalized_name,
				rawName: row.raw_name,
				endpointName: row.endpoint_name,
				deviceKey: row.device_key,
				sourceSystem: row.source_system ?? null,
				locked: row.locked,
				method: row.method === 'unresolved' ? 'unresolved' : 'algorithmic',
				sourceFields: row.source_fields,
				collisionSuffix: row.collision_suffix ?? undefined,
				rulesVersion: row.rules_version,
				// Restoring from disk never rewrites `method` — only resolutionSource/persistenceState change (plan §4).
				persistenceState: 'persisted',
				resolutionSource: 'persisted-cache',
			};

			const key = naturalKey(mapping.sourceSystem, mapping.endpointName, mapping.deviceKey, mapping.rawName);
			this.byNaturalKey.set(key, mapping);

			if (!mapping.collisionSuffix) {
				const bKey = baseKey(mapping.endpointName, mapping.deviceKey, mapping.normalizedName);
				if (!this.baseOwner.has(bKey)) this.baseOwner.set(bKey, mapping.rawName);
			}
		}

		this.loaded = true;
	}

	private ensureLoaded(): void {
		if (!this.loaded) this.reload();
	}

	getMetrics(): CatalogMetrics {
		return { ...this.metrics, queueDepth: this.pendingQueue.size };
	}

	/**
	 * Resolve (or compute) the PointIdentity for a reading. Pure/synchronous/
	 * zero-I/O once init() has run — generating provisionalPointId never
	 * touches the database, unconditionally (plan §3).
	 */
	resolve(params: {
		sourceSystem?: string | null;
		endpointName: string;
		deviceKey: string;
		rawName: string;
		rawDeviceName?: string;
		sourceAddress?: string;
	}): PointIdentity {
		this.ensureLoaded();
		const sourceSystem = params.sourceSystem ?? null;
		const { endpointName, deviceKey, rawName, rawDeviceName, sourceAddress } = params;
		const key = naturalKey(sourceSystem, endpointName, deviceKey, rawName);

		const existing = this.byNaturalKey.get(key);
		const mapping = existing ?? this.computeNew(sourceSystem, endpointName, deviceKey, rawName);

		if (!existing) {
			this.byNaturalKey.set(key, mapping);
			this.enqueueForPersistence(mapping);
		}

		return this.toPointIdentity(mapping, rawDeviceName, sourceAddress);
	}

	private computeNew(sourceSystem: string | null, endpointName: string, deviceKey: string, rawName: string): InternalMapping {
		const base = normalizePointName(rawName);
		const method: 'algorithmic' | 'unresolved' = base.length > 0 ? 'algorithmic' : 'unresolved';

		if (method === 'algorithmic') this.metrics.algorithmicCount++;
		else this.metrics.unresolvedCount++;

		// Unresolved names get a deterministic, self-unique sentinel — no bare
		// "unnamed_point" literal, and no separate collision pass needed for
		// this path, since distinct raw names hash to distinct sentinels (plan §13).
		const effectiveBase = method === 'algorithmic'
			? base
			: `${UNNAMED_POINT_PREFIX}_${computeShortHash(sourceSystem, endpointName, deviceKey, rawName)}`;

		const bKey = baseKey(endpointName, deviceKey, effectiveBase);
		const owner = this.baseOwner.get(bKey);

		let normalizedName = effectiveBase;
		let collisionSuffix: string | undefined;

		if (owner !== undefined && owner !== rawName) {
			// A different raw name already owns this base — deterministic hash
			// suffix (plan §7), never an arrival-order counter.
			collisionSuffix = computeShortHash(sourceSystem, endpointName, deviceKey, rawName);
			normalizedName = `${effectiveBase}_${collisionSuffix}`;
			this.metrics.collisionCount++;
		} else if (owner === undefined) {
			this.baseOwner.set(bKey, rawName);
		}

		return {
			provisionalPointId: computeProvisionalPointId(sourceSystem, endpointName, deviceKey, rawName),
			normalizedName,
			rawName,
			endpointName,
			deviceKey,
			sourceSystem,
			locked: true,
			method,
			sourceFields: ['metric'],
			collisionSuffix,
			rulesVersion: CURRENT_POINT_NAME_RULES_VERSION,
			persistenceState: 'pending',
			resolutionSource: 'runtime-generated',
		};
	}

	private toPointIdentity(mapping: InternalMapping, rawDeviceName?: string, sourceAddress?: string): PointIdentity {
		return {
			provisionalPointId: mapping.provisionalPointId,
			normalizedName: mapping.normalizedName,
			rawName: mapping.rawName,
			...(rawDeviceName && { rawDeviceName }),
			...(sourceAddress && { sourceAddress }),
			rulesVersion: mapping.rulesVersion,
			provenance: {
				method: mapping.method,
				resolutionSource: mapping.resolutionSource,
				persistenceState: mapping.persistenceState,
				sourceFields: mapping.sourceFields,
				sourceSystem: mapping.sourceSystem,
				...(mapping.collisionSuffix && { collisionSuffix: mapping.collisionSuffix }),
			},
		};
	}

	// ---- Deferred, batched, synchronous persistence (plan §8) ----

	private enqueueForPersistence(mapping: InternalMapping): void {
		const key = naturalKey(mapping.sourceSystem, mapping.endpointName, mapping.deviceKey, mapping.rawName);

		if (!this.pendingQueue.has(key) && this.pendingQueue.size >= MAX_QUEUE_SIZE) {
			const oldestKey = this.pendingQueue.keys().next().value;
			if (oldestKey !== undefined) {
				this.pendingQueue.delete(oldestKey);
				this.metrics.overflowCount++;
				this.logger?.warn('Point-name persistence queue overflow — evicted oldest pending mapping', { oldestKey });
			}
		}

		// Natural-key dedup: replacing an existing pending entry (rather than
		// growing the queue) means a hot point re-observed before a flush still
		// produces exactly one queue entry.
		this.pendingQueue.delete(key);
		this.pendingQueue.set(key, mapping);
	}

	/**
	 * Called by an external timer (see interceptor.ts) — never called from the
	 * interceptor's own per-batch call stack. Still a blocking SQLite call when
	 * it runs (node:sqlite is synchronous); the guardrails below bound how
	 * often/how much that blocking window can cost:
	 *  - no overlapping flushes (this.flushing guard)
	 *  - max MAX_ROWS_PER_FLUSH rows per transaction
	 *  - bounded retry/backoff (MAX_FLUSH_RETRIES, exponential), then rows are
	 *    marked persistenceState:'failed' and dropped — never retried indefinitely
	 *  - a flush failure never changes the PointIdentity already attached to a reading
	 */
	flush(): void {
		if (this.flushing) return;
		if (this.pendingQueue.size === 0) return;
		if (Date.now() < this.nextRetryAtMs) return;

		this.flushing = true;
		const batchEntries = [...this.pendingQueue.entries()].slice(0, MAX_ROWS_PER_FLUSH);
		const startedAt = Date.now();

		try {
			const records: PointNameMappingRecord[] = batchEntries.map(([, mapping]) => ({
				source_system: mapping.sourceSystem,
				endpoint_name: mapping.endpointName,
				device_key: mapping.deviceKey,
				raw_name: mapping.rawName,
				provisional_point_id: mapping.provisionalPointId,
				normalized_name: mapping.normalizedName,
				locked: mapping.locked,
				method: mapping.method,
				source_fields: mapping.sourceFields,
				collision_suffix: mapping.collisionSuffix ?? null,
				rules_version: mapping.rulesVersion,
			}));

			PointNameMappingsModel.upsertMany(records);

			for (const [key, mapping] of batchEntries) {
				mapping.persistenceState = 'persisted';
				this.pendingQueue.delete(key);
			}
			this.consecutiveFailureCount = 0;
			this.nextRetryAtMs = 0;
			this.metrics.flushSuccessCount++;
		} catch (err) {
			this.consecutiveFailureCount++;
			this.metrics.retryCount++;
			this.logger?.warn('Point-name mapping flush failed', { attempt: this.consecutiveFailureCount, err });

			if (this.consecutiveFailureCount >= MAX_FLUSH_RETRIES) {
				for (const [key, mapping] of batchEntries) {
					mapping.persistenceState = 'failed';
					this.pendingQueue.delete(key);
				}
				this.metrics.flushFailureCount++;
				this.consecutiveFailureCount = 0;
				this.nextRetryAtMs = 0;
			} else {
				// batchEntries stay in pendingQueue (never removed on this path) —
				// the next flush() call after the backoff window retries them.
				this.nextRetryAtMs = Date.now() + BASE_BACKOFF_MS * 2 ** (this.consecutiveFailureCount - 1);
			}
		} finally {
			this.metrics.flushDurationMs = Date.now() - startedAt;
			this.flushing = false;
		}
	}

	/** Best-effort final flush on shutdown — bounded (same MAX_ROWS_PER_FLUSH cap), never hangs waiting for a backoff window. */
	shutdownFlush(): void {
		if (this.flushing) return;
		this.nextRetryAtMs = 0;
		this.flush();
	}
}

let singleton: PointNameCatalog | undefined;

export function getPointNameCatalog(): PointNameCatalog {
	if (!singleton) singleton = new PointNameCatalog();
	return singleton;
}

/** Test-only — forces a fresh instance so queue/retry/in-memory state doesn't leak between test cases. */
export function resetPointNameCatalogForTests(): void {
	singleton = undefined;
}

export type { PointNameCatalog };
