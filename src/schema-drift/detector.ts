import type {
	DriftType,
	Logger,
	PersistedBaselineState,
	PersistedDeviceDriftState,
	SchemaDriftEvent,
	SchemaDriftStore,
} from './types.js';
export interface DriftRule {
	enabled: boolean;
	priority: number;
	fieldPattern?: string;
	devicePattern?: string;
	endpointPattern?: string;
	suppressDriftTypes?: DriftType[];
	alertOnDriftTypes?: DriftType[];
	severityOverrides?: Partial<Record<DriftType, DriftSeverity>>;
	consecutiveMissingThreshold?: number;
	alertCooldownMs?: number;
	pinAsBaseline?: boolean;
	allowedTypes?: string[];
	adaptivePromotionBatches?: number;
	adaptivePromotionMinElapsedMs?: number;
	adaptiveRetireBatches?: number;
}

const _globCache = new Map<string, RegExp>();
function matchGlob(pattern: string, value: string): boolean {
	let re = _globCache.get(pattern);
	if (!re) {
		const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		const globbed = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
		re = new RegExp(`^${globbed}$`, 'i');
		if (_globCache.size > 500) _globCache.clear();
		_globCache.set(pattern, re);
	}
	return re.test(value);
}

function resolveRules(rules: DriftRule[], fieldName: string, deviceId: string, endpointName: string): DriftRule[] {
	const matched: DriftRule[] = [];
	for (const rule of rules) {
		if (!rule.enabled) continue;
		if (rule.fieldPattern && !matchGlob(rule.fieldPattern, fieldName)) continue;
		if (rule.devicePattern && !matchGlob(rule.devicePattern, deviceId)) continue;
		if (rule.endpointPattern && !matchGlob(rule.endpointPattern, endpointName)) continue;
		matched.push(rule);
	}
	matched.sort((a, b) => b.priority - a.priority);
	return matched;
}

type ValueType = "number" | "string" | "boolean" | "object" | "array" | "null";
type DriftSeverity = "warning" | "critical";

/**
 * Per-field type observation counts used to determine dominant expected types.
 * Tracks counts per ValueType plus a total, preventing unlimited type widening:
 * a type is "expected" only when its ratio to total exceeds minTypeDominanceRatio.
 */
type TypeFrequency = {
	counts: Map<ValueType, number>;
	total: number;
};

type DriftDetectorOptions = {
	enabled: boolean;
	warmupBatches: number;
	minFieldPresenceRatio: number;
	consecutiveMissingThreshold: number;
	alertCooldownMs: number;
	adaptivePromotionBatches: number;
	/**
	 * Minimum ratio of batches-present vs batches-since-first-seen before
	 * promotion. DEPRECATED — no longer consulted by the promotion check
	 * (see adaptivePromotionMinElapsedMs). Kept in the type/defaults so
	 * already-saved configs that set it don't fail validation; the admin UI
	 * no longer exposes a control for it.
	 *
	 * Why: this ratio divides by `totalBatches`, which increments once per
	 * observation *for the whole device*, not per occurrence of this one
	 * field — on a subscription-pushed source (e.g. OPC-UA, where every
	 * unrelated node's value change is its own observation) totalBatches can
	 * run into the thousands within seconds, while a field that only
	 * reports on real change (a setpoint, a COV-only point) might
	 * legitimately appear every few minutes. The ratio craters, the field
	 * never promotes, and it re-logs as "new-field" forever — confirmed
	 * 2026-10-06: an OPC-UA VAV's zone_setpoint logged ~19k times in 90s of
	 * otherwise-idle steady state. See adaptivePromotionMinElapsedMs.
	 */
	adaptivePromotionRatio: number;
	/**
	 * Minimum wall-clock time a new-field candidate must have been tracked
	 * before it can promote into the baseline, alongside
	 * adaptivePromotionBatches (minimum occurrence count) — both must hold.
	 * Replaces adaptivePromotionRatio: time-since-first-seen is independent
	 * of how many unrelated batches an endpoint happens to emit in between,
	 * so an infrequently-but-reliably-reporting field (a setpoint, a
	 * COV-only point) can still promote, while a field that appeared once in
	 * a burst and vanished still can't (it won't yet have accumulated real
	 * elapsed time).
	 */
	adaptivePromotionMinElapsedMs: number;
	adaptiveRetireBatches: number;
	/**
	 * Wall-clock equivalent of adaptiveRetireBatches, used only for evicting
	 * stale *new-field candidates* (not yet in the baseline) — see
	 * evictStaleNewFieldCandidates(). Batch-count eviction has the same
	 * subscription-source mismatch as adaptivePromotionRatio: on a bursty
	 * source, adaptiveRetireBatches can elapse in seconds, evicting (and
	 * thus resetting the promotion progress of) a candidate that's actually
	 * reporting fine every few minutes — it would be perpetually evicted
	 * between appearances and never accumulate enough occurrences to
	 * promote. Baseline-field missing-streak retirement still uses
	 * adaptiveRetireBatches unchanged (a different, narrower mechanism not
	 * affected by this issue).
	 */
	adaptiveRetireMs: number;
	maxTrackedFields: number;
	/** Maximum distinct devices tracked per endpoint (bounds memory on a shared/multiplexed endpoint). */
	maxTrackedDevices: number;
	maxTraversalDepth: number;
	maxFieldsPerBatch: number;
	/** Maximum candidates per side when searching for rename pairs. */
	maxRenameCandidates: number;
	/** Skip Levenshtein for field names longer than this. */
	maxRenameFieldLength: number;
	/**
	 * A ValueType must appear in at least this fraction of observations to be
	 * considered "expected". Prevents one bad payload from permanently widening
	 * the accepted type set.
	 */
	minTypeDominanceRatio: number;
	/** Maximum array length used in log fields to prevent oversized log payloads. */
	logSampleSize: number;
	/**
	 * Run the full schema check only every Nth batch after the baseline is established.
	 * 1 = every batch (default). Higher values reduce CPU at high-frequency endpoints.
	 * The warmup phase always processes every batch regardless of this setting.
	 */
	checkIntervalBatches: number;
	/**
	 * Which drift types raise an alert through the caller's incident/alert
	 * pipeline (driftAlertHandler), in addition to always being logged and
	 * persisted regardless of this setting. Defaults to the two severities
	 * that indicate real breakage rather than growth — new-field and
	 * rename-candidate are opt-in since a device gaining fields over time is
	 * often expected, not actionable.
	 */
	alertOnDriftTypes: DriftType[];
	/**
	 * Fraction of the baseline simultaneously missing that marks an
	 * observation as a bulk schema change (an intentional mass rename/
	 * migration) rather than N individual field-level drifts — see the
	 * bulk-change guard in detectDriftForDevice().
	 */
	bulkChangeRatio: number;
	/**
	 * Absolute floor on missing field count before the bulk-change guard can
	 * trigger, so a tiny baseline (e.g. 2-3 fields) doesn't trip the ratio
	 * check on what's actually just ordinary single-field drift.
	 */
	bulkChangeMinFields: number;
};

/**
 * A single device's field set + observed value types, extracted from one
 * observation window. An endpoint that multiplexes many devices (e.g. a
 * shared BACnet pipe polling 500 devices) produces one bucket per device
 * instead of one flat set for the whole endpoint — see resolveDeviceId().
 */
type DeviceSchema = {
	fields: Set<string>;
	typesByField: Map<string, Set<ValueType>>;
};

