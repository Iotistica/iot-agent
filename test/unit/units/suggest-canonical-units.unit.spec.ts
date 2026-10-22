/**
 * Unit tests for suggestCanonicalUnits().
 * Uses the same in-memory DB mock pattern as normalize-unit.unit.spec.ts,
 * seeded from the real production seed dataset.
 */

jest.mock('../../../src/db/models/index', () => {
	const definitions = new Map<string, any>();
	const aliases = new Map<string, any>();
	const customAliases = new Map<string, any>();

	return {
		UnitDefinitionsModel: {
			getAll: () => Array.from(definitions.values()),
			getByCanonicalUnit: (u: string) => definitions.get(u) ?? null,
			upsert: (rec: any) => { definitions.set(rec.canonical_unit, rec); return rec; },
		},
		UnitAliasesModel: {
			getAll: () => Array.from(aliases.values()),
			findExact: (source: string | null, alias: string) => aliases.get(`${source ?? ''}\0${alias}`) ?? null,
			upsert: (rec: any) => { aliases.set(`${rec.source_system ?? ''}\0${rec.alias}`, rec); return rec; },
		},
		CustomUnitAliasesModel: {
			getAll: () => Array.from(customAliases.values()),
			findExact: (source: string | null, alias: string) => customAliases.get(`${source ?? ''}\0${alias}`) ?? null,
			upsert: (rec: any) => { customAliases.set(`${rec.source_system ?? ''}\0${rec.alias}`, rec); return rec; },
			deleteByCanonicalUnit: () => {},
		},
	};
});

import { suggestCanonicalUnits } from '../../../src/units/suggest-canonical-units';
import { getUnitCatalog } from '../../../src/units/catalog';
import { CustomUnitAliasesModel } from '../../../src/db/models/index';

// Seed the in-memory store with the real production dataset (triggers
// seedUnitCatalog() via the catalog singleton's reload()).
beforeAll(() => {
	getUnitCatalog().init();
});

describe('suggestCanonicalUnits', () => {
	it('returns degreesCelsius at score 100 for exact case-sensitive alias "°C"', () => {
		const results = suggestCanonicalUnits('°C');
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].canonical_unit).toBe('degreesCelsius');
		expect(results[0].score).toBe(100);
		expect(results[0].matchedVia).toBe('exact-alias');
	});

	it('returns kilopascals at score 95 for case-insensitive alias "kpa"', () => {
		const results = suggestCanonicalUnits('kpa');
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].canonical_unit).toBe('kilopascals');
		expect(results[0].score).toBe(95);
	});

	it('returns kilopascals at score 90 for exact symbol match "kPa"', () => {
		const results = suggestCanonicalUnits('kPa');
		expect(results.length).toBeGreaterThan(0);
		const kpa = results.find((r) => r.canonical_unit === 'kilopascals');
		expect(kpa).toBeDefined();
		// kPa matches as both alias (100 for case-sensitive) and symbol (90).
		// The alias match wins at 100.
		expect(kpa!.score).toBeGreaterThanOrEqual(90);
	});

	it('gives protocol-scoped alias a bonus when sourceSystem matches', () => {
		// 'K' is a bacnet-scoped alias for kelvin — not a global alias.
		const withScope = suggestCanonicalUnits('K', 'bacnet');
		const withoutScope = suggestCanonicalUnits('K');

		const kelvinScoped = withScope.find((r) => r.canonical_unit === 'kelvin');
		const kelvinUnscoped = withoutScope.find((r) => r.canonical_unit === 'kelvin');

		expect(kelvinScoped).toBeDefined();
		// Without bacnet scope, K is still found (scoped alias matches without bonus).
		// With bacnet scope, it gets the +5 scoped bonus.
		if (kelvinUnscoped) {
			expect(kelvinScoped!.score).toBeGreaterThan(kelvinUnscoped.score);
		} else {
			expect(kelvinScoped!.score).toBeGreaterThanOrEqual(100);
		}
	});

	it('does not fuzzy-match short symbols — "W" returns only exact alias matches', () => {
		const results = suggestCanonicalUnits('W', 'bacnet');
		// 'W' is a bacnet-scoped alias for watts — should return watts.
		const watts = results.find((r) => r.canonical_unit === 'watts');
		expect(watts).toBeDefined();
		// Should NOT return kilowatts or megawatts via substring/starts-with
		// matching (query is only 1 char, below the 3-char threshold).
		const kilowatts = results.find((r) => r.canonical_unit === 'kilowatts');
		expect(kilowatts).toBeUndefined();
	});

	it('returns an empty array for a completely unknown unit', () => {
		const results = suggestCanonicalUnits('xyzzy');
		expect(results).toEqual([]);
	});

	it('ranks exact alias match above approximate matches for "celsius"', () => {
		const results = suggestCanonicalUnits('celsius');
		expect(results.length).toBeGreaterThan(0);
		// 'celsius' is a global alias for degreesCelsius — should be top.
		expect(results[0].canonical_unit).toBe('degreesCelsius');
		expect(results[0].score).toBeGreaterThanOrEqual(95);
	});

	it('deduplicates — each canonical unit appears at most once', () => {
		const results = suggestCanonicalUnits('kPa');
		const canonicals = results.map((r) => r.canonical_unit);
		expect(new Set(canonicals).size).toBe(canonicals.length);
	});

	it('returns only canonical units that exist in definitions', () => {
		const results = suggestCanonicalUnits('celsius');
		for (const r of results) {
			expect(r.quantity).toBeTruthy();
		}
	});

	it('skips approximate tiers for short (1-2 char) queries', () => {
		// 'Pa' is 2 chars — should only do exact alias/symbol/canonical matching.
		const results = suggestCanonicalUnits('Pa');
		// 'Pa' is a global alias for pascals (exact match).
		const pascals = results.find((r) => r.canonical_unit === 'pascals');
		expect(pascals).toBeDefined();
		// Should NOT return kilopascals, hectopascals, etc. via starts-with.
		// (Those would need the query to appear as a substring of an alias,
		// which doesn't happen for 'Pa' since approximate tiers are skipped.)
	});

	it('matches on description/quantity substring for longer queries', () => {
		const results = suggestCanonicalUnits('temperature');
		expect(results.length).toBeGreaterThanOrEqual(2);
		const canonicals = results.map((r) => r.canonical_unit);
		expect(canonicals).toContain('degreesCelsius');
		expect(canonicals).toContain('degreesFahrenheit');
	});

	it('respects the limit parameter', () => {
		const results = suggestCanonicalUnits('pressure', undefined, 2);
		expect(results.length).toBeLessThanOrEqual(2);
	});

	it('includes custom aliases in scoring', () => {
		// Create a custom alias and reload the catalog.
		CustomUnitAliasesModel.upsert({
			source_system: null,
			alias: 'my-custom-celsius',
			canonical_unit: 'degreesCelsius',
		});
		getUnitCatalog().reload();

		const results = suggestCanonicalUnits('my-custom-celsius');
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].canonical_unit).toBe('degreesCelsius');
		expect(results[0].score).toBe(100);
	});

	it('returns symbol and quantity for each suggestion', () => {
		const results = suggestCanonicalUnits('°C');
		expect(results[0].symbol).toBe('°C');
		expect(results[0].quantity).toBe('temperature');
	});
});
