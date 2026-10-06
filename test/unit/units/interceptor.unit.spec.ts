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
		CustomUnitAliasesModel: {
			getAll: () => [],
			findExact: () => null,
			upsert: (rec: any) => rec,
		},
	};
});

import { createUnitNormalizationInterceptor } from '../../../src/units/interceptor';

describe('unitNormalizationInterceptor', () => {
	const interceptor = createUnitNormalizationInterceptor();

	it('normalizes a flat-shape reading in place', () => {
		const messages = [{ protocol: 'bacnet', metric: 'temp', value: 21.5, unit: '°C' }];
		const result = interceptor(messages, 'endpoint-1') as any[];

		expect(result).toBe(messages); // same array reference
		expect(result[0].unit).toBe('degreesCelsius');
		expect(result[0].unitValue).toEqual({
			rawValue: 21.5, rawUnit: '°C',
			value: 21.5, unit: 'degreesCelsius',
			quantity: 'temperature', normalized: true, converted: false,
			// Facts-only provenance (no confidence — that's the quality layer's job, see src/quality/confidence-policy.ts).
			// '°C' is a bacnet-scoped alias here (protocol: 'bacnet' on the message).
			provenance: { method: 'scoped-alias', sourceSystem: 'bacnet' },
		});
	});

	it('normalizes every reading inside a {readings: [...]} wrapper message', () => {
		const messages = [{
			protocol: 'modbus',
			readings: [
				{ metric: 'temp', value: 20, unit: 'C' },
				{ metric: 'pressure', value: 100, unit: 'kPa' },
			],
		}];
		const result = interceptor(messages, 'endpoint-1') as any[];

		expect(result[0].readings[0].unit).toBe('degreesCelsius');
		expect(result[0].readings[1].unit).toBe('kilopascals');
	});

	it('handles a mixed array of flat and wrapper messages', () => {
		const messages = [
			{ protocol: 'opcua', metric: 'x', value: 1, unit: '°C' },
			{ protocol: 'modbus', readings: [{ metric: 'y', value: 2, unit: 'kPa' }] },
		];
		const result = interceptor(messages, 'endpoint-1') as any[];

		expect(result[0].unit).toBe('degreesCelsius');
		expect(result[1].readings[0].unit).toBe('kilopascals');
	});

	it('leaves a reading with a non-numeric value untouched', () => {
		const messages = [{ metric: 'x', value: 'not-a-number', unit: '°C' }];
		const result = interceptor(messages, 'endpoint-1') as any[];
		expect(result[0].unit).toBe('°C');
		expect(result[0].unitValue).toBeUndefined();
	});

	it('leaves a reading with no unit untouched', () => {
		const messages = [{ metric: 'x', value: 5 }];
		const result = interceptor(messages, 'endpoint-1') as any[];
		expect(result[0].unitValue).toBeUndefined();
		expect(result[0].unit).toBeUndefined();
	});

	it('treats "---" as "no unit" rather than an unrecognized unit (PM556x\'s own placeholder for status/logic registers)', () => {
		const messages = [{ metric: 'x', value: 5, unit: '---' }];
		const result = interceptor(messages, 'endpoint-1') as any[];
		expect(result[0].unitValue).toBeUndefined();
		expect(result[0].unit).toBe('---');
	});

	it('leaves .unit as the original string and quantity undefined for an unresolved unit', () => {
		const messages = [{ metric: 'x', value: 5, unit: 'wibbles' }];
		const result = interceptor(messages, 'endpoint-1') as any[];
		expect(result[0].unit).toBe('wibbles');
		expect(result[0].unitValue.normalized).toBe(false);
		expect(result[0].unitValue.quantity).toBeUndefined();
	});

	it('scopes alias resolution to the reading\'s own protocol field', () => {
		const messages = [{ protocol: 'mqtt', metric: 'x', value: 22.2, unit: 'C' }];
		const result = interceptor(messages, 'endpoint-1') as any[];
		expect(result[0].unit).toBe('degreesCelsius');
	});

	describe('unitValue.provenance is facts-only (no confidence — quality layer\'s responsibility)', () => {
		it('exact-canonical: rawUnit already a canonical name', () => {
			const messages = [{ metric: 'x', value: 21.5, unit: 'degreesCelsius' }];
			const result = interceptor(messages, 'endpoint-1') as any[];
			expect(result[0].unitValue.provenance).toEqual({ method: 'exact-canonical' });
		});

		it('scoped-alias: resolved via a protocol-scoped alias', () => {
			const messages = [{ protocol: 'bacnet', metric: 'x', value: 21.5, unit: '°C' }];
			const result = interceptor(messages, 'endpoint-1') as any[];
			expect(result[0].unitValue.provenance).toEqual({ method: 'scoped-alias', sourceSystem: 'bacnet' });
		});

		it('global-alias: resolved via a global alias, no protocol scoping', () => {
			const messages = [{ metric: 'x', value: 21.5, unit: 'celsius' }];
			const result = interceptor(messages, 'endpoint-1') as any[];
			expect(result[0].unitValue.provenance).toEqual({ method: 'global-alias', sourceSystem: null });
		});

		it('unresolved: no alias match', () => {
			const messages = [{ metric: 'x', value: 21.5, unit: 'wibbles' }];
			const result = interceptor(messages, 'endpoint-1') as any[];
			expect(result[0].unitValue.provenance).toEqual({ method: 'unresolved' });
		});

		it('never carries a confidence field, for any resolution path', () => {
			const messages = [
				{ metric: 'a', value: 1, unit: 'degreesCelsius' },
				{ protocol: 'bacnet', metric: 'b', value: 2, unit: '°C' },
				{ metric: 'c', value: 3, unit: 'celsius' },
				{ metric: 'd', value: 4, unit: 'wibbles' },
			];
			const result = interceptor(messages, 'endpoint-1') as any[];
			for (const reading of result) {
				expect(reading.unitValue.provenance).not.toHaveProperty('confidence');
			}
		});
	});
});