type ExtractedSchema = {
	byDevice: Map<string, DeviceSchema>;
};

type TypeDrift = {
	field: string;
	dominantExpectedType: ValueType;
	observedTypes: ValueType[];
};

/**
 * All per-device drift-tracking state. An endpoint that only ever sees one
 * device (Modbus, OPC-UA, a single BACnet device) has exactly one entry here,
 * keyed by DEFAULT_DEVICE_KEY, and behaves identically to the pre-refactor
 * single-baseline model. An endpoint multiplexing many devices gets one of
 * these per device, so a device's own schema is only ever compared against
 * its own history — never diffed against, or confused with, another device's
 * fields just because they happened to land in the same observation window.
 */
type DeviceDriftState = {
	totalBatches: number;
	warmupSeen: number;
	baseline: Set<string> | undefined;
	baselineTypeFreq: Map<string, TypeFrequency>;
	warmupFieldCounts: Map<string, number>;
	warmupTypeFreq: Map<string, TypeFrequency>;
	missingStreakByField: Map<string, number>;
	newFieldCounts: Map<string, number>;
	newFieldFirstSeen: Map<string, number>;
	newFieldTypeFreq: Map<string, TypeFrequency>;
	newFieldLastSeen: Map<string, number>;
	tombstones: Map<string, number>;
	lastAlertAtBySignature: Map<string, number>;
};

const DEFAULT_OPTIONS: DriftDetectorOptions = {
	enabled: true,
	warmupBatches: 20,
	minFieldPresenceRatio: 0.5,
	consecutiveMissingThreshold: 10,
	alertCooldownMs: 30 * 60 * 1000,
	adaptivePromotionBatches: 50,
	adaptivePromotionRatio: 0.6,
	adaptivePromotionMinElapsedMs: 10 * 60 * 1000,
	adaptiveRetireBatches: 250,
	adaptiveRetireMs: 24 * 60 * 60 * 1000,
	maxTrackedFields: 1000,
	maxTrackedDevices: 2000,
	maxTraversalDepth: 5,
	maxFieldsPerBatch: 500,
	maxRenameCandidates: 20,
	maxRenameFieldLength: 64,
	minTypeDominanceRatio: 0.15,
	logSampleSize: 10,
	checkIntervalBatches: 1,
	alertOnDriftTypes: ['missing-field', 'type-drift'],
	bulkChangeRatio: 0.5,
	bulkChangeMinFields: 5,
};

const RESERVED_GENERIC_KEYS = new Set<string>([
	"timestamp",
	"ts",
	"time",
	"devicename",
	"deviceid",
	"device_id",
	"device_uuid",
	"deviceuuid",
	"quality",
	"unit",
	"status",
	"state",
	"msgid",
	"device",
	"protocol",
]);

/**
 * Bucket for messages with no resolvable device identity — single-device
 * endpoints (Modbus, OPC-UA, a lone BACnet device) will only ever populate
 * this bucket, so they behave exactly as the old flat-baseline model did.
 */
const DEFAULT_DEVICE_KEY = "__default__";

function toFieldName(input: unknown): string | undefined {
	if (typeof input !== "string") {
		return undefined;
	}

	const trimmed = input.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeFieldName(value: string): string {
	return value
		.trim()
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[\s-]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/[^a-zA-Z0-9_.:]/g, "")
		.toLowerCase();
}

// collapseRedundantSuffix now lives in ../device-identity (shared with the
// anomaly subsystem's device-id handling and re-exported here so existing
// imports of it from this module keep working) — defense in depth against a
// self-referential trailing suffix, e.g. "ahu_1_ahu1" -> "ahu_1". See that
// module for the full rationale.
export { collapseRedundantSuffix, normalizeDeviceId } from "../device-identity/index.js";
import { normalizeDeviceId } from "../device-identity/index.js";

/**
 * Resolves which device a message belongs to, mirroring the same field
 * preference order PublishManager.readExternalNodeCandidate() uses to name
 * the source in Recent Activity/Data Flow — so "the device a reading came
 * from" means the same thing everywhere in the pipeline. Returns undefined
 * for messages with no device identity of their own (single-device
 * endpoints, or a malformed/partial reading), which fall back to
 * DEFAULT_DEVICE_KEY.
 */
export function resolveDeviceId(record: Record<string, unknown>): string | undefined {
	const value = record.deviceName
		?? record.device_name
		?? record.resolvedDisplayName
		?? record.resolved_display_name
		?? record.sourceDeviceName
		?? record.source_device_name
		?? null;

	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? normalizeDeviceId(trimmed) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}

	return value as Record<string, unknown>;
}

function valueTypeOf(value: unknown): ValueType {
	if (value === null) {
		return "null";
	}

	if (Array.isArray(value)) {
		return "array";
	}

	if (typeof value === "number") {
		return "number";
	}

	if (typeof value === "string") {
		return "string";
	}

	if (typeof value === "boolean") {
		return "boolean";
	}

	return "object";
}

function isTelemetryPrimitive(value: unknown): boolean {
	return typeof value === "number" || typeof value === "boolean";
}

/**
 * Returns the Levenshtein edit distance between a and b, or undefined when the
 * length difference alone exceeds a reasonable rename threshold (fast path).
 * Uses a flat Int16Array instead of nested arrays to reduce GC pressure.
 */
function levenshteinDistance(
	a: string,
	b: string,
	maxFieldLength: number,
): number | undefined {
	if (Math.abs(a.length - b.length) > Math.ceil(maxFieldLength * 0.5)) {
		return undefined;
	}

	if (a === b) {
		return 0;
	}

	if (a.length === 0) {
		return b.length;
	}

	if (b.length === 0) {
		return a.length;
	}

	const rows = a.length + 1;
	const cols = b.length + 1;
	const dp = new Int16Array(rows * cols);

	for (let i = 0; i < rows; i++) {
		dp[i * cols] = i;
	}

	for (let j = 0; j < cols; j++) {
		dp[j] = j;
	}

	for (let i = 1; i < rows; i++) {
		for (let j = 1; j < cols; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			dp[i * cols + j] = Math.min(
				dp[(i - 1) * cols + j] + 1,
				dp[i * cols + (j - 1)] + 1,
				dp[(i - 1) * cols + (j - 1)] + cost,
			);
		}
	}

	return dp[(rows - 1) * cols + (cols - 1)];
}

function stringSimilarity(
	a: string,
	b: string,
	maxFieldLength: number,
): number | undefined {
	const maxLen = Math.max(a.length, b.length);
	if (maxLen === 0) {
		return 1;
	}

	const dist = levenshteinDistance(a, b, maxFieldLength);
	if (dist === undefined) {
		return undefined;
	}

	return 1 - dist / maxLen;
}

function sampleArray<T>(arr: T[], maxSize: number): T[] {
	return arr.length <= maxSize ? arr : arr.slice(0, maxSize);
}

/**
 * Emitted for whichever drift types are in options.alertOnDriftTypes (default:
 * missing-field and type-drift only — a device slowly growing new fields as it
 * warms up isn't actionable the way a field vanishing or changing shape is,
 * but that default is user-configurable, not fixed). Deliberately
 * protocol/anomaly-agnostic: the caller (PublishManager) maps this into
 * whatever alert-pipeline shape it needs, so this file doesn't need to know
 * about incidents, fingerprints, or the anomaly system at all.
 */
