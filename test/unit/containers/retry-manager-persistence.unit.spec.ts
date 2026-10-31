const rows = new Map<string, any>();
const model = {
	getAll: jest.fn(() => [...rows.values()]),
	upsert: jest.fn((r: any) => { rows.set(r.key, { ...r }); }),
	delete: jest.fn((k: string) => { rows.delete(k); }),
	clearAll: jest.fn(() => rows.clear()),
};
jest.mock('../../../src/db/models', () => ({ RetryStateModel: model }));

import { RetryManager } from '../../../src/containers/retry-manager';
import { pruneObsoleteServiceRetries, serviceRetryKey } from '../../../src/containers/state-helpers';
import type { ContainerService } from '../../../src/containers/container-manager';

const svc = (env: string): ContainerService => ({
	serviceId: 1, serviceName: 's', imageName: 'img', appId: 10, appName: 'a',
	config: { image: 'img', environment: { V: env } },
} as ContainerService);
const flush = () => new Promise((r) => setImmediate(r));

describe('RetryManager persistence across agent restart', () => {
	beforeEach(() => { rows.clear(); jest.clearAllMocks(); });

	it('restores count, backoff and terminal state after restart', async () => {
		const a = new RetryManager();
		const key = serviceRetryKey(10, svc('1'));
		a.recordFailure(key, 'boom', true);
		a.recordFailure('service:10:2:x', 'bad', false);
		await flush();

		const b = new RetryManager();
		expect(b.getState(key)?.count).toBe(1);
		expect(b.shouldRetry(key)).toBe(false); // still in backoff after restart
		expect(b.isTerminal('service:10:2:x')).toBe(true);
	});

	it('obsolete-key cleanup is persisted and survives restart', async () => {
		const a = new RetryManager();
		const oldKey = serviceRetryKey(10, svc('1'));
		const newKey = serviceRetryKey(10, svc('2'));
		const otherKey = 'service:10:2:abc';
		[oldKey, newKey, otherKey].forEach((k) => a.recordFailure(k, 'x', true));
		await flush();

		pruneObsoleteServiceRetries(a, 10, svc('2'));
		await flush();
		expect(rows.has(oldKey)).toBe(false);

		const b = new RetryManager();
		expect(b.getState(oldKey)).toBeUndefined();
		expect(b.getState(newKey)?.count).toBe(1);
		expect(b.getState(otherKey)?.count).toBe(1);
	});

	it('a failed DB delete does not throw, and the next prune after restart removes the leftover row', async () => {
		const a = new RetryManager();
		const oldKey = serviceRetryKey(10, svc('1'));
		const newKey = serviceRetryKey(10, svc('2'));
		a.recordFailure(oldKey, 'x', true);
		a.recordFailure(newKey, 'x', true);
		await flush();

		model.delete.mockImplementationOnce(() => { throw new Error('database is locked'); });
		expect(() => pruneObsoleteServiceRetries(a, 10, svc('2'))).not.toThrow();
		await flush();
		expect(a.getState(oldKey)).toBeUndefined(); // memory cleared
		expect(rows.has(oldKey)).toBe(true); // row leaked by the failed delete

		const b = new RetryManager(); // restart reloads the leftover
		expect(b.getState(oldKey)).toBeDefined();
		pruneObsoleteServiceRetries(b, 10, svc('2'));
		await flush();
		expect(rows.has(oldKey)).toBe(false);
		expect(b.getState(newKey)?.count).toBe(1);
	});

	it('database unavailable at startup or on write degrades to in-memory state', async () => {
		model.getAll.mockImplementationOnce(() => { throw new Error('no such table'); });
		model.upsert.mockImplementation(() => { throw new Error('disk full'); });
		const a = new RetryManager();
		a.recordFailure('service:10:1:h', 'x', true);
		await flush();
		expect(a.getState('service:10:1:h')?.count).toBe(1);
		model.upsert.mockImplementation((r: any) => { rows.set(r.key, { ...r }); });
	});
});
