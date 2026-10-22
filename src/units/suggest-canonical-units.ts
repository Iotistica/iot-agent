import { UnitDefinitionsModel, UnitAliasesModel, CustomUnitAliasesModel, type UnitDefinitionRecord } from '../db/models/index.js';
import { normalizeSourceSystem } from './source-system.js';

export interface UnitSuggestion {
	canonical_unit: string;
	symbol: string | null;
	quantity: string;
	score: number;
	matchedVia: string;
}

const SCOPED_BONUS = 5;
const MIN_APPROX_QUERY_LEN = 3;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/**
 * Scores all canonical units against a raw unit string and returns ranked
 * suggestions. Read-only — never writes to the DB or modifies the catalog.
 */
export function suggestCanonicalUnits(
	query: string,
	sourceSystem?: string | null,
	limit?: number,
): UnitSuggestion[] {
	const trimmed = query.trim();
	if (!trimmed) return [];

	const effectiveLimit = Math.min(Math.max(1, limit ?? DEFAULT_LIMIT), MAX_LIMIT);
	const normalizedSource = normalizeSourceSystem(sourceSystem);
	const queryLower = trimmed.toLowerCase();
	const allowApprox = trimmed.length >= MIN_APPROX_QUERY_LEN;

	const definitions = UnitDefinitionsModel.getAll();
	const defByCanonical = new Map<string, UnitDefinitionRecord>(definitions.map((d) => [d.canonical_unit, d]));

	// Best score + matchedVia per canonical unit.
	const candidates = new Map<string, { score: number; matchedVia: string }>();

	function consider(canonicalUnit: string, score: number, matchedVia: string): void {
		if (!defByCanonical.has(canonicalUnit)) return;
		const existing = candidates.get(canonicalUnit);
		if (!existing || score > existing.score) {
			candidates.set(canonicalUnit, { score, matchedVia });
		}
	}

	// --- Score aliases (built-in + custom) ---
	const allAliases = [
		...UnitAliasesModel.getAll().map((a) => ({ ...a, source_system: a.source_system ?? null })),
		...CustomUnitAliasesModel.getAll().map((a) => ({ ...a, source_system: a.source_system ?? null })),
	];

	for (const alias of allAliases) {
		const aliasSource = normalizeSourceSystem(alias.source_system);
		const scopeBonus = (normalizedSource && aliasSource === normalizedSource) ? SCOPED_BONUS : 0;

		if (alias.alias === trimmed) {
			consider(alias.canonical_unit, 100 + scopeBonus, 'exact-alias');
		} else if (alias.alias.toLowerCase() === queryLower) {
			consider(alias.canonical_unit, 95 + scopeBonus, 'exact-alias-ci');
		} else if (allowApprox && alias.alias.length >= MIN_APPROX_QUERY_LEN && alias.alias.toLowerCase().startsWith(queryLower)) {
			consider(alias.canonical_unit, 70 + scopeBonus, 'alias-starts-with');
		}
	}

	// --- Score definitions (canonical name, symbol, description, quantity) ---
	for (const def of definitions) {
		// Exact symbol match (case-sensitive only — symbols are precise).
		if (def.symbol && def.symbol === trimmed) {
			consider(def.canonical_unit, 90, 'symbol');
		}

		// Exact canonical name match (case-insensitive).
		if (def.canonical_unit.toLowerCase() === queryLower) {
			consider(def.canonical_unit, 85, 'canonical-name');
		}

		if (allowApprox) {
			// Canonical name starts-with.
			if (def.canonical_unit.toLowerCase().startsWith(queryLower) && def.canonical_unit.toLowerCase() !== queryLower) {
				consider(def.canonical_unit, 60, 'canonical-starts-with');
			}

			// Description substring.
			if (def.description?.toLowerCase().includes(queryLower)) {
				consider(def.canonical_unit, 40, 'description-substring');
			}

			// Quantity substring.
			if (def.quantity.toLowerCase().includes(queryLower) && !def.description?.toLowerCase().includes(queryLower)) {
				consider(def.canonical_unit, 40, 'quantity-substring');
			}
		}
	}

	// --- Build result ---
	const results: UnitSuggestion[] = [];
	for (const [canonical_unit, { score, matchedVia }] of candidates) {
		const def = defByCanonical.get(canonical_unit)!;
		results.push({
			canonical_unit,
			symbol: def.symbol ?? null,
			quantity: def.quantity,
			score,
			matchedVia,
		});
	}

	results.sort((a, b) => b.score - a.score || a.canonical_unit.localeCompare(b.canonical_unit));
	return results.slice(0, effectiveLimit);
}