export interface DriftAlertEvent {
	endpointName: string;
	/** Undefined for single-device endpoints (the default bucket has no device label). */
	device?: string;
	driftType: DriftType;
	severity: DriftSeverity;
	/** Present for new-field/missing-field/type-drift; absent for rename-candidate. */
	fieldName?: string;
	expectedType?: string;
	observedTypes?: string[];
	renameCandidateFrom?: string;
	renameCandidateTo?: string;
	renameSimilarity?: number;
}

export class SchemaDriftDetector {
	private readonly options: DriftDetectorOptions;
	private readonly endpointName: string;
	private readonly logger?: Logger;
	private readonly store: SchemaDriftStore;

	/** How many observation windows this detector has processed, across all devices — for logging only. */
	private totalWindows = 0;
	private readonly deviceStates = new Map<string, DeviceDriftState>();
	private driftAlertHandler?: (event: DriftAlertEvent) => void;
	private rules: DriftRule[] = [];

	constructor(
		endpointName: string,
		logger: Logger | undefined,
		options: Partial<DriftDetectorOptions> | undefined,
		store: SchemaDriftStore,
	) {
		this.endpointName = endpointName;
		this.logger = logger;
		this.options = { ...DEFAULT_OPTIONS, ...(options || {}) };
		this.store = store;
		this.restorePersistedBaseline();
	}

	setRules(rules: DriftRule[]): void {
		this.rules = rules;
	}

	private resolveFieldRules(fieldName: string, deviceId: string): DriftRule[] {
		return resolveRules(this.rules, fieldName, deviceId, this.endpointName);
	}

	private createDeviceState(): DeviceDriftState {
		return {
			totalBatches: 0,
			warmupSeen: 0,
			baseline: undefined,
			baselineTypeFreq: new Map(),
			warmupFieldCounts: new Map(),
			warmupTypeFreq: new Map(),
			missingStreakByField: new Map(),
			newFieldCounts: new Map(),
			newFieldFirstSeen: new Map(),
			newFieldTypeFreq: new Map(),
			newFieldLastSeen: new Map(),
			tombstones: new Map(),
			lastAlertAtBySignature: new Map(),
		};
	}

	private restorePersistedBaseline(): void {
		const persisted = this.store.loadBaseline(this.endpointName);
		if (!persisted) {
			return;
		}

		// Pre-refactor rows persisted one flat baseline per endpoint (no `devices`
		// map) — fold that straight into DEFAULT_DEVICE_KEY so single-device
		// endpoints (where the flat model was already correct) keep their learned
		// baseline across the upgrade instead of relearning from scratch. For a
		// multiplexed endpoint the old flat baseline mixed multiple devices'
		// fields together and was already wrong, so it just becomes a vestigial
		// default-bucket entry that stops being touched once real per-device
		// buckets take over.
		const legacy = persisted as unknown as PersistedBaselineState & {
			baselineFields?: string[];
			baselineTypeFreq?: Record<string, { counts: Record<string, number>; total: number }>;
			missingStreakByField?: Record<string, number>;
			totalBatches?: number;
			warmupSeen?: number;
			tombstones?: Record<string, number>;
			newFieldCounts?: Record<string, number>;
			newFieldFirstSeen?: Record<string, number>;
			newFieldTypeFreq?: Record<string, { counts: Record<string, number>; total: number }>;
			newFieldLastSeen?: Record<string, number>;
		};

		const deviceEntries: Record<string, PersistedDeviceDriftState> = persisted.devices
			?? (legacy.baselineFields ? {
				[DEFAULT_DEVICE_KEY]: {
					baselineFields: legacy.baselineFields,
					baselineTypeFreq: legacy.baselineTypeFreq ?? {},
					missingStreakByField: legacy.missingStreakByField ?? {},
					totalBatches: legacy.totalBatches ?? 0,
					warmupSeen: legacy.warmupSeen ?? 0,
					tombstones: legacy.tombstones,
					newFieldCounts: legacy.newFieldCounts,
					newFieldFirstSeen: legacy.newFieldFirstSeen,
					newFieldTypeFreq: legacy.newFieldTypeFreq,
					newFieldLastSeen: legacy.newFieldLastSeen,
				},
			} : {});

		for (const [deviceId, ds] of Object.entries(deviceEntries)) {
			const state = this.createDeviceState();
			state.baseline = new Set(ds.baselineFields);
			state.totalBatches = ds.totalBatches;
			state.warmupSeen = ds.warmupSeen;

			for (const [field, freq] of Object.entries(ds.baselineTypeFreq)) {
				state.baselineTypeFreq.set(field, {
					counts: this.toValueTypeCountMap(freq.counts),
					total: freq.total,
				});
			}

			for (const [field, streak] of Object.entries(ds.missingStreakByField)) {
				state.missingStreakByField.set(field, streak);
			}

			for (const [field, batch] of Object.entries(ds.tombstones ?? {})) {
				state.tombstones.set(field, batch);
			}

			for (const [field, count] of Object.entries(ds.newFieldCounts ?? {})) {
				state.newFieldCounts.set(field, count);
			}

			for (const [field, firstSeen] of Object.entries(ds.newFieldFirstSeen ?? {})) {
				state.newFieldFirstSeen.set(field, firstSeen);
			}

			for (const [field, freq] of Object.entries(ds.newFieldTypeFreq ?? {})) {
				state.newFieldTypeFreq.set(field, {
					counts: this.toValueTypeCountMap(freq.counts),
					total: freq.total,
				});
			}

			// Older persisted state predates newFieldLastSeen — fall back to firstSeen
			// (usually long ago for genuinely-stale candidates), so they become
			// immediately eligible for the eviction sweep instead of being treated as
			// freshly observed just because this field didn't exist in older saves.
			const lastSeenPersisted = ds.newFieldLastSeen ?? {};
			for (const field of state.newFieldCounts.keys()) {
				state.newFieldLastSeen.set(field, lastSeenPersisted[field] ?? state.newFieldFirstSeen.get(field) ?? 0);
			}

			this.deviceStates.set(deviceId, state);
		}
	}

	private persistBaselineState(): void {
		const devices: Record<string, PersistedDeviceDriftState> = {};

		for (const [deviceId, state] of this.deviceStates) {
			if (!state.baseline) {
				continue;
			}

			devices[deviceId] = {
				baselineFields: Array.from(state.baseline),
				baselineTypeFreq: this.serializeTypeFrequencies(state.baselineTypeFreq),
				missingStreakByField: Object.fromEntries(state.missingStreakByField),
				totalBatches: state.totalBatches,
				warmupSeen: state.warmupSeen,
				tombstones: Object.fromEntries(state.tombstones),
				newFieldCounts: Object.fromEntries(state.newFieldCounts),
				newFieldFirstSeen: Object.fromEntries(state.newFieldFirstSeen),
				newFieldTypeFreq: this.serializeTypeFrequencies(state.newFieldTypeFreq),
				newFieldLastSeen: Object.fromEntries(state.newFieldLastSeen),
			};
		}

		if (Object.keys(devices).length === 0) {
			return;
		}

		const state: PersistedBaselineState = {
			endpointName: this.endpointName,
			devices,
		};

		try {
			this.store.saveBaseline(state);
		} catch (error) {
			this.logger?.error(
				`Failed to persist schema baseline for endpoint '${this.endpointName}'`,
				{ endpointName: this.endpointName, error },
			);
		}
	}

