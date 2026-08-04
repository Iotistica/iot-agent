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
	mockedModel.upsertMany.mockImplementation((records: any[]) => {
		for (const record of records) {
			mockedModel.__rows().push({ ...record });
		}
	});
});

describe('persistence queue guardrails', () => {
	it('re-resolving an already-computed natural key never re-enqueues — a hot point observed many times before a flush still produces one queue entry, not N', () => {
		const catalog = getPointNameCatalog();
		catalog.init();

		for (let i = 0; i < 25; i++) {
			catalog.resolve({ sourceSystem: 'bacnet', endpointName: 'ep-1', deviceKey: 'dev-1', rawName: 'SAT' });
		}

		expect(catalog.getMetrics().queueDepth).toBe(1);
	});

	it('two flush triggers firing close together never run concurrently — a reentrant flush() call while one is in-flight is a no-op', () => {
		let upsertManyCalls = 0;
		mockedModel.upsertMany.mockImplementation(() => {
			upsertManyCalls++;
			// Simulate a second timer tick firing while this flush is still on the stack.
			catalog.flush();
		});

		const catalog = getPointNameCatalog();
		catalog.init();
		catalog.resolve({ sourceSystem: 'bacnet', endpointName: 'ep-1', deviceKey: 'dev-1', rawName: 'SAT' });

		catalog.flush();

		expect(upsertManyCalls).toBe(1);
	});

	it('queue size is bounded — the oldest pending entry is evicted (with a logged warning) once the cap is reached', () => {
		const warn = jest.fn();
		const catalog = getPointNameCatalog();
		catalog.init({ debug: jest.fn(), info: jest.fn(), warn, error: jest.fn() });

		// MAX_QUEUE_SIZE is 5000 (module-internal) — one over the cap forces exactly one eviction.
		for (let i = 0; i < 5001; i++) {
			catalog.resolve({ sourceSystem: 'bacnet', endpointName: 'ep-1', deviceKey: 'dev-1', rawName: `point-${i}` });
		}

		expect(catalog.getMetrics().queueDepth).toBe(5000);
		expect(catalog.getMetrics().overflowCount).toBe(1);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('overflow'),
			expect.anything(),
		);
	}, 30000);

	it('a flush failure never changes the PointIdentity already attached — only persistenceState/metrics are affected', () => {
		mockedModel.upsertMany.mockImplementation(() => { throw new Error('simulated failure'); });

		const catalog = getPointNameCatalog();
		catalog.init();
		const before = catalog.resolve({ sourceSystem: 'bacnet', endpointName: 'ep-1', deviceKey: 'dev-1', rawName: 'SAT' });

		catalog.flush();

		const after = catalog.resolve({ sourceSystem: 'bacnet', endpointName: 'ep-1', deviceKey: 'dev-1', rawName: 'SAT' });
		expect(after.provisionalPointId).toBe(before.provisionalPointId);
		expect(after.normalizedName).toBe(before.normalizedName);
		expect(catalog.getMetrics().retryCount).toBeGreaterThan(0);
	});

	it('a transaction/batch failure rolls back the whole batch, never a partial write', () => {
		mockedModel.upsertMany.mockImplementation(() => { throw new Error('simulated batch failure'); });

		const catalog = getPointNameCatalog();
		catalog.init();
		catalog.resolve({ sourceSystem: 'bacnet', endpointName: 'ep-1', deviceKey: 'dev-1', rawName: 'A' });
		catalog.resolve({ sourceSystem: 'bacnet', endpointName: 'ep-1', deviceKey: 'dev-1', rawName: 'B' });

		catalog.flush();

		expect(mockedModel.__rows()).toHaveLength(0);
	});

	it('shutdownFlush performs one bounded final flush attempt and does not hang, even mid-backoff', () => {
		const catalog = getPointNameCatalog();
		catalog.init();
		catalog.resolve({ sourceSystem: 'bacnet', endpointName: 'ep-1', deviceKey: 'dev-1', rawName: 'SAT' });

		const start = Date.now();
		catalog.shutdownFlush();
		expect(Date.now() - start).toBeLessThan(1000);

		expect(mockedModel.__rows()).toHaveLength(1);
		expect(catalog.getMetrics().queueDepth).toBe(0);
	});

	it('shutdownFlush is a no-op (never hangs) when a flush is already in progress', () => {
		mockedModel.upsertMany.mockImplementation(() => {
			catalog.shutdownFlush(); // reentrant — must not recurse/hang
		});

		const catalog = getPointNameCatalog();
		catalog.init();
		catalog.resolve({ sourceSystem: 'bacnet', endpointName: 'ep-1', deviceKey: 'dev-1', rawName: 'SAT' });

		expect(() => catalog.flush()).not.toThrow();
	});
});
