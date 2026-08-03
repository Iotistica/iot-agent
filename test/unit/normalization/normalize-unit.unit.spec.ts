/**
 * Unit tests for normalizeUnitName() / convertUnit() / normalizeUnit().
 * Mocks the DB layer with an in-memory store seeded from the real seed
 * dataset — exercises actual production alias/conversion data without touching SQLite.
 */

jest.mock('../../../src/db/models/index', () => {
	const definitions = new Map<string, any>();
	const aliases = new Map<string, any>();

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
	};
});

import { normalizeUnitName } from '../../../src/normalization/normalize-unit-name';
import { convertUnit } from '../../../src/normalization/convert-unit';
import { normalizeUnit } from '../../../src/normalization/normalize-unit';

describe('normalizeUnitName', () => {
	it('resolves all of the spec\'s verbatim temperature aliases to degreesCelsius', () => {
		for (const alias of ['°C', 'degC', 'deg C', 'celsius']) {
			expect(normalizeUnitName(alias).unit).toBe('degreesCelsius');
		}
	});

	it('resolves all of the spec\'s verbatim pressure aliases to kilopascals', () => {
		for (const alias of ['kPa', 'KPA', 'kilopascals']) {
			expect(normalizeUnitName(alias).unit).toBe('kilopascals');
		}
	});

	it('resolves all of the spec\'s verbatim airflow aliases to cubicFeetPerMinute', () => {
		for (const alias of ['CFM', 'cfm', 'ft3/min']) {
			expect(normalizeUnitName(alias).unit).toBe('cubicFeetPerMinute');
		}
	});

	it('leaves the numeric value untouched during name normalization (spec requirement)', () => {
		const result = normalizeUnit(21.5, '°C');
		expect(result.unitValue.value).toBe(21.5);
		expect(result.unitValue.rawValue).toBe(21.5);
	});

	it('does not resolve a single-letter alias globally — only when scoped to a known source system', () => {
		expect(normalizeUnitName('C').normalized).toBe(false);
		expect(normalizeUnitName('C', 'mqtt').unit).toBe('degreesCelsius');
		expect(normalizeUnitName('C', 'modbus').unit).toBe('degreesCelsius');
	});

	it('scopes resolution to sourceSystem and falls back to global when no scoped match exists', () => {
		// 'kPa' has both a bacnet-scoped and a global alias — scoped takes priority.
		expect(normalizeUnitName('kPa', 'bacnet').unit).toBe('kilopascals');
		// A protocol with no 'kPa' alias of its own falls through to the global one.
		expect(normalizeUnitName('kPa', 'opcua').unit).toBe('kilopascals');
	});

	it('never throws on an unknown unit — returns normalized:false with the original string preserved', () => {
		expect(() => normalizeUnitName('wibbles')).not.toThrow();
		const result = normalizeUnitName('wibbles');
		expect(result.normalized).toBe(false);
		expect(result.unit).toBe('wibbles');
		expect(result.warning).toBeDefined();
	});

	it('is case-insensitive', () => {
		expect(normalizeUnitName('CELSIUS').unit).toBe('degreesCelsius');
		expect(normalizeUnitName('Celsius').unit).toBe('degreesCelsius');
	});
});

describe('convertUnit', () => {
	it('converts 72 degreesFahrenheit to ~22.222 degreesCelsius (spec example)', () => {
		const result = convertUnit(72, 'degreesFahrenheit', 'degreesCelsius');
		expect(result.converted).toBe(true);
		expect(result.value).toBeCloseTo(22.222, 2);
	});

	it('converts kilopascals to pascals', () => {
		const result = convertUnit(1, 'kilopascals', 'pascals');
		expect(result.value).toBeCloseTo(1000, 5);
	});

	it('is the identity for base-unit-to-base-unit (or same-unit) conversion', () => {
		const result = convertUnit(5, 'degreesCelsius', 'degreesCelsius');
		expect(result.value).toBe(5);
		expect(result.converted).toBe(false);
	});

	it('rejects conversion between incompatible quantities without throwing', () => {
		expect(() => convertUnit(5, 'degreesCelsius', 'kilowatts')).not.toThrow();
		const result = convertUnit(5, 'degreesCelsius', 'kilowatts');
		expect(result.converted).toBe(false);
		expect(result.warning).toMatch(/incompatible/i);
	});

	it('reports a warning for an unknown canonical unit rather than throwing', () => {
		const result = convertUnit(5, 'degreesCelsius', 'not-a-real-unit');
		expect(result.converted).toBe(false);
		expect(result.warning).toBeDefined();
	});
});

describe('normalizeUnit (composed)', () => {
	it('composes name resolution + conversion when targetUnit is given', () => {
		const result = normalizeUnit(72, 'degreesFahrenheit', { targetUnit: 'degreesCelsius' });
		expect(result.unitValue.normalized).toBe(true);
		expect(result.unitValue.converted).toBe(true);
		expect(result.unitValue.value).toBeCloseTo(22.222, 2);
		expect(result.unitValue.unit).toBe('degreesCelsius');
	});

	it('honors alreadyConverted — never re-converts even when targetUnit is set', () => {
		const result = normalizeUnit(22.2, 'C', { sourceSystem: 'mqtt', alreadyConverted: true, targetUnit: 'kelvin' });
		expect(result.unitValue.unit).toBe('degreesCelsius');
		expect(result.unitValue.value).toBe(22.2); // untouched
		expect(result.unitValue.converted).toBe(false);
		expect(result.conversionStage).toBe('source-adapter');
	});

	it('leaves value/unit passthrough for an unresolved unit, quantity left undefined', () => {
		const result = normalizeUnit(5, 'wibbles');
		expect(result.unitValue.normalized).toBe(false);
		expect(result.unitValue.value).toBe(5);
		expect(result.unitValue.unit).toBe('wibbles');
		expect(result.unitValue.quantity).toBeUndefined();
	});
});