	private persistDriftEvent(event: SchemaDriftEvent): void {
		try {
			this.store.saveDrift(event);
		} catch (error) {
			this.logger?.error(
				`Failed to persist schema drift event for endpoint '${this.endpointName}'`,
				{ endpointName: this.endpointName, error },
			);
		}
	}

	private serializeTypeFrequencies(
		freqMap: Map<string, TypeFrequency>,
	): PersistedDeviceDriftState['baselineTypeFreq'] {
		const result: PersistedDeviceDriftState['baselineTypeFreq'] = {};
		for (const [field, freq] of freqMap.entries()) {
			result[field] = {
				counts: Object.fromEntries(freq.counts),
				total: freq.total,
			};
		}

		return result;
	}

	/** Wire (or clear, by passing undefined) the callback invoked for critical drift only. */
	setDriftAlertHandler(handler?: (event: DriftAlertEvent) => void): void {
		this.driftAlertHandler = handler;
	}

	/**
	 * Drops all in-memory per-device drift state (baseline, warmup progress,
	 * pending new-field tracking, tombstones — everything). Used by the admin
	 * UI's Schema Drift "Reset" action alongside deleting the persisted row
	 * (see SchemaDriftModel.clearAllBaselines()) — deleting only the DB row
	 * without this would be pointless, since this detector would just
	 * re-persist its still-populated in-memory state on the next observe()
	 * call, undoing the deletion. Every device starts over from warmup.
	 */
	clearBaselines(): void {
		const clearedDevices = this.deviceStates.size;
		this.deviceStates.clear();
		this.logger?.info(`Cleared all in-memory schema-drift state for ${this.endpointName}`, {
			endpointName: this.endpointName,
			clearedDevices,
		});
	}

	/**
	 * Seeds (or extends) a device's baseline directly from its configured
	 * field list — e.g. an OPC-UA device's dataPoints — instead of requiring
	 * enough observed presence to promote through warmup/adaptive promotion.
	 *
	 * This exists because presence-based promotion assumes something reports
	 * on every cycle (true for polled protocols, false for COV/subscription
	 * ones). A field that's legitimately configured but rarely changes value
	 * — an intermittent fault valve, a manual alarm bit nobody has toggled
	 * since the last restart — can accumulate little or no observed presence
	 * indefinitely under COV, even though it's a perfectly real, known field.
	 * The device's own config is ground truth for "does this field exist,"
	 * independent of how often its value happens to change.
	 *
	 * Additive and idempotent: merges into whatever baseline/warmup state
	 * already exists rather than replacing it, and re-declaring the same
	 * fields (e.g. on every reconnect) is a cheap no-op after the first call.
	 * A field observed later that ISN'T in any declared list still goes
	 * through the normal presence-based promotion path — this only
	 * pre-establishes known-legitimate fields, it doesn't disable drift
	 * detection for genuinely new ones.
	 */
	declareDeviceSchema(deviceId: string, fields: string[]): void {
		// TEMPORARY diagnostic — see issue #17 follow-up investigation.
		this.logger?.debug(`[SCHEMA_DECLARE_DIAG] declareDeviceSchema called: endpoint=${this.endpointName} deviceId=${deviceId} enabled=${this.options.enabled} fieldCount=${fields.length}`);

		if (!this.options.enabled || fields.length === 0) {
			return;
		}

		const normalizedDeviceId = normalizeDeviceId(deviceId);
		// TEMPORARY diagnostic — see issue #17 follow-up investigation.
		this.logger?.debug(`[SCHEMA_DECLARE_DIAG] normalized deviceId "${deviceId}" -> "${normalizedDeviceId}", existing state=${this.deviceStates.has(normalizedDeviceId)}, trackedDevices=${this.deviceStates.size}/${this.options.maxTrackedDevices}`);
		let state = this.deviceStates.get(normalizedDeviceId);
		if (!state) {
			if (this.deviceStates.size >= this.options.maxTrackedDevices) {
				return;
			}
			state = this.createDeviceState();
			this.deviceStates.set(normalizedDeviceId, state);
		}

		if (!state.baseline) {
			state.baseline = new Set<string>();
		}

		let declaredCount = 0;
		let resetAnyMissingStreak = false;
		for (const rawField of fields) {
			const normalized = normalizeFieldName(rawField);
			if (!normalized) {
				continue;
			}
			const key = `reading:${normalized}`;

			if (!state.baseline.has(key)) {
				state.baseline.add(key);
				declaredCount++;
			}

			// This device just (re)confirmed `key` is still configured --
			// whatever missing-streak accumulated before this (re)connect
			// predates the new connection attempt and must not count against
			// it. Without this, a field mid-streak when the device dropped
			// resumes counting from where it left off on reconnect instead of
			// starting the new connection's observation window clean -- which
			// is how a field can cross consecutiveMissingThreshold within
			// seconds of reconnecting rather than needing a genuine gap in the
			// new connection.
			if (state.missingStreakByField.delete(key)) {
				resetAnyMissingStreak = true;
			}

			// Known-legitimate regardless of observed presence — clear any
			// pending/tombstone tracking so it doesn't also sit in "pending"
			// or get evicted for staleness later.
			state.newFieldCounts.delete(key);
			state.newFieldFirstSeen.delete(key);
			state.newFieldLastSeen.delete(key);
			state.newFieldTypeFreq.delete(key);
			state.tombstones.delete(key);
		}

		// TEMPORARY diagnostic — see issue #17 follow-up investigation.
		this.logger?.debug(`[SCHEMA_DECLARE_DIAG] declareDeviceSchema for "${normalizedDeviceId}": declaredCount=${declaredCount}, baselineFields=${JSON.stringify([...state.baseline])}`);

		if (declaredCount === 0 && !resetAnyMissingStreak) {
			return;
		}

		if (declaredCount > 0) {
			this.logger?.info(`Declared ${declaredCount} configured field(s) for ${this.logSubject(normalizedDeviceId)}`, {
				endpointName: this.endpointName,
				device: this.deviceLabel(normalizedDeviceId),
				declaredCount,
				totalBaselineFields: state.baseline.size,
			});
		}

		// Persisted even when declaredCount is 0 (a pure reconnect re-declare)
		// so the missing-streak reset above survives a crash shortly after --
		// otherwise restorePersistedBaseline() would reload the stale
		// pre-reconnect streak from disk and undo the fix for that case.
		this.persistBaselineState();
	}

	private toValueTypeCountMap(counts: Record<string, number>): Map<ValueType, number> {
		const result = new Map<ValueType, number>();
		for (const [type, count] of Object.entries(counts)) {
			if (
				type === 'number' ||
				type === 'string' ||
				type === 'boolean' ||
				type === 'object' ||
				type === 'array' ||
				type === 'null'
			) {
				result.set(type, count);
			}
		}

		return result;
	}

	/** Only meaningful for logging — the device label to attach, or omit for the default bucket. */
	private deviceLabel(deviceId: string): string | undefined {
		return deviceId === DEFAULT_DEVICE_KEY ? undefined : deviceId;
	}

	/**
	 * Human-readable subject for log messages. A message that only ever says
	 * "endpoint 'bacnet-pipe'" reads as fleet-wide even when the JSON context
	 * carries a `device` field — including the device directly in the message
	 * text makes the scope obvious from a skim, not just a JSON field.
	 */
	private logSubject(deviceId: string): string {
		const device = this.deviceLabel(deviceId);
		return  `device '${device}'`
		
	}

