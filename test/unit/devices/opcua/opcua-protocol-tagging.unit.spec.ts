/**
 * Regression coverage: readDeviceData()'s polling branch used to omit the
 * `protocol` field entirely on every DeviceDataPoint it produced — for both
 * good- and bad-quality reads. Only the subscription/monitored-item push
 * path set it. Since src/units/interceptor.ts falls back to a wrapper-level
 * hint (or nothing) when reading.protocol is missing, any OPC-UA device
 * read via polling never got OPC-UA-scoped unit-alias resolution. Fixed by
 * adding `protocol: 'opcua'` to both branches (adapter.ts:~1799, ~1831).
 *
 * This bypasses connectDevice()'s full connect/validate flow (covered by
 * opcua-session-pooling.unit.spec.ts) and drives readDeviceData() directly
 * against a hand-built client/session, to keep this test focused on the one
 * thing it's regression-testing.
 */

import { OPCUAAdapter } from '../../../../src/plugins/opcua/adapter';
import type { OPCUADeviceConfig, OPCUAConnection, OPCUADataPoint } from '../../../../src/plugins/opcua/types';
import type { Logger } from '../../../../src/plugins/types';

function makeDevice(name: string, dataPoints: Partial<OPCUADataPoint>[]): OPCUADeviceConfig {
	const connection: OPCUAConnection = {
		endpointUrl: 'opc.tcp://127.0.0.1:4840',
		securityMode: 'None',
		securityPolicy: 'None',
		certificateTrustMode: 'strict',
		connectionTimeout: 10000,
		sessionTimeout: 60000,
		keepAliveInterval: 5000,
		useSubscription: false,
		publishingInterval: 1000,
		samplingInterval: 500,
		maxMonitoredItemsPerSubscription: 100,
		queueSize: 1,
	} as OPCUAConnection;

	return { name, protocol: 'opcua', enabled: true, pollInterval: 5000, connection, dataPoints } as OPCUADeviceConfig;
}

function silentLogger(): Logger {
	return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

const goodStatus = { isGood: () => true, name: 'Good', description: '' };
const badStatus = { isGood: () => false, name: 'BadGenericError', description: 'simulated failure' };

describe('OPCUAAdapter.readDeviceData() — protocol tagging on polling-path data points', () => {
	it('tags protocol: "opcua" on both good- and bad-quality polled readings', async () => {
		const device = makeDevice('dev-1', [
			{ nodeId: 'ns=2;s=m1', name: 'm1', nodeType: 'metric', unit: 'degC' },
			{ nodeId: 'ns=2;s=m2', name: 'm2', nodeType: 'metric', unit: 'degC' },
		]);
		const adapter = new OPCUAAdapter([device], silentLogger()) as any;

		const mockRead = jest.fn().mockResolvedValue([
			{ statusCode: goodStatus, value: { value: 21.5 } },
			{ statusCode: badStatus, value: { value: null } },
		]);

		adapter.clients.set(device.name, { read: mockRead });
		adapter.sessions.set(device.name, {
			client: {},
			session: {},
			subscription: null,
			subscriptions: [],
			monitoredItems: new Map(),
			validatedNodes: new Set(['ns=2;s=m1', 'ns=2;s=m2']),
			reconnecting: false,
			currentRetryDelay: 5000,
			consecutiveFailures: 0,
		});

		const results = await adapter.readDeviceData(device.name, device);

		expect(results).toHaveLength(2);
		const good = results.find((r: any) => r.metric === 'm1');
		const bad = results.find((r: any) => r.metric === 'm2');

		expect(good.quality).toBe('GOOD');
		expect(good.protocol).toBe('opcua');

		expect(bad.quality).toBe('BAD');
		expect(bad.protocol).toBe('opcua');
	});
});
