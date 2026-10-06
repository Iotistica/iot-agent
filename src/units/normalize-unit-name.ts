import { getUnitCatalog } from './catalog.js';
import type { MatchedAlias, UnitProvenance } from './types.js';

export interface NormalizeUnitNameResult {
	unit: string;
	quantity?: string;
	normalized: boolean;
	matchedAlias?: MatchedAlias;
	warning?: string;
}

/** Derives the facts-only UnitProvenance from a normalizeUnitName() result — no confidence assigned here. */
export function deriveProvenance(result: NormalizeUnitNameResult): UnitProvenance {
	if (!result.normalized) return { method: 'unresolved' };
	if (!result.matchedAlias) return { method: 'exact-canonical' };
	if (result.matchedAlias.source_system !== null) {
		return { method: 'scoped-alias', sourceSystem: result.matchedAlias.source_system };
	}
	return { method: 'global-alias', sourceSystem: null };
}

/**
 * Resolves a raw unit string to its canonical name via the catalog's
 * two-tier (scoped-then-global) alias lookup. Never touches a numeric value
 * (per spec: normalization alone must leave the value unchanged) and never
 * throws — an unknown unit is a normal, expected outcome (normalized:false,
 * original string returned unchanged), not an error.
 */
export function normalizeUnitName(rawUnit: string, sourceSystem?: string, quiet = false): NormalizeUnitNameResult {
	const catalog = getUnitCatalog();

	// Already a canonical name (e.g. a future adapter emitting canonical units
	// directly) — recognize it without needing a redundant self-referential
	// alias row for every one of the ~37 seeded units.
	const exact = catalog.getDefinition(rawUnit);
	if (exact) {
		return { unit: exact.canonical_unit, quantity: exact.quantity, normalized: true };
	}

	const match = catalog.resolveAlias(rawUnit, sourceSystem);

	if (!match) {
		if (!quiet) catalog.logUnknownUnit(rawUnit, sourceSystem);
		return { unit: rawUnit, normalized: false, warning: `Unknown unit "${rawUnit}"` };
	}

	const def = catalog.getDefinition(match.canonical_unit);
	return {
		unit: match.canonical_unit,
		quantity: def?.quantity,
		normalized: true,
		matchedAlias: { source_system: match.source_system ?? null, alias: match.alias },
	};
}
