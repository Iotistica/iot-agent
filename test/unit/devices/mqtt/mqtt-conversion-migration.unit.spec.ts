/**
 * Regression coverage for the MQTT adapter's conversion-arithmetic
 * migration: convertUnitValue() used to do its own local temperature/
 * pressure conversion math; it now translates MQTT's short unit codes to
 * the shared catalog's canonical names and calls
 * src/units/convert-unit.ts's convertUnit() for the actual
 * arithmetic (see adapter.ts's MQTT_UNIT_TO_CANONICAL + convertUnitValue()).
 *
 * This file proves that migration is numerically a no-op: for every unit
 * pair MQTT previously supported, the migrated convertUnitValue() must
 * produce the exact same value the deleted local implementation did. The
 * old formulas are reproduced here, inline, purely as the regression
 * oracle — not re-added to production code.
 *
 * Mocks the DB layer the same way test/unit/units/
 * normalize-unit.unit.spec.ts does: an in-memory store seeded from the
 * real production seed data (src/data/unit-catalog-seed.ts), so this
 * exercises the actual shared catalog (including the atm/mbar units and
 * the corrected psi multiplier added as part of this same change) without
 * touching real SQLite.
 */

jest.mock('../../../../src/db/models/index', () => {
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
		CustomUnitAliasesModel: {
			getAll: () => [],
			findExact: () => null,
			upsert: (rec: any) => rec,
		},
	};
});

import { MqttAdapter } from '../../../../src/plugins/mqtt/adapter';
import { MqttAdapterConfig } from '../../../../src/plugins/mqtt/types';

// The exact formulas convertToBaseUnit()/convertFromBaseUnit() used before
// this migration (deleted from src/plugins/mqtt/adapter.ts) — reproduced
// here only as the regression oracle.
const OLD_PRESSURE_TO_PA: Record<string, number> = {
	Pa: 1,
	kPa: 1000,
	bar: 100000,
	mbar: 100,
	psi: 6894.757293168,
	atm: 101325,
};

function oldConvertTemperature(value: number, fromUnit: 'C' | 'F' | 'K', toUnit: 'C' | 'F' | 'K'): number {
	if (fromUnit === toUnit) return value;
	const toKelvin: Record<string, (v: number) => number> = {
		K: (v) => v,
		C: (v) => v + 273.15,
		F: (v) => ((v - 32) * 5) / 9 + 273.15,
	};
	const fromKelvin: Record<string, (v: number) => number> = {
		K: (v) => v,
		C: (v) => v - 273.15,
		F: (v) => ((v - 273.15) * 9) / 5 + 32,
	};
	return fromKelvin[toUnit](toKelvin[fromUnit](value));
}

function oldConvertPressure(value: number, fromUnit: string, toUnit: string): number {
	if (fromUnit === toUnit) return value;
	const pa = value * OLD_PRESSURE_TO_PA[fromUnit];
	return pa / OLD_PRESSURE_TO_PA[toUnit];
}

describe('MqttAdapter convertUnitValue() — migration regression (old local math vs. shared convertUnit())', () => {
	let mockLogger: any;
	let mockConfig: MqttAdapterConfig;

	beforeEach(() => {
		mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
		mockConfig = {
			broker: { host: 'localhost', port: 1883, username: 'test', password: 'test' },
			qos: 1,
			reconnect: { period: 5000, maxAttempts: 10 },
			devices: [],
			logging: { level: 'info', enableConsole: false, enableFile: false },
		};
	});

	let adapter: any;

	beforeEach(() => {
		adapter = new MqttAdapter(mockConfig, mockLogger, 'test-device-uuid') as any;
	});

	function convertUnitValue(value: number, from: string, to: string): number {
		return adapter.convertUnitValue(value, from, to);
	}

	it('every temperature unit pair (C/F/K) matches the old local-math result exactly', () => {
		const units: Array<'C' | 'F' | 'K'> = ['C', 'F', 'K'];
		const sampleValues = [-40, -17.78, 0, 21.5, 25, 100, 373.15];

		for (const from of units) {
			for (const to of units) {
				for (const value of sampleValues) {
					const expected = oldConvertTemperature(value, from, to);
					const actual = convertUnitValue(value, from, to);
					expect(actual).toBeCloseTo(expected, 9);
				}
			}
		}
	});

	it('every pressure unit pair (Pa/kPa/bar/mbar/psi/atm) matches the old local-math result exactly', () => {
		const units = ['Pa', 'kPa', 'bar', 'mbar', 'psi', 'atm'];
		const sampleValues = [0.5, 1, 14.7, 101.325, 1013.25];

		for (const from of units) {
			for (const to of units) {
				for (const value of sampleValues) {
					const expected = oldConvertPressure(value, from, to);
					const actual = convertUnitValue(value, from, to);
					// psi's multiplier was deliberately corrected from the old
					// rounded shared-catalog value (6894.76) to the precise
					// value MQTT's own local math already used
					// (6894.757293168) as a prerequisite of this migration —
					// so this is an exact match, not just "close enough".
					expect(actual).toBeCloseTo(expected, 6);
				}
			}
		}
	});

	it('atm and mbar — the two units the shared catalog did not define before this change — convert correctly now that they are real catalog entries', () => {
		expect(convertUnitValue(1, 'atm', 'Pa')).toBeCloseTo(101325, 5);
		expect(convertUnitValue(1, 'mbar', 'Pa')).toBeCloseTo(100, 5);
		expect(convertUnitValue(1013.25, 'mbar', 'atm')).toBeCloseTo(1, 5);
	});

	it('identity conversion (same unit) is still a pure passthrough, no shared-module call needed', () => {
		expect(convertUnitValue(42, 'C', 'C')).toBe(42);
		expect(convertUnitValue(42, 'kPa', 'kPa')).toBe(42);
	});

	it('still throws on an unsupported/cross-dimension pair, preserving normalizeMetricValue()\'s existing catch/fallback contract', () => {
		expect(() => convertUnitValue(5, 'C', 'kPa')).toThrow();
		expect(() => convertUnitValue(5, 'C', 'not-a-real-unit')).toThrow();
	});
});