	observe(messages: unknown[]): void {
		if (!this.options.enabled || messages.length === 0) {
			return;
		}

		const extracted = this.extractSchema(messages);
		if (extracted.byDevice.size === 0) {
			return;
		}

		this.totalWindows += 1;

		for (const [deviceId, schema] of extracted.byDevice) {
			if (schema.fields.size === 0) {
				continue;
			}

			this.observeDevice(deviceId, schema);
		}
	}

	private observeDevice(deviceId: string, schema: DeviceSchema): void {
		let state = this.deviceStates.get(deviceId);
		if (!state) {
			if (this.deviceStates.size >= this.options.maxTrackedDevices) {
				// Bounded — a runaway number of distinct device identities (e.g. a
				// misbehaving upstream generating unique names per message) can't
				// grow this endpoint's tracked state without limit.
				return;
			}

			state = this.createDeviceState();
			this.deviceStates.set(deviceId, state);
		}

		state.totalBatches += 1;

		if (!state.baseline) {
			this.learnBaselineForDevice(deviceId, state, schema);
			return;
		}

		const interval = Math.max(1, this.options.checkIntervalBatches);
		if (interval > 1 && state.totalBatches % interval !== 0) {
			return;
		}

		this.detectDriftForDevice(deviceId, state, schema);
	}

	private learnBaselineForDevice(deviceId: string, state: DeviceDriftState, schema: DeviceSchema): void {
		state.warmupSeen += 1;

		for (const field of schema.fields) {
			this.incrementCount(state.warmupFieldCounts, field);
			this.recordTypeFrequency(
				state.warmupTypeFreq,
				field,
				schema.typesByField.get(field) ?? new Set<ValueType>(),
			);
		}

		if (state.warmupSeen < this.options.warmupBatches) {
			return;
		}

		const requiredPresence = Math.max(
			1,
			Math.ceil(
				this.options.warmupBatches * this.options.minFieldPresenceRatio,
			),
		);
		const baseline = new Set<string>();

		for (const [field, count] of state.warmupFieldCounts.entries()) {
			if (count < requiredPresence) {
				continue;
			}

			if (baseline.size >= this.options.maxTrackedFields) {
				break;
			}

			baseline.add(field);
			const freq = state.warmupTypeFreq.get(field);
			if (freq) {
				state.baselineTypeFreq.set(field, {
					counts: new Map(freq.counts),
					total: freq.total,
				});
			}
		}

		state.baseline = baseline;
		this.logger?.info(
			`Schema baseline learned for ${this.logSubject(deviceId)}`,
			{
				endpointName: this.endpointName,
				device: this.deviceLabel(deviceId),
				warmupBatches: state.warmupSeen,
				baselineFieldCount: baseline.size,
				sampleBaselineFields: sampleArray(
					Array.from(baseline),
					this.options.logSampleSize,
				),
			},
		);

		this.persistBaselineState();
	}

