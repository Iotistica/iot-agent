import { UNIT_DEFINITIONS, UNIT_ALIASES, validateUnitCatalogSeed, type SeedUnitDefinition, type SeedUnitAlias } from '../../../src/data/unit-catalog-seed';

describe('unit catalog seed data', () => {
	it('the real shipped seed dataset is internally consistent', () => {
		const errors = validateUnitCatalogSeed();
		expect(errors).toEqual([]);
	});

	it('covers all 19 required quantities', () => {
		const requiredQuantities = [
			'temperature', 'pressure', 'airflow', 'liquidFlow', 'velocity', 'power', 'energy',
			'voltage', 'current', 'frequency', 'time', 'percentage', 'relativeHumidity',
			'concentration', 'length', 'area', 'volume', 'mass',
		];
		const seededQuantities = new Set(UNIT_DEFINITIONS.map((d) => d.quantity));
		for (const q of requiredQuantities) {
			expect(seededQuantities.has(q)).toBe(true);
		}
	});

	it('has no global single-character alias', () => {
		const offenders = UNIT_ALIASES.filter((a) => a.source_system === null && a.alias.trim().length === 1);
		expect(offenders).toEqual([]);
	});

	describe('validateUnitCatalogSeed catches synthetic breakage', () => {
		const goodDefs: SeedUnitDefinition[] = [
			{ canonical_unit: 'degreesCelsius', quantity: 'temperature', base_unit: 'degreesCelsius', multiplier: 1, offset: 0 },
			{ canonical_unit: 'degreesFahrenheit', quantity: 'temperature', base_unit: 'degreesCelsius', multiplier: 5 / 9, offset: -17.7777777778 },
		];

		it('flags a base_unit that references a nonexistent row', () => {
			const errors = validateUnitCatalogSeed(
				[{ canonical_unit: 'x', quantity: 'q', base_unit: 'does-not-exist', multiplier: 1, offset: 0 }],
				[],
			);
			expect(errors.some((e) => /unknown base_unit/.test(e))).toBe(true);
		});

		it('flags a quantity with zero base units', () => {
			const errors = validateUnitCatalogSeed(
				[
					{ canonical_unit: 'a', quantity: 'q', base_unit: 'z', multiplier: 1, offset: 0 },
					{ canonical_unit: 'z', quantity: 'other', base_unit: 'z', multiplier: 1, offset: 0 },
				],
				[],
			);
			expect(errors.some((e) => /no base unit/.test(e))).toBe(true);
		});

		it('flags a quantity with more than one base unit', () => {
			const errors = validateUnitCatalogSeed(
				[
					{ canonical_unit: 'a', quantity: 'q', base_unit: 'a', multiplier: 1, offset: 0 },
					{ canonical_unit: 'b', quantity: 'q', base_unit: 'b', multiplier: 1, offset: 0 },
				],
				[],
			);
			expect(errors.some((e) => /more than one base unit/.test(e))).toBe(true);
		});

		it('flags a definition whose quantity disagrees with its base unit\'s quantity', () => {
			const errors = validateUnitCatalogSeed(
				[
					{ canonical_unit: 'a', quantity: 'q1', base_unit: 'a', multiplier: 1, offset: 0 },
					{ canonical_unit: 'b', quantity: 'q2', base_unit: 'a', multiplier: 1, offset: 0 },
				],
				[],
			);
			expect(errors.some((e) => /whose quantity is/.test(e))).toBe(true);
		});

		it('flags a zero multiplier', () => {
			const errors = validateUnitCatalogSeed(
				[{ canonical_unit: 'a', quantity: 'q', base_unit: 'a', multiplier: 0, offset: 0 }],
				[],
			);
			expect(errors.some((e) => /invalid multiplier/.test(e))).toBe(true);
		});

		it('flags a non-finite offset', () => {
			const errors = validateUnitCatalogSeed(
				[{ canonical_unit: 'a', quantity: 'q', base_unit: 'a', multiplier: 1, offset: Infinity }],
				[],
			);
			expect(errors.some((e) => /non-finite offset/.test(e))).toBe(true);
		});

		it('flags an alias pointing at an unknown canonical_unit', () => {
			const errors = validateUnitCatalogSeed(goodDefs, [{ source_system: null, alias: 'xyz', canonical_unit: 'not-a-unit' }]);
			expect(errors.some((e) => /unknown canonical_unit/.test(e))).toBe(true);
		});

		it('flags a global single-character alias', () => {
			const errors = validateUnitCatalogSeed(goodDefs, [{ source_system: null, alias: 'C', canonical_unit: 'degreesCelsius' }]);
			expect(errors.some((e) => /single character/.test(e))).toBe(true);
		});

		it('flags a duplicate (source_system, alias) pair', () => {
			const aliases: SeedUnitAlias[] = [
				{ source_system: 'mqtt', alias: 'foo', canonical_unit: 'degreesCelsius' },
				{ source_system: 'mqtt', alias: 'foo', canonical_unit: 'degreesFahrenheit' },
			];
			const errors = validateUnitCatalogSeed(goodDefs, aliases);
			expect(errors.some((e) => /Duplicate alias pair/.test(e))).toBe(true);
		});

		it('flags an ambiguous global alias (same alias, different canonical units)', () => {
			const aliases: SeedUnitAlias[] = [
				{ source_system: null, alias: 'foobar', canonical_unit: 'degreesCelsius' },
				{ source_system: null, alias: 'foobar', canonical_unit: 'degreesFahrenheit' },
			];
			const errors = validateUnitCatalogSeed(goodDefs, aliases);
			expect(errors.some((e) => /Ambiguous global alias/.test(e))).toBe(true);
		});

		it('does not flag the same alias string scoped to two different source systems mapping to different units', () => {
			const aliases: SeedUnitAlias[] = [
				{ source_system: 'bacnet', alias: 'x', canonical_unit: 'degreesCelsius' },
				{ source_system: 'mqtt', alias: 'x', canonical_unit: 'degreesFahrenheit' },
			];
			const errors = validateUnitCatalogSeed(goodDefs, aliases);
			expect(errors.some((e) => /Ambiguous/.test(e))).toBe(false);
		});

		it('passes clean data with no errors', () => {
			expect(validateUnitCatalogSeed(goodDefs, [{ source_system: null, alias: 'celsius', canonical_unit: 'degreesCelsius' }])).toEqual([]);
		});
	});
});
