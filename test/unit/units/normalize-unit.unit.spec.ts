/**
 * Unit tests for normalizeUnitName() / convertUnit() / normalizeUnit().
 * Mocks the DB layer with an in-memory store seeded from the real seed
 * dataset — exercises actual production alias/conversion data without touching SQLite.
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
		// Admin-created mappings (the dashboard "Resolve unit" action) — a
		// separate store, mirroring the real custom_unit_aliases table being
		// physically separate from unit_aliases.
		CustomUnitAliasesModel: {
			getAll: () => Array.from(customAliases.values()),
			findExact: (source: string | null, alias: string) => customAliases.get(`${source ?? ''}\0${alias}`) ?? null,
			upsert: (rec: any) => { customAliases.set(`${rec.source_system ?? ''}\0${rec.alias}`, rec); return rec; },
		},
	};
});

import { normalizeUnitName } from '../../../src/units/normalize-unit-name';
import { convertUnit } from '../../../src/units/convert-unit';
import { normalizeUnit } from '../../../src/units/normalize-unit';
import { CustomUnitAliasesModel } from '../../../src/db/models/index';
import { getUnitCatalog } from '../../../src/units/catalog';

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

	it('resolves a scoped alias the same way regardless of sourceSystem casing/whitespace', () => {
		for (const sourceSystem of ['MQTT', 'mqtt', ' MQTT ', ' mqtt ']) {
			expect(normalizeUnitName('C', sourceSystem).unit).toBe('degreesCelsius');
		}
	});

	it('resolves the newly-added atm/mbar pressure aliases', () => {
		expect(normalizeUnitName('atm').unit).toBe('atmospheres');
		expect(normalizeUnitName('ATM').unit).toBe('atmospheres');
		expect(normalizeUnitName('mbar').unit).toBe('millibars');
	});

	// Confirmed live against the OPC-UA simulator (profiles/loadtest-100-devices.json):
	// "V"/"A" are real EngineeringUnits symbols on Voltage-L1/Current-L1-style
	// points — previously unresolved for OPC-UA specifically (bacnet/mqtt
	// already had these scoped; opcua had no scoped aliases at all).
	it('resolves the newly-added opcua-scoped V/A electrical unit aliases', () => {
		expect(normalizeUnitName('V', 'opcua').unit).toBe('volts');
		expect(normalizeUnitName('A', 'opcua').unit).toBe('amperes');
	});

	it('V/A stay unresolved for opcua without the scope — single-character aliases are never global (decision #10)', () => {
		expect(normalizeUnitName('V').normalized).toBe(false);
		expect(normalizeUnitName('A').normalized).toBe(false);
	});

	// Confirmed live against a real PM556x power-meter Modbus profile —
	// same gap as opcua above, just for modbus (bacnet/mqtt/opcua already
	// had these scoped; modbus only had 'C' until now).
	it('resolves the newly-added modbus-scoped V/A electrical unit aliases', () => {
		expect(normalizeUnitName('V', 'modbus').unit).toBe('volts');
		expect(normalizeUnitName('A', 'modbus').unit).toBe('amperes');
	});

	it('resolves kVA/kVAr globally for any source system (multi-character, unambiguous — decision #10)', () => {
		expect(normalizeUnitName('kVA').unit).toBe('kilovoltAmperes');
		expect(normalizeUnitName('kVAr').unit).toBe('kilovoltAmperesReactive');
		expect(normalizeUnitName('kVA', 'modbus').unit).toBe('kilovoltAmperes');
		expect(normalizeUnitName('kVAr', 'modbus').unit).toBe('kilovoltAmperesReactive');
	});

	it('resolves kVArh (reactive energy) and PF (power factor) globally', () => {
		expect(normalizeUnitName('kVArh').unit).toBe('kilovoltAmpereHoursReactive');
		expect(normalizeUnitName('PF').unit).toBe('powerFactor');
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

	it('converts psi to pascals using the precise (not rounded) multiplier', () => {
		const result = convertUnit(1, 'psi', 'pascals');
		expect(result.converted).toBe(true);
		expect(result.value).toBeCloseTo(6894.757293168, 6);
	});

	it('converts the newly-added atm/mbar pressure units through the pascals hub', () => {
		expect(convertUnit(1, 'atmospheres', 'pascals').value).toBeCloseTo(101325, 5);
		expect(convertUnit(1, 'millibars', 'pascals').value).toBeCloseTo(100, 5);
		expect(convertUnit(1013.25, 'millibars', 'atmospheres').value).toBeCloseTo(1, 5);
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

// A failed/unsupported conversion must never corrupt, relabel, or discard
// the original measurement — value and unit must never become mismatched
// (e.g. a psi value must never end up paired with a "kPa" label unless the
// numeric value was actually converted). Added 2026-10-03.
describe('normalizeUnit — conversion-failure safety (value/unit never mismatched)', () => {
	it('1. supported conversion succeeds and updates both value and unit together', () => {
		const result = normalizeUnit(100, 'psi', { targetUnit: 'kilopascals' });
		expect(result.unitValue.converted).toBe(true);
		expect(result.unitValue.unit).toBe('kilopascals');
		expect(result.unitValue.value).toBeCloseTo(689.4757293168, 6);
		expect(result.unitValue.rawValue).toBe(100);
		expect(result.unitValue.rawUnit).toBe('psi');
	});

	it('2. unsupported/incompatible-quantity conversion preserves the original value/unit pair exactly — never relabels the raw value with the target unit', () => {
		// pressure -> temperature: incompatible quantities
		const result = normalizeUnit(100, 'psi', { targetUnit: 'degreesCelsius' });
		expect(result.unitValue.converted).toBe(false);
		expect(result.unitValue.value).toBe(100); // never partially converted
		expect(result.unitValue.unit).toBe('psi'); // never relabeled "degreesCelsius"
		expect(result.warning).toMatch(/incompatible/i);
	});

	it('3. cross-dimension conversion (pressure -> temperature) is the same incompatible-quantity case — explicit worked example from the spec', () => {
		const result = normalizeUnit(100, 'psi', { targetUnit: 'degreesCelsius' });
		expect(result.unitValue.value).toBe(100);
		expect(result.unitValue.unit).toBe('psi');
		expect(result.unitValue.converted).toBe(false);
	});

	it('4. unknown source unit preserves the original value/unit pair (never reaches conversion at all — name resolution fails first)', () => {
		const result = normalizeUnit(100, 'not-a-real-unit', { targetUnit: 'kilopascals' });
		expect(result.unitValue.normalized).toBe(false);
		expect(result.unitValue.converted).toBe(false);
		expect(result.unitValue.value).toBe(100);
		expect(result.unitValue.unit).toBe('not-a-real-unit');
		expect(result.unitValue.rawValue).toBe(100);
		expect(result.unitValue.rawUnit).toBe('not-a-real-unit');
	});

	it('5. unknown target unit preserves the original value/unit pair (source name resolves fine, conversion target does not exist)', () => {
		const result = normalizeUnit(100, 'psi', { targetUnit: 'not-a-real-unit' });
		expect(result.unitValue.converted).toBe(false);
		expect(result.unitValue.value).toBe(100);
		expect(result.unitValue.unit).toBe('psi'); // stays the source canonical unit, not the bad target
		expect(result.warning).toBeDefined();
	});

	it('6. a conversion failure still returns a usable unitValue — the reading is never dropped/undefined because conversion failed', () => {
		const result = normalizeUnit(100, 'psi', { targetUnit: 'degreesCelsius' });
		expect(result.unitValue).toBeDefined();
		expect(result.unitValue.value).not.toBeUndefined();
		expect(result.unitValue.unit).not.toBeUndefined();
	});

	it('7. rawValue/rawUnit are identical before and after, for both a successful and a failed conversion', () => {
		const success = normalizeUnit(100, 'psi', { targetUnit: 'kilopascals' });
		expect(success.unitValue.rawValue).toBe(100);
		expect(success.unitValue.rawUnit).toBe('psi');

		const failure = normalizeUnit(100, 'psi', { targetUnit: 'degreesCelsius' });
		expect(failure.unitValue.rawValue).toBe(100);
		expect(failure.unitValue.rawUnit).toBe('psi');
	});

	it('8. converted is true only when the numeric value actually changed via conversion', () => {
		// Name-only resolution (no targetUnit): converted stays false even
		// though normalization succeeded — nothing was numerically converted.
		const nameOnly = normalizeUnit(100, 'psi');
		expect(nameOnly.unitValue.normalized).toBe(true);
		expect(nameOnly.unitValue.converted).toBe(false);

		// Same unit as target: convertUnit() itself treats this as a no-op,
		// not a "conversion" — converted stays false (value is already in
		// the target unit, nothing was computed).
		const sameUnit = normalizeUnit(100, 'psi', { targetUnit: 'psi' });
		expect(sameUnit.unitValue.converted).toBe(false);

		// Genuinely converted:
		const converted = normalizeUnit(100, 'psi', { targetUnit: 'kilopascals' });
		expect(converted.unitValue.converted).toBe(true);
	});
});

// Admin-created custom unit aliases (the dashboard "Resolve unit" action,
// 2026-10-03) — a separate tier from the built-in catalog. Each test below
// uses its own made-up alias string, never one exercised by another
// describe block in this file, so these tests can't interfere with (or be
// affected by) the built-in-alias assertions above.
describe('custom unit aliases (admin "Resolve unit" mappings)', () => {
	it('resolvesViaBuiltIn() is true for an existing built-in alias, both scoped and global', () => {
		const catalog = getUnitCatalog();
		expect(catalog.resolvesViaBuiltIn('kPa')).toBe(true); // global built-in alias
		expect(catalog.resolvesViaBuiltIn('C', 'mqtt')).toBe(true); // mqtt-scoped built-in alias
	});

	it('resolvesViaBuiltIn() is false for a raw unit that has never been seen at all', () => {
		expect(getUnitCatalog().resolvesViaBuiltIn('totally-made-up-unit-never-seen')).toBe(false);
	});

	it('resolvesViaBuiltIn() stays false for an alias that only resolves via a custom mapping, even though normalizeUnitName() resolves it', () => {
		const catalog = getUnitCatalog();
		CustomUnitAliasesModel.upsert({ source_system: 'mqtt', alias: 'custom-widget-unit', canonical_unit: 'volts' });
		catalog.reload();

		expect(normalizeUnitName('custom-widget-unit', 'mqtt').unit).toBe('volts');
		expect(catalog.resolvesViaBuiltIn('custom-widget-unit', 'mqtt')).toBe(false);
	});

	it('a global custom alias resolves via normalizeUnitName() with no conflicting built-in alias for the same raw unit', () => {
		const catalog = getUnitCatalog();
		CustomUnitAliasesModel.upsert({ source_system: null, alias: 'my-custom-global-unit', canonical_unit: 'kilowatts' });
		catalog.reload();

		expect(normalizeUnitName('my-custom-global-unit').unit).toBe('kilowatts');
		expect(normalizeUnitName('my-custom-global-unit').normalized).toBe(true);
	});
});
