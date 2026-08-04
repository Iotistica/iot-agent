/** Minimal logger shape — mirrors src/normalization/types.ts's Logger. */
export interface Logger {
	debug(message: string, ...args: any[]): void;
	info(message: string, ...args: any[]): void;
	warn(message: string, ...args: any[]): void;
	error(message: string, ...args: any[]): void;
}

/**
 * Facts about how a point name was resolved. `method` records HOW the
 * content was produced and must stay stable across restarts/caching — a
 * future identity-confidence policy will key off it alone, mirroring
 * src/quality/confidence-policy.ts's use of UnitProvenance.method.
 * `resolutionSource` and `persistenceState` are separate, orthogonal facts
 * about this run's cache/durability status: restoring a mapping from disk
 * never rewrites `method` to some generic "persisted" value.
 */
export interface PointNameProvenance {
	/** HOW the name content was produced. 'explicit-mapping' returns in Phase 2 — see plan §6/§16. */
	method: 'algorithmic' | 'unresolved';
	/** WHERE this run's result came from — independent of `method`. */
	resolutionSource: 'runtime-generated' | 'persisted-cache';
	/** Durability of the underlying row. A mapping can be locked (reuse policy, catalog.ts) while this is still 'pending'. */
	persistenceState: 'pending' | 'persisted' | 'failed';
	/** Which raw fields were consulted, e.g. ['metric']. */
	sourceFields: string[];
	sourceSystem?: string | null;
	/** Present only when collision resolution (catalog.ts) fired for this raw name. */
	collisionSuffix?: string;
}

/**
 * provisionalPointId — deterministic for the current natural key
 * (sourceSystem + endpointName + deviceKey + rawName); stable across process
 * restarts as long as those inputs are unchanged; NOT guaranteed to survive a
 * raw-name rename; NOT the final durable point identity. Never surfaced as
 * `pointId` in any payload — that name is reserved for a future Phase 2
 * source-address-derived durable identifier (adapter-level sourceAddress
 * enrichment, not built in Phase 1). Do not use provisionalPointId as a join
 * key for history/relationships; external integrations must not assume it is
 * immutable.
 */
export interface PointIdentity {
	provisionalPointId: string;
	/** Always populated, never empty — falls back to a deterministic unnamed_point_<hash> sentinel. */
	normalizedName: string;
	/** Verbatim message.metric/message.name pre-normalization. */
	rawName: string;
	/** Copy of message.deviceName when present. */
	rawDeviceName?: string;
	/** Populated ONLY if already present on the incoming reading — never fabricated (no adapter attaches this in Phase 1). */
	sourceAddress?: string;
	/**
	 * Version of the normalization algorithm that originally produced this
	 * mapping — set once at computation time, persisted unchanged thereafter.
	 * Informational only in Phase 1: nothing reads it to trigger any action.
	 * A future release may compare a stored mapping's rulesVersion against the
	 * then-current constant to decide whether it's *eligible* for an explicit,
	 * operator-triggered regeneration — Phase 1 never auto-regenerates.
	 */
	rulesVersion: string;
	provenance: PointNameProvenance;
}

export const CURRENT_POINT_NAME_RULES_VERSION = 'pn-rules-v1';
