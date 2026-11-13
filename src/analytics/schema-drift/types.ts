/**
 * Structurally mirrors iot-agent's own Logger / schema-drift persistence
 * types (src/publish/core/types.ts, src/db/models/schema-drift.model.ts).
 * Duplicated intentionally rather than imported — this package builds and
 * ships independently of the Community host app, so it can't have a
 * compile-time dependency on iot-agent's internal module layout. The host
 * passes in its own concrete Logger/store implementations, which satisfy
 * these interfaces structurally.
 */

export interface Logger {
	debug(message: string, ...args: any[]): void;
	info(message: string, ...args: any[]): void;
	warn(message: string, ...args: any[]): void;
	error(message: string, ...args: any[]): void;
}

export type DriftType = 'new-field' | 'missing-field' | 'type-drift' | 'rename-candidate';
export type DriftSeverity = 'warning' | 'critical';

export interface SchemaDriftEvent {
	endpointName: string;
	driftType: DriftType;
	fieldName?: string;
	severity: DriftSeverity;
	expectedType?: string;
	observedTypes?: string[];
	renameCandidateFrom?: string;
	renameCandidateTo?: string;
	renameSimilarity?: number;
	timestamp?: string | Date;
	details?: Record<string, unknown>;
}

export interface PersistedTypeFrequency {
	counts: Record<string, number>;
	total: number;
}

export interface PersistedDeviceDriftState {
	baselineFields: string[];
	baselineTypeFreq: Record<string, PersistedTypeFrequency>;
	missingStreakByField: Record<string, number>;
	totalBatches: number;
	warmupSeen: number;
	tombstones?: Record<string, number>;
	newFieldCounts?: Record<string, number>;
	newFieldFirstSeen?: Record<string, number>;
	newFieldTypeFreq?: Record<string, PersistedTypeFrequency>;
	newFieldLastSeen?: Record<string, number>;
}

export interface PersistedBaselineState {
	endpointName: string;
	devices: Record<string, PersistedDeviceDriftState>;
}

export interface SchemaDriftStore {
	saveDrift(event: SchemaDriftEvent): void;
	saveBaseline(state: PersistedBaselineState): void;
	loadBaseline(endpointName: string): PersistedBaselineState | undefined;
}