	private detectDriftForDevice(deviceId: string, state: DeviceDriftState, schema: DeviceSchema): void {
		const baseline = state.baseline;
		if (!baseline) {
			return;
		}

		this.evictStaleNewFieldCandidates(deviceId, state);

		const newFields: string[] = [];
		const missingFields: string[] = [];
		const typeDrifts: TypeDrift[] = [];
		let typeJustLearned = false;

		for (const field of schema.fields) {
			if (!baseline.has(field)) {
				this.handleNewField(deviceId, state, field, schema, newFields);
				continue;
			}

			state.missingStreakByField.set(field, 0);
			if (this.checkTypeDrift(deviceId, state, field, schema, typeDrifts)) {
				typeJustLearned = true;
			}
		}

		for (const expected of baseline) {
			if (schema.fields.has(expected)) {
				continue;
			}

			this.handleMissingField(deviceId, state, expected, baseline, missingFields);
		}

		// A field whose type just became known for the first time (e.g. one of
		// declareDeviceSchema()'s config-seeded fields, which starts with no
		// observed values at all) isn't itself "new/missing/drifted" — so
		// without this, a stable device would never re-persist after its
		// initial declare, and the Type column would stay blank forever for
		// fields that never happen to drift. See GitHub issue #21.
		if (typeJustLearned) {
			this.persistBaselineState();
		}

		if (
			newFields.length === 0 &&
			missingFields.length === 0 &&
			typeDrifts.length === 0
		) {
			return;
		}

		// Bulk-change guard: when most of a device's baseline goes missing at
		// once (a naming-convention fix, a register-map edit, any legitimate
		// mass rename), don't report N individual critical "missing-field"
		// incidents — they're all explained by the same one-time schema
		// migration, not N unrelated real failures. Adopt the new schema as
		// baseline immediately and emit one informational log line instead.
		// Deliberately independent of the streak/cooldown machinery below
		// (those exist to debounce ordinary one-off flicker, not a
		// synchronized mass change) and of detectRenameCandidate() (which
		// only ever finds a single best pair and never suppresses the
		// per-field alerts for it anyway — this guard makes that gap moot
		// for the case that actually matters).
		const missingRatio = baseline.size > 0 ? missingFields.length / baseline.size : 0;
		const isBulkChange =
			missingFields.length >= this.options.bulkChangeMinFields &&
			missingRatio >= this.options.bulkChangeRatio;

		if (isBulkChange) {
			const deviceLabel = this.deviceLabel(deviceId);
			this.logger?.warn(
				`Bulk schema change detected for ${this.logSubject(deviceId)} — baseline auto-updated, no incidents raised`,
				{
					endpointName: this.endpointName,
					device: deviceLabel,
					previousBaselineFieldCount: baseline.size,
					observedFieldCount: schema.fields.size,
					missingFieldCount: missingFields.length,
					newFieldCount: newFields.length,
				},
			);

			state.baseline = new Set(schema.fields);
			state.missingStreakByField.clear();
			state.newFieldCounts.clear();
			state.newFieldFirstSeen.clear();
			state.newFieldTypeFreq.clear();
			state.newFieldLastSeen.clear();
			state.tombstones.clear();
			this.persistBaselineState();
			return;
		}

		// New-field occurrence counts/timestamps (newFieldCounts etc., bumped
		// just above inside handleNewField — unconditionally, regardless of
		// cooldown) were previously only persisted at the moment a field
		// actually promotes — every increment in between was purely
		// in-memory. On a restart (the exact thing that happened repeatedly
		// this session), that in-progress count is lost and the field starts
		// counting from zero again, so a field that reports every few
		// minutes can — across enough restarts — never accumulate enough
		// occurrences to promote, no matter how reliably it actually
		// reports. Persist here too, not just on promotion, so restarts no
		// longer erase progress.
		//
		// Deliberately keyed on the raw `newFields` (every field
		// handleNewField() actually ran for this batch) and placed BEFORE
		// the cooldown filtering/early-return below — a field's own
		// 30-minute alertCooldownMs empties it out of reportableNew on most
		// batches after its first appearance, which used to mean this whole
		// function returned early and never reached a persist call at all,
		// even though handleNewField() above had just bumped its counters.
		// A restart can land just as easily inside that cooldown window as
		// outside it.
		if (newFields.length > 0) {
			this.persistBaselineState();
		}

		const reportableNew = this.filterByCooldown(state, newFields, "new");
		const reportableMissing = this.filterByCooldown(state, missingFields, "missing");
		const reportableTypeDrifts = typeDrifts.filter((d) =>
			this.isPastCooldown(state, `type:${d.field}`),
		);
		for (const d of reportableTypeDrifts) {
			this.touchCooldown(state, `type:${d.field}`);
		}

		if (
			reportableNew.length === 0 &&
			reportableMissing.length === 0 &&
			reportableTypeDrifts.length === 0
		) {
			return;
		}

		const severity: DriftSeverity =
			reportableMissing.length > 0 || reportableTypeDrifts.length > 0
				? "critical"
				: "warning";

		// Scoped to this device's own missing/new fields — a "rename" can never be
		// suggested across two different devices just because their field names
		// happen to look similar (e.g. every VAV has its own "zone_setpoint").
		const renameCandidate = this.detectRenameCandidate(
			reportableMissing,
			reportableNew,
		);
		const s = this.options.logSampleSize;
		const deviceLabel = this.deviceLabel(deviceId);

		this.logger?.warn(
			`Schema drift detected for ${this.logSubject(deviceId)}`,
			{
				endpointName: this.endpointName,
				device: deviceLabel,
				severity,
				baselineFieldCount: baseline.size,
				observedFieldCount: schema.fields.size,
				deviceBatchesSeen: state.totalBatches,
				additiveFieldCount: reportableNew.length,
				sampleAdditiveFields: sampleArray(reportableNew, s),
				breakingFieldCount: reportableMissing.length,
				sampleBreakingFields: sampleArray(reportableMissing, s),
				typeDriftCount: reportableTypeDrifts.length,
				sampleTypeDrifts: sampleArray(reportableTypeDrifts, s),
				renameCandidate,
			},
		);

		const isSuppressed = (type: DriftType, rules: DriftRule[]) =>
			rules.length > 0 && rules[0].suppressDriftTypes?.includes(type);

		const shouldAlert = (type: DriftType, rules: DriftRule[]) => {
			if (rules.length === 0) return false;
			const alertTypes = rules[0].alertOnDriftTypes;
			return alertTypes ? alertTypes.includes(type) : false;
		};

		const resolveSeverity = (type: DriftType, fallback: DriftSeverity, rules: DriftRule[]): DriftSeverity => {
			if (rules.length > 0) {
				const override = rules[0].severityOverrides?.[type];
				if (override) return override;
			}
			return fallback;
		};

		for (const field of reportableNew) {
			const rules = this.resolveFieldRules(field, deviceId);
			const severity = resolveSeverity('new-field', 'warning', rules);
			this.persistDriftEvent({
				endpointName: this.endpointName,
				driftType: 'new-field',
				fieldName: field,
				severity,
				details: deviceLabel ? { deviceId: deviceLabel } : undefined,
			});
			if (isSuppressed('new-field', rules)) continue;
			if (shouldAlert('new-field', rules)) {
				this.driftAlertHandler?.({
					endpointName: this.endpointName,
					device: deviceLabel,
					driftType: 'new-field',
					severity,
					fieldName: field,
				});
			}
		}

		for (const field of reportableMissing) {
			const rules = this.resolveFieldRules(field, deviceId);
			const severity = resolveSeverity('missing-field', 'critical', rules);
			this.persistDriftEvent({
				endpointName: this.endpointName,
				driftType: 'missing-field',
				fieldName: field,
				severity,
				details: deviceLabel ? { deviceId: deviceLabel } : undefined,
			});
			if (isSuppressed('missing-field', rules)) continue;
			if (shouldAlert('missing-field', rules)) {
				this.driftAlertHandler?.({
					endpointName: this.endpointName,
					device: deviceLabel,
					driftType: 'missing-field',
					severity,
					fieldName: field,
				});
			}
		}

		for (const drift of reportableTypeDrifts) {
			const rules = this.resolveFieldRules(drift.field, deviceId);
			const severity = resolveSeverity('type-drift', 'critical', rules);
			this.persistDriftEvent({
				endpointName: this.endpointName,
				driftType: 'type-drift',
				fieldName: drift.field,
				severity,
				expectedType: drift.dominantExpectedType,
				observedTypes: drift.observedTypes,
				details: deviceLabel ? { deviceId: deviceLabel } : undefined,
			});
			if (isSuppressed('type-drift', rules)) continue;
			if (shouldAlert('type-drift', rules)) {
				this.driftAlertHandler?.({
					endpointName: this.endpointName,
					device: deviceLabel,
					driftType: 'type-drift',
					severity,
					fieldName: drift.field,
					expectedType: drift.dominantExpectedType,
					observedTypes: drift.observedTypes,
				});
			}
		}

		if (renameCandidate) {
			const rules = this.resolveFieldRules(renameCandidate.from, deviceId);
			const severity = resolveSeverity('rename-candidate', 'warning', rules);
			this.persistDriftEvent({
				endpointName: this.endpointName,
				driftType: 'rename-candidate',
				severity,
				renameCandidateFrom: renameCandidate.from,
				renameCandidateTo: renameCandidate.to,
				renameSimilarity: renameCandidate.similarity,
				details: deviceLabel ? { deviceId: deviceLabel } : undefined,
			});
			if (!isSuppressed('rename-candidate', rules) && shouldAlert('rename-candidate', rules)) {
				this.driftAlertHandler?.({
					endpointName: this.endpointName,
					device: deviceLabel,
					driftType: 'rename-candidate',
					severity,
					renameCandidateFrom: renameCandidate.from,
					renameCandidateTo: renameCandidate.to,
					renameSimilarity: renameCandidate.similarity,
				});
			}
		}
	}

	/**
	 * Evict new-field candidates that haven't been observed in over
	 * adaptiveRetireMs. Without this, a candidate whose device was later
	 * removed (or that only ever appeared during a brief rotation window)
	 * sits in newFieldCounts/newFieldFirstSeen/newFieldTypeFreq forever — once
	 * enough of these accumulate to fill maxTrackedFields, brand-new genuinely
	 * live fields can never even start being tracked (canTrackInMap rejects
	 * anything not already present), so they report as additive drift on every
	 * batch with no way to ever self-heal. Mirrors how stale baseline fields are
	 * already retired via missingStreakByField + adaptiveRetireBatches — kept
	 * as wall-clock time here rather than that mechanism's batch count, same
	 * reasoning as adaptivePromotionMinElapsedMs: a candidate that reports
	 * every few minutes must not be evicted (and so lose all accumulated
	 * promotion progress) just because many unrelated batches passed between
	 * appearances.
	 */
	private evictStaleNewFieldCandidates(deviceId: string, state: DeviceDriftState): void {
		const now = Date.now();
		const staleFields: string[] = [];
		for (const [field, lastSeen] of state.newFieldLastSeen) {
			if (now - lastSeen > this.options.adaptiveRetireMs) {
				staleFields.push(field);
			}
		}

		if (staleFields.length === 0) {
			return;
		}

		for (const field of staleFields) {
			state.newFieldCounts.delete(field);
			state.newFieldFirstSeen.delete(field);
			state.newFieldTypeFreq.delete(field);
			state.newFieldLastSeen.delete(field);
		}

		this.logger?.debug(
			`Evicted ${staleFields.length} stale new-field candidate(s) for ${this.logSubject(deviceId)}`,
			{
				endpointName: this.endpointName,
				device: this.deviceLabel(deviceId),
				evictedCount: staleFields.length,
				sampleEvicted: sampleArray(staleFields, this.options.logSampleSize),
			},
		);

		this.persistBaselineState();
	}

