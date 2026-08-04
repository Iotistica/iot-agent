jest.mock('../../../src/db/models/index', () => {
	let rows: any[] = [];
	return {
		PointNameMappingsModel: {
			getAll: jest.fn(() => rows.map((r) => ({ ...r }))),
			upsertMany: jest.fn((records: any[]) => {
				for (const record of records) rows.push({ ...record });
			}),
			__reset: () => { rows = []; },
		},
	};
});

import { PointNameMappingsModel } from '../../../src/db/models/index';
import { createPointNameNormalizationInterceptor } from '../../../src/point-name/interceptor';
import { resetPointNameCatalogForTests } from '../../../src/point-name/catalog';

const mockedModel = PointNameMappingsModel as unknown as { __reset: () => void };

beforeEach(() => {
	mockedModel.__reset();
	resetPointNameCatalogForTests();
});

describe('pointNameNormalizationInterceptor', () => {
	it('normalizes a flat-shape reading in place, leaving reading.metric/reading.name untouched', () => {
		const interceptor = createPointNameNormalizationInterceptor();
		const messages = [{ protocol: 'bacnet', metric: 'AHU-1 SAT', value: 21.5 }];
		const result = interceptor(messages, 'endpoint-1') as any[];

		expect(result).toBe(messages); // same array reference
		expect(result[0].metric).toBe('AHU-1 SAT'); // untouched
		expect(result[0].pointIdentity).toBeDefined();
		expect(result[0].pointIdentity.normalizedName).toBe('ahu_1_sat');
		expect(result[0].pointIdentity.rawName).toBe('AHU-1 SAT');
	});

	it('normalizes every reading inside a {readings: [...]} wrapper message', () => {
		const interceptor = createPointNameNormalizationInterceptor();
		const messages = [{
			protocol: 'modbus',
			readings: [
				{ metric: 'Zone Temp', value: 20 },
				{ metric: 'Supply Fan Status', value: true },
			],
		}];
		const result = interceptor(messages, 'endpoint-1') as any[];

		expect(result[0].readings[0].pointIdentity.normalizedName).toBe('zone_temp');
		expect(result[0].readings[1].pointIdentity.normalizedName).toBe('supply_fan_status');
		expect(result[0].readings[0].metric).toBe('Zone Temp');
	});

	it('handles a mixed array of flat and wrapper messages', () => {
		const interceptor = createPointNameNormalizationInterceptor();
		const messages = [
			{ protocol: 'opcua', metric: 'Temp-1', value: 1 },
			{ protocol: 'modbus', readings: [{ metric: 'Pressure-1', value: 2 }] },
		];
		const result = interceptor(messages, 'endpoint-1') as any[];

		expect(result[0].pointIdentity.normalizedName).toBe('temp_1');
		expect(result[1].readings[0].pointIdentity.normalizedName).toBe('pressure_1');
	});

	it('leaves a reading with no metric/name field untouched (no pointIdentity attached)', () => {
		const interceptor = createPointNameNormalizationInterceptor();
		const messages = [{ value: 5 }];
		const result = interceptor(messages, 'endpoint-1') as any[];
		expect(result[0].pointIdentity).toBeUndefined();
	});

	it('populates sourceAddress only when already present on the incoming reading, never fabricating it', () => {
		const interceptor = createPointNameNormalizationInterceptor();
		const withAddress = [{ metric: 'SAT', value: 1, sourceAddress: 'bacnet:1:AI:3' }];
		const withoutAddress = [{ metric: 'SAT', value: 1, deviceId: 'dev-2' }];

		const r1 = interceptor(withAddress, 'endpoint-1') as any[];
		const r2 = interceptor(withoutAddress, 'endpoint-1') as any[];

		expect(r1[0].pointIdentity.sourceAddress).toBe('bacnet:1:AI:3');
		expect(r2[0].pointIdentity.sourceAddress).toBeUndefined();
	});

	it('carries rawDeviceName through from message.deviceName when present', () => {
		const interceptor = createPointNameNormalizationInterceptor();
		const messages = [{ metric: 'SAT', value: 1, deviceName: 'AHU-1' }];
		const result = interceptor(messages, 'endpoint-1') as any[];
		expect(result[0].pointIdentity.rawDeviceName).toBe('AHU-1');
	});

	it('fault isolation: a malformed reading (non-extensible) is skipped without affecting other readings in the same batch', () => {
		const interceptor = createPointNameNormalizationInterceptor();
		const goodReading = { metric: 'Good', value: 1 };
		const malformedReading = Object.freeze({ metric: 'Bad', value: 2 }); // assigning .pointIdentity throws in strict mode
		const messages = [{ readings: [malformedReading, goodReading] }];

		expect(() => interceptor(messages, 'endpoint-1')).not.toThrow();
		expect((goodReading as any).pointIdentity).toBeDefined();
		expect((malformedReading as any).pointIdentity).toBeUndefined();
	});

	it('publish continues (returns the full messages array) even when a whole message would fail', () => {
		const interceptor = createPointNameNormalizationInterceptor();
		const malformedMessage = Object.freeze({ metric: 'X', value: 1 });
		const goodMessage = { metric: 'Y', value: 2 };
		const messages = [malformedMessage, goodMessage];

		const result = interceptor(messages, 'endpoint-1') as any[];
		expect(result).toHaveLength(2);
		expect((goodMessage as any).pointIdentity).toBeDefined();
	});
});
