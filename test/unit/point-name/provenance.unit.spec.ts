jest.mock('../../../src/db/models/index', () => {
	let rows: any[] = [];
	return {
		PointNameMappingsModel: {
			getAll: jest.fn(() => rows.map((r) => ({ ...r }))),
			upsertMany: jest.fn((records: any[]) => {
				for (const record of records) {
					const idx = rows.findIndex((r) =>
						r.source_system === (record.source_system ?? null)
						&& r.endpoint_name === record.endpoint_name
						&& r.device_key === record.device_key
						&& r.raw_name === record.raw_name);
					if (idx >= 0) rows[idx] = { ...record };
					else rows.push({ ...record });
				}
			}),
			__reset: () => { rows = []; },
			__rows: () => rows,
		},
	};
});

import { PointNameMappingsModel } from '../../../src/db/models/index';
import { getPointNameCatalog, resetPointNameCatalogForTests } from '../../../src/point-name/catalog';

const mockedModel = PointNameMappingsModel as unknown as {
	__reset: () => void;
	__rows: () => any[];
	upsertMany: jest.Mock;
};

beforeEach(() => {
	mockedModel.__reset();
	resetPointNameCatalogForTests();
	// Individual tests (e.g. the retry-exhaustion one) may override this to
	// simulate a failing DB — restore the working default before every test.
	mockedModel.upsertMany.mockImplementation((records: any[]) => {
		const rows = mockedModel.__rows();
		for (const record of records) {
			const idx = rows.findIndex((r) =>
				r.source_system === (record.source_system ?? null)
				&& r.endpoint_name === record.endpoint_name
				&& r.device_key === record.device_key
				&& r.raw_name === record.raw_name);
			if (idx >= 0) rows[idx] = { ...record };
			else rows.push({ ...record });
		}
	});
});

describe('provenance: method vs. resolutionSource vs. persistenceState', () => {
	it('a freshly computed mapping is method:algorithmic, resolutionSource:runtime-generated, persistenceState:pending', () => {
		const catalog = getPointNameCatalog();
		catalog.init();

		const identity = catalog.resolve({ sourceSystem: 'bacnet', endpointName: 'ep-1', deviceKey: 'dev-1', rawName: 'SAT' });
		expect(identity.provenance.method).toBe('algorithmic');
		expect(identity.provenance.resolutionSource).toBe('runtime-generated');
		expect(identity.provenance.persistenceState).toBe('pending');
	});

	it('persistenceState transitions pending -> persisted after a successful flush, method unchanged', () => {
		const catalog = getPointNameCatalog();
		catalog.init();

		catalog.resolve({ sourceSystem: 'bacnet', endpointName: 'ep-1', deviceKey: 'dev-1', rawName: 'SAT' });
		catalog.flush();

		const identity = catalog.resolve({ sourceSystem: 'bacnet', endpointName: 'ep-1', deviceKey: 'dev-1', rawName: 'SAT' });
		expect(identity.provenance.persistenceState).toBe('persisted');
		expect(identity.provenance.method).toBe('algorithmic');
	});

	it('persistenceState transitions pending -> failed after exhausting bounded retries, without changing the identity already attached', () => {
		mockedModel.upsertMany.mockImplementation(() => { throw new Error('simulated DB failure'); });

		const catalog = getPointNameCatalog();
		catalog.init();

		const originalIdentity = catalog.resolve({ sourceSystem: 'bacnet', endpointName: 'ep-1', deviceKey: 'dev-1', rawName: 'SAT' });
		expect(originalIdentity.normalizedName).toBe('sat');

		catalog.flush(); // attempt 1 — fails, schedules backoff
		let after = catalog.resolve({ sourceSystem: 'bacnet', endpointName: 'ep-1', deviceKey: 'dev-1', rawName: 'SAT' });
		expect(after.provenance.persistenceState).toBe('pending');
		expect(after.normalizedName).toBe('sat'); // identity unaffected by the failure

		// Force past the backoff window for each subsequent attempt.
		const dateSpy = jest.spyOn(Date, 'now');
		let simulatedNow = Date.now();
		dateSpy.mockImplementation(() => simulatedNow);

		simulatedNow += 10_000;
		catalog.flush(); // attempt 2 — fails
		simulatedNow += 10_000;
		catalog.flush(); // attempt 3 — exhausts MAX_FLUSH_RETRIES, marks failed

		dateSpy.mockRestore();

		after = catalog.resolve({ sourceSystem: 'bacnet', endpointName: 'ep-1', deviceKey: 'dev-1', rawName: 'SAT' });
		expect(after.provenance.persistenceState).toBe('failed');
		expect(after.normalizedName).toBe('sat'); // still unaffected
		expect(mockedModel.__rows()).toHaveLength(0); // never actually written
	});

	it('a mapping loaded at startup preserves its original method and reports resolutionSource:persisted-cache, never a generic "persisted" method', () => {
		const catalog = getPointNameCatalog();
		catalog.init();
		catalog.resolve({ sourceSystem: 'bacnet', endpointName: 'ep-1', deviceKey: 'dev-1', rawName: 'SAT' });
		catalog.flush();

		// Simulate a restart: fresh catalog instance, preload from the (now
		// populated) mocked DB rows.
		resetPointNameCatalogForTests();
		const restarted = getPointNameCatalog();
		restarted.init();

		const identity = restarted.resolve({ sourceSystem: 'bacnet', endpointName: 'ep-1', deviceKey: 'dev-1', rawName: 'SAT' });
		expect(identity.provenance.method).toBe('algorithmic');
		expect(identity.provenance.resolutionSource).toBe('persisted-cache');
		expect(identity.provenance.persistenceState).toBe('persisted');
		expect(identity.provisionalPointId).toBeTruthy();
	});

	it('an unresolved mapping preserves method:unresolved across a simulated restart', () => {
		const catalog = getPointNameCatalog();
		catalog.init();
		catalog.resolve({ sourceSystem: 'bacnet', endpointName: 'ep-1', deviceKey: 'dev-1', rawName: '   ' });
		catalog.flush();

		resetPointNameCatalogForTests();
		const restarted = getPointNameCatalog();
		restarted.init();

		const identity = restarted.resolve({ sourceSystem: 'bacnet', endpointName: 'ep-1', deviceKey: 'dev-1', rawName: '   ' });
		expect(identity.provenance.method).toBe('unresolved');
		expect(identity.provenance.resolutionSource).toBe('persisted-cache');
	});
});