	private handleNewField(
		deviceId: string,
		state: DeviceDriftState,
		field: string,
		schema: DeviceSchema,
		newFields: string[],
	): void {
		newFields.push(field);

		// Resurrection: field was previously retired — log and clear the tombstone.
		const retiredAt = state.tombstones.get(field);
		if (retiredAt !== undefined) {
			state.tombstones.delete(field);
			this.logger?.info(
				`Field reappeared for ${this.logSubject(deviceId)}`,
				{
					endpointName: this.endpointName,
					device: this.deviceLabel(deviceId),
					field,
					retiredAtBatch: retiredAt,
					reappearedAtBatch: state.totalBatches,
				},
			);
		}

		// Wall-clock timestamps, not state.totalBatches — see
		// adaptivePromotionMinElapsedMs's doc comment for why a batch-index
		// window doesn't work once an endpoint's batch rate (e.g. an OPC-UA
		// subscription firing per-node) is decoupled from how often any one
		// field actually reports.
		const now = Date.now();
		if (!state.newFieldFirstSeen.has(field)) {
			state.newFieldFirstSeen.set(field, now);
		}
		if (this.canTrackInMap(state.newFieldLastSeen, field)) {
			state.newFieldLastSeen.set(field, now);
		}

		this.incrementCount(state.newFieldCounts, field);
		this.recordTypeFrequency(
			state.newFieldTypeFreq,
			field,
			schema.typesByField.get(field) ?? new Set<ValueType>(),
		);

		const stableCount = state.newFieldCounts.get(field) ?? 0;
		const firstSeen = state.newFieldFirstSeen.get(field) ?? now;
		const elapsedMs = now - firstSeen;

		const fieldRules = this.resolveFieldRules(field, deviceId);
		const promoBatches = fieldRules[0]?.adaptivePromotionBatches ?? this.options.adaptivePromotionBatches;
		const promoElapsed = fieldRules[0]?.adaptivePromotionMinElapsedMs ?? this.options.adaptivePromotionMinElapsedMs;

		const shouldPromote =
			stableCount >= promoBatches &&
			elapsedMs >= promoElapsed &&
			state.baseline!.size < this.options.maxTrackedFields;

		if (!shouldPromote) {
			return;
		}

		state.baseline!.add(field);
		state.missingStreakByField.set(field, 0);
		state.newFieldCounts.delete(field);
		state.newFieldFirstSeen.delete(field);
		state.newFieldLastSeen.delete(field);

		const freq = state.newFieldTypeFreq.get(field);
		if (freq) {
			state.baselineTypeFreq.set(field, {
				counts: new Map(freq.counts),
				total: freq.total,
			});
			state.newFieldTypeFreq.delete(field);
		}


		this.persistBaselineState();
	}

	// Returns true the first time a baseline field's type becomes known (no
	// prior freq entry) — declareDeviceSchema() seeds `baseline` from
	// configured field *names* with no observed values, so baselineTypeFreq
	// starts empty for every field it declares. The caller (detectDriftForDevice)
	// uses this to force a persist even when nothing else changed, since a
	// stable/non-drifting device otherwise never re-persists after its initial
	// declare — leaving the Schema Drift grid's Type column permanently blank
	// for fields that never happen to drift. See GitHub issue #21.
	private checkTypeDrift(
		deviceId: string,
		state: DeviceDriftState,
		field: string,
		schema: DeviceSchema,
		typeDrifts: TypeDrift[],
	): boolean {
		const observedTypes = schema.typesByField.get(field);
		if (!observedTypes || observedTypes.size === 0) {
			return false;
		}

		const freq = state.baselineTypeFreq.get(field);
		if (!freq) {
			this.recordTypeFrequency(state.baselineTypeFreq, field, observedTypes);
			return true;
		}

		const expectedTypes = this.getDominantExpectedTypes(freq);
		this.recordTypeFrequency(state.baselineTypeFreq, field, observedTypes);

		if (expectedTypes.size === 0) {
			return false;
		}

		const fieldRules = this.resolveFieldRules(field, deviceId);
		const allowed = fieldRules[0]?.allowedTypes;

		const unexpectedTypes = Array.from(observedTypes).filter((t) => {
			if (expectedTypes.has(t)) return false;
			if (allowed?.includes(t)) return false;
			return true;
		});
		if (unexpectedTypes.length === 0) {
			return false;
		}

		const dominantExpectedType = this.getDominantType(freq);
		if (!dominantExpectedType || dominantExpectedType === 'null') {
			return false;
		}

		typeDrifts.push({
			field,
			dominantExpectedType,
			observedTypes: Array.from(observedTypes),
		});
		return false;
	}

	private handleMissingField(
		deviceId: string,
		state: DeviceDriftState,
		expected: string,
		baseline: Set<string>,
		missingFields: string[],
	): void {
		const streak = (state.missingStreakByField.get(expected) ?? 0) + 1;
		state.missingStreakByField.set(expected, streak);

		const fieldRules = this.resolveFieldRules(expected, deviceId);
		const missingThreshold = fieldRules[0]?.consecutiveMissingThreshold ?? this.options.consecutiveMissingThreshold;

		if (streak >= missingThreshold) {
			missingFields.push(expected);
		}

		const pinned = fieldRules[0]?.pinAsBaseline;
		if (pinned) return;

		const retireBatches = fieldRules[0]?.adaptiveRetireBatches ?? this.options.adaptiveRetireBatches;

		if (streak >= retireBatches) {
			baseline.delete(expected);
			state.missingStreakByField.delete(expected);
			state.baselineTypeFreq.delete(expected);

			if (this.canTrackInMap(state.tombstones, expected)) {
				state.tombstones.set(expected, state.totalBatches);
			}

			this.logger?.info(
				`Retired stale field from schema baseline for ${this.logSubject(deviceId)}`,
				{
					endpointName: this.endpointName,
					device: this.deviceLabel(deviceId),
					field: expected,
					missingStreak: streak,
					retiredAtBatch: state.totalBatches,
				},
			);

			this.persistBaselineState();
		}
	}

	private detectRenameCandidate(
		missingFields: string[],
		newFields: string[],
	): { from: string; to: string; similarity: number } | undefined {
		if (missingFields.length === 0 || newFields.length === 0) {
			return undefined;
		}

		const { maxRenameCandidates, maxRenameFieldLength } = this.options;
		const candidates = missingFields.slice(0, maxRenameCandidates);
		const added = newFields.slice(0, maxRenameCandidates);
		let best: { from: string; to: string; similarity: number } | undefined;

		for (const m of candidates) {
			const fromRaw = m.split(":").slice(1).join(":");
			if (fromRaw.length > maxRenameFieldLength) {
				continue;
			}

			for (const a of added) {
				const toRaw = a.split(":").slice(1).join(":");
				if (toRaw.length > maxRenameFieldLength) {
					continue;
				}

				const similarity = stringSimilarity(fromRaw, toRaw, maxRenameFieldLength);
				if (similarity === undefined) {
					continue;
				}

				if (!best || similarity > best.similarity) {
					best = { from: m, to: a, similarity };
				}
			}
		}

		return best && best.similarity >= 0.72 ? best : undefined;
	}

