// Covers catalog.resolve()'s actual device+point combining behavior
// (buildNormalizedPointName(), src/point-name/normalize-point-name.ts) —
// the current "v3" rules (CURRENT_POINT_NAME_RULES_VERSION in types.ts).
//
// This file previously asserted a "v2" design (stripDeviceNamePrefix(), a
// function that no longer exists) where a redundant device-name prefix was
// stripped OUT of the point name entirely — e.g. BACnet's "AHU-1.RF-Run"
// (device "AHU-1") normalizing to bare "rf_run". The shipped v3 code does
// not do this: it COMBINES device + point (device_point), only omitting the
// device prefix when it's already a complete, redundant leading token in
// the point's own raw text. Combined names (e.g. "ahu_1_rf_run") are what
// every live protocol adapter and the Analytics UI are built around today
// — rewritten to match, per explicit confirmation (2026-10-03) rather than
// resurrecting device-prefix stripping.
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

describe('catalog.resolve() device+point combination (v3)', () => {
	it('combines device and point names, deduping only on a complete redundant prefix (BACnet convention)', () => {
		const catalog = getPointNameCatalog();
		catalog.init();

		const identity = catalog.resolve({
			sourceSystem: 'bacnet',
			endpointName: 'ep-1',
			deviceKey: '',
			rawName: 'AHU-1.RF-Run',
			rawDeviceName: 'AHU-1',
		});

		// The point's own raw text already starts with "AHU-1" (normalized:
		// "ahu_1_") — the complete device prefix is a redundant leading
		// token, so it isn't duplicated, but it's still present once.
		expect(identity.normalizedName).toBe('ahu_1_rf_run');
		expect(identity.rawName).toBe('AHU-1.RF-Run'); // always verbatim, regardless of normalizedName
	});

	it('combines device and point names for a domain-neutral example with no shared prefix at all', () => {
		const catalog = getPointNameCatalog();
		catalog.init();

		const identity = catalog.resolve({
			sourceSystem: 'modbus',
			endpointName: 'ep-1',
			deviceKey: '',
			rawName: 'Status',
			rawDeviceName: 'Pump 01',
		});

		// No false-positive stripping: the point's raw text doesn't contain
		// the device name at all, so device+point are simply combined.
		expect(identity.normalizedName).toBe('pump_01_status');
	});

	it('provisionalPointId is derived from the full rawName, independent of how normalizedName was combined', () => {
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

	it('is a no-op combination when no device name is supplied (e.g. OPC-UA readings that do not pass rawDeviceName)', () => {
		const catalog = getPointNameCatalog();
		catalog.init();

		const identity = catalog.resolve({
			sourceSystem: 'opcua',
			endpointName: 'ep-1',
			deviceKey: 'dev-1',
			rawName: 'cc-valve',
		});

		expect(identity.normalizedName).toBe('cc_valve');
	});

	it('two different devices (distinct deviceKey) never collide even when they produce the identical normalizedName — collision tracking is scoped per (endpoint, deviceKey)', () => {
		const catalog = getPointNameCatalog();
		catalog.init();

		// Same bare point name, no rawDeviceName on either side, so both
		// normalize identically — but deviceKey differs, which is its own
		// axis of uniqueness (baseKey/collision tracking is scoped by
		// endpoint+deviceKey+base, not a single flat namespace).
		const a = catalog.resolve({ sourceSystem: 'opcua', endpointName: 'ep-1', deviceKey: 'pump-a', rawName: 'status' });
		const b = catalog.resolve({ sourceSystem: 'opcua', endpointName: 'ep-1', deviceKey: 'pump-b', rawName: 'status' });

		expect(a.normalizedName).toBe('status');
		expect(b.normalizedName).toBe('status');
		expect(a.provisionalPointId).not.toBe(b.provisionalPointId);
		expect(a.provenance.collisionSuffix).toBeUndefined();
		expect(b.provenance.collisionSuffix).toBeUndefined();
	});

	it('always combines device+point when the device name is not already a redundant prefix, even for an unrelated-looking raw name', () => {
		const catalog = getPointNameCatalog();
		catalog.init();

		const identity = catalog.resolve({
			sourceSystem: 'bacnet',
			endpointName: 'ep-1',
			deviceKey: '',
			rawName: 'Emergency-Test-Ok',
			rawDeviceName: 'AHU-1',
		});

		expect(identity.normalizedName).toBe('ahu_1_emergency_test_ok');
	});

	it('known, accepted v3 characteristic: a device name enriched with a UUID suffix downstream (AdapterManager.enrichWithEndpointUuid()) no longer exact-matches the point\'s own un-suffixed prefix, so dedup does not fire and the combined name looks doubled-up', () => {
		// This is the one case the abandoned v2 design (partial-token
		// tolerance) specifically handled more gracefully. v3's dedup is a
		// strict complete-prefix match — intentionally simple, per the
		// normalize-point-name.ts docstring ("Partial shared-token matching
		// is intentionally not used") — so this input produces an ugly but
		// correct, non-colliding, deterministic result. Documented here as
		// a known characteristic, not something this change fixes.
		const catalog = getPointNameCatalog();
		catalog.init();

		const zoneTemp = catalog.resolve({
			sourceSystem: 'bacnet',
			endpointName: 'ep-1',
			deviceKey: '',
			rawName: 'vav_f7_a_zone_temp',
			rawDeviceName: 'vav_f7_a_2041-d0f6e547',
		});

		expect(zoneTemp.normalizedName).toBe('vav_f7_a_2041_d0f6e547_vav_f7_a_zone_temp');
		expect(zoneTemp.rawName).toBe('vav_f7_a_zone_temp'); // still the true verbatim raw value
	});
});
