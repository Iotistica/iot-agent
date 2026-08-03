import type { UnitProvenance } from '../normalization/types.js';

const UNIT_PROVENANCE_CONFIDENCE: Record<UnitProvenance['method'], number> = {
	'exact-canonical': 1.00,
	'scoped-alias': 0.95,
	'global-alias': 0.85,
	'unresolved': 0.00,
};

/**
 * Applies quality policy to normalization's provenance facts — an assessment,
 * not a passive lookup. The single source of truth for unit confidence:
 * normalization stays deterministic/fact-only (src/normalization/), this
 * policy can change independently across releases without touching it.
 *
 * Future dimensions (pointName, semantics) add their own assess*Confidence()
 * export here, alongside their own facts-only Provenance type in that stage's
 * module — same separation, repeated per dimension as later phases land.
 */
export function assessUnitConfidence(provenance: UnitProvenance): number {
	return UNIT_PROVENANCE_CONFIDENCE[provenance.method];
}