	private extractSchema(messages: unknown[]): ExtractedSchema {
		const byDevice = new Map<string, DeviceSchema>();
		const visited = new WeakSet<object>();

		const getBucket = (deviceId: string): DeviceSchema | undefined => {
			let bucket = byDevice.get(deviceId);
			if (!bucket) {
				if (byDevice.size >= this.options.maxTrackedDevices) {
					return undefined;
				}
				bucket = { fields: new Set(), typesByField: new Map() };
				byDevice.set(deviceId, bucket);
			}
			return bucket;
		};

		const addField = (bucket: DeviceSchema, field: string, value: unknown): void => {
			if (bucket.fields.size >= this.options.maxFieldsPerBatch) {
				return;
			}

			if (!bucket.fields.has(field) && bucket.fields.size >= this.options.maxTrackedFields) {
				return;
			}

			bucket.fields.add(field);

			// null means "no reading yet" — don't let it define the expected type
			if (value === null || value === undefined) {
				return;
			}

			if (!this.canTrackInMap(bucket.typesByField, field)) {
				return;
			}

			let types = bucket.typesByField.get(field);
			if (!types) {
				types = new Set<ValueType>();
				bucket.typesByField.set(field, types);
			}

			types.add(valueTypeOf(value));
		};

		// inheritedDeviceId is what to use if THIS value has no device identity of
		// its own — a plain array (e.g. a whole poll-cycle batch of per-device
		// reading objects serialized as one socket frame) carries no identity at
		// its own level, so its entries must each be checked individually rather
		// than the array's caller assuming one identity for everything inside it.
		const traverse = (value: unknown, prefix: string, depth: number, inheritedDeviceId: string): void => {
			if (depth > this.options.maxTraversalDepth) {
				return;
			}

			if (Array.isArray(value)) {
				if (value.length === 0) {
					return;
				}

				const arrayRef = value as unknown as object;
				if (visited.has(arrayRef)) {
					return;
				}

				visited.add(arrayRef);

				// Array entries are traversed under the same prefix, intentionally collapsing
				// positional structure. Each entry resolves its own device identity below —
				// they are NOT assumed to all belong to whatever inheritedDeviceId came in.
				for (const entry of value) {
					traverse(entry, prefix, depth + 1, inheritedDeviceId);
				}

				return;
			}

			const record = asRecord(value);
			if (!record) {
				return;
			}

			const objectRef = record as unknown as object;
			if (visited.has(objectRef)) {
				return;
			}

			visited.add(objectRef);

			// This object's own device identity takes precedence over whatever was
			// inherited from an ancestor — e.g. a per-device reading nested inside an
			// endpoint-level wrapper is still its own device, not the wrapper's.
			const deviceId = resolveDeviceId(record) ?? inheritedDeviceId;
			const bucket = getBucket(deviceId);
			if (!bucket || bucket.fields.size >= this.options.maxFieldsPerBatch) {
				return;
			}

			const handledKeys = new Set<string>();

			const readings = record.readings;
			if (Array.isArray(readings)) {
				handledKeys.add("readings");
				for (const reading of readings) {
					const rr = asRecord(reading);
					if (!rr) {
						continue;
					}

					const fieldNameRaw = toFieldName(rr.metric) || toFieldName(rr.registerName) || toFieldName(rr.name);

					if (!fieldNameRaw) {
						continue;
					}

					const normalized = normalizeFieldName(fieldNameRaw);
					if (!normalized) {
						continue;
					}

					// A reading can carry its own more-specific device identity than its
					// parent wrapper — prefer that, falling back to the wrapper's.
					const rrDeviceId = resolveDeviceId(rr) ?? deviceId;
					const rrBucket = getBucket(rrDeviceId);
					if (rrBucket) {
						addField(rrBucket, `reading:${normalized}`, rr.value);
					}
				}
			}

			const directFieldRaw = toFieldName(record.metric) || toFieldName(record.registerName) || toFieldName(record.name);

			if (directFieldRaw) {
				handledKeys.add("metric");
				handledKeys.add("register_name");
				handledKeys.add("name");
				handledKeys.add("value");
				const normalized = normalizeFieldName(directFieldRaw);
				if (normalized) {
					addField(bucket, `reading:${normalized}`, record.value);
				}
			}

			for (const [rawKey, rawValue] of Object.entries(record)) {
				const normalizedKey = normalizeFieldName(rawKey);
				if (!normalizedKey) {
					continue;
				}

				if (
					RESERVED_GENERIC_KEYS.has(normalizedKey) ||
					handledKeys.has(normalizedKey)
				) {
					continue;
				}

				if (isTelemetryPrimitive(rawValue)) {
					const scopedKey = prefix
						? `${prefix}.${normalizedKey}`
						: normalizedKey;
					addField(bucket, `key:${scopedKey}`, rawValue);
				}

				if (typeof rawValue === "object" && rawValue !== null) {
					const nextPrefix = prefix
						? `${prefix}.${normalizedKey}`
						: normalizedKey;
					traverse(rawValue, nextPrefix, depth + 1, deviceId);
				}
			}
		};

		for (const message of messages) {
			traverse(message, "", 0, DEFAULT_DEVICE_KEY);
		}

		return { byDevice };
	}

	private canTrackInMap<V>(map: Map<string, V>, field: string): boolean {
		return map.has(field) || map.size < this.options.maxTrackedFields;
	}

	private incrementCount(
		map: Map<string, number>,
		field: string,
		amount = 1,
	): void {
		if (!this.canTrackInMap(map, field)) {
			return;
		}

		map.set(field, (map.get(field) ?? 0) + amount);
	}

	private recordTypeFrequency(
		freqMap: Map<string, TypeFrequency>,
		field: string,
		types: Set<ValueType>,
	): void {
		if (!this.canTrackInMap(freqMap, field)) {
			return;
		}

		let freq = freqMap.get(field);
		if (!freq) {
			freq = { counts: new Map(), total: 0 };
			freqMap.set(field, freq);
		}

		for (const t of types) {
			freq.counts.set(t, (freq.counts.get(t) ?? 0) + 1);
		}

		freq.total += 1;
	}

	/**
	 * Returns the set of ValueTypes whose frequency ratio meets or exceeds
	 * minTypeDominanceRatio. A type must be consistently present to be considered
	 * "expected", preventing unlimited widening from occasional bad payloads.
	 */
	private getDominantExpectedTypes(freq: TypeFrequency): Set<ValueType> {
		const expected = new Set<ValueType>();
		for (const [type, count] of freq.counts) {
			if (count / freq.total >= this.options.minTypeDominanceRatio) {
				expected.add(type);
			}
		}
		return expected;
	}

	private getDominantType(freq: TypeFrequency): ValueType | undefined {
		let best: { type: ValueType; count: number } | undefined;
		for (const [type, count] of freq.counts.entries()) {
			if (!best || count > best.count) {
				best = { type, count };
			}
		}

		return best?.type;
	}

	private isPastCooldown(state: DeviceDriftState, signature: string): boolean {
		return (
			Date.now() - (state.lastAlertAtBySignature.get(signature) ?? 0) >=
			this.options.alertCooldownMs
		);
	}

	private touchCooldown(state: DeviceDriftState, signature: string): void {
		if (!this.canTrackInMap(state.lastAlertAtBySignature, signature)) {
			return;
		}

		state.lastAlertAtBySignature.set(signature, Date.now());
	}

	private filterByCooldown(state: DeviceDriftState, fields: string[], prefix: string): string[] {
		const allowed: string[] = [];
		for (const field of fields) {
			const sig = `${prefix}:${field}`;
			if (!this.isPastCooldown(state, sig)) {
				continue;
			}

			this.touchCooldown(state, sig);
			allowed.push(field);
		}

		return allowed;
	}
}
