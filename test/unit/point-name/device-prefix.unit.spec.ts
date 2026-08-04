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
import { computeProvisionalPointId } from '../../../src/point-name/identity';
import { getPointNameCatalog, resetPointNameCatalogForTests } from '../../../src/point-name/catalog';

const mockedModel = PointNameMappingsModel as unknown as { __reset: () => void };

beforeEach(() => {
	mockedModel.__reset();
	resetPointNameCatalogForTests();
});

describe('catalog.resolve() with a device-name-prefixed raw name (BACnet convention)', () => {
	it('strips the device prefix from normalizedName but keeps rawName as the true verbatim value', () => {
		const catalog = getPointNameCatalog();
		catalog.init();

		const identity = catalog.resolve({
			sourceSystem: 'bacnet',
			endpointName: 'ep-1',
			deviceKey: '',
			rawName: 'AHU-1.RF-Run',
			rawDeviceName: 'AHU-1',
		});

		expect(identity.normalizedName).toBe('rf_run');
		expect(identity.rawName).toBe('AHU-1.RF-Run'); // unstripped — verbatim pre-normalization value
	});

	it('provisionalPointId is derived from the full unstripped rawName, unaffected by prefix stripping', () => {
		const catalog = getPointNameCatalog();
		catalog.init();

		const identity = catalog.resolve({
			sourceSystem: 'bacnet',
			endpointName: 'ep-1',
			deviceKey: '',
			rawName: 'AHU-1.RF-Run',
			rawDeviceName: 'AHU-1',
		});

		expect(identity.provisionalPointId).toBe(
			computeProvisionalPointId('bacnet', 'ep-1', '', 'AHU-1.RF-Run'),
		);
	});

	it('does not affect protocols whose raw names do not embed the device name (e.g. OPC-UA)', () => {
		const catalog = getPointNameCatalog();
		catalog.init();

		const identity = catalog.resolve({
			sourceSystem: 'opcua',
			endpointName: 'ep-1',
			deviceKey: 'dev-1',
			rawName: 'cc-valve',
			rawDeviceName: 'AHU-1',
		});

		expect(identity.normalizedName).toBe('cc_valve');
	});

	it('two devices with the same point name each get their own device-prefix stripped independently (no cross-device collision from stripping)', () => {
		const catalog = getPointNameCatalog();
		catalog.init();

		const a = catalog.resolve({ sourceSystem: 'bacnet', endpointName: 'ep-1', deviceKey: 'dev-a', rawName: 'AHU-1.RF-Run', rawDeviceName: 'AHU-1' });
		const b = catalog.resolve({ sourceSystem: 'bacnet', endpointName: 'ep-1', deviceKey: 'dev-b', rawName: 'AHU-2.RF-Run', rawDeviceName: 'AHU-2' });

		expect(a.normalizedName).toBe('rf_run');
		expect(b.normalizedName).toBe('rf_run'); // same normalized name on different devices is expected, not a collision
		expect(a.provisionalPointId).not.toBe(b.provisionalPointId);
	});

	it('a raw name without the device prefix on the same device still normalizes normally (no false-positive stripping)', () => {
		const catalog = getPointNameCatalog();
		catalog.init();

		const identity = catalog.resolve({
			sourceSystem: 'bacnet',
			endpointName: 'ep-1',
			deviceKey: '',
			rawName: 'Emergency-Test-Ok',
			rawDeviceName: 'AHU-1',
		});

		expect(identity.normalizedName).toBe('emergency_test_ok');
	});

	it('real-world shape: BACnet\'s already-sanitized metric ("vav_f7_a_zone_temp") against the pipeline\'s enriched, UUID-suffixed deviceName still strips correctly', () => {
		// Reproduces the exact bug report: reading.metric is already lowercase/
		// underscored by discovery.ts, and reading.deviceName by the time the
		// interceptor sees it is AdapterManager.enrichWithEndpointUuid()'s output
		// (device base name + a UUID-derived suffix the point's own name never had).
		const catalog = getPointNameCatalog();
		catalog.init();

		const zoneTemp = catalog.resolve({
			sourceSystem: 'bacnet',
			endpointName: 'ep-1',
			deviceKey: '',
			rawName: 'vav_f7_a_zone_temp',
			rawDeviceName: 'vav_f7_a_2041-d0f6e547',
		});
		const damperPos = catalog.resolve({
			sourceSystem: 'bacnet',
			endpointName: 'ep-1',
			deviceKey: '',
			rawName: 'vav_f7_a_damper_pos',
			rawDeviceName: 'vav_f7_a_2041-d0f6e547',
		});

		expect(zoneTemp.normalizedName).toBe('zone_temp');
		expect(damperPos.normalizedName).toBe('damper_pos');
		expect(zoneTemp.rawName).toBe('vav_f7_a_zone_temp'); // still the true verbatim raw value
	});
});