// The on/off toggle (admin Settings → Features → "Unit Normalization",
// 2026-10-04) — readings must pass through raw and untouched when disabled,
// and the live .setEnabled() mechanism is what src/init/core.ts's
// 'features-changed' handler depends on to toggle this without a restart.
describe('unitNormalizationInterceptor — enabled/disabled toggle', () => {
	it('with no enabled option (existing default), behaves exactly as enabled — unchanged from before this feature', () => {
		const interceptor = createUnitNormalizationInterceptor();
		const messages = [{ protocol: 'bacnet', metric: 'x', value: 21.5, unit: '°C' }];
		const result = interceptor(messages, 'endpoint-1') as any[];
		expect(result[0].unit).toBe('degreesCelsius');
		expect(result[0].unitValue).toBeDefined();
	});

	it('constructed with enabled: false leaves the reading raw and untouched — no catalog lookup, no unitValue', () => {
		const interceptor = createUnitNormalizationInterceptor({ enabled: false });
		const messages = [{ protocol: 'bacnet', metric: 'x', value: 21.5, unit: '°C' }];
		const result = interceptor(messages, 'endpoint-1') as any[];
		expect(result[0].unit).toBe('°C'); // untouched, not normalized to degreesCelsius
		expect(result[0].unitValue).toBeUndefined();
	});

	it('.setEnabled(false) on an already-built interceptor disables it live', () => {
		const interceptor = createUnitNormalizationInterceptor({ enabled: true });
		interceptor.setEnabled(false);
		const messages = [{ protocol: 'bacnet', metric: 'x', value: 21.5, unit: '°C' }];
		const result = interceptor(messages, 'endpoint-1') as any[];
		expect(result[0].unit).toBe('°C');
		expect(result[0].unitValue).toBeUndefined();
	});

	it('.setEnabled(true) re-enables an interceptor that was constructed/toggled disabled', () => {
		const interceptor = createUnitNormalizationInterceptor({ enabled: false });
		interceptor.setEnabled(true);
		const messages = [{ protocol: 'bacnet', metric: 'x', value: 21.5, unit: '°C' }];
		const result = interceptor(messages, 'endpoint-1') as any[];
		expect(result[0].unit).toBe('degreesCelsius');
		expect(result[0].unitValue).toBeDefined();
	});
});
