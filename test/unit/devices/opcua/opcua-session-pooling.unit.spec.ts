/**
 * Regression tests for GitHub issue #11 ("OPC-UA: one client session per
 * configured device, even when devices share a physical server"):
 * OPCUAAdapter used to key its `clients`/`sessions` maps purely by
 * `device.name`, so N configured devices that all pointed at the same
 * physical OPC-UA server (same endpointUrl + auth) each got their own
 * independent OPCUADeviceClient/session — real servers, especially small
 * embedded/PLC stacks, often cap concurrent sessions well below the
 * configured device count, so this could silently fail past that cap.
 *
 * Fix: devices sharing an endpointUrl (+ matching security settings) are
 * grouped and share exactly one OPCUADeviceClient/session, built from a
 * synthetic composite device (merged dataPoints, reconciled
 * maxMonitoredItemsPerSubscription) — see OPCUAAdapter's
 * computeGroupKey()/buildCompositeDevice()/connectGroup(). `clients`/
 * `sessions` stay keyed by device.name so every other call site
 * (readDeviceData, writeNode, etc.) needs no changes — sibling device
 * names in the same group just point at the same object reference.
 *
 * Mocking pattern mirrors opcua-reconnect-race.unit.spec.ts (issue #18):
 * OPCUADeviceClient is auto-mocked, no real OPC-UA server involved.
 */

import { EventEmitter } from 'events';
import { OPCUAAdapter } from '../../../../src/plugins/opcua/adapter';
import { OPCUADeviceClient } from '../../../../src/plugins/opcua/client';
import type { OPCUADeviceConfig, OPCUAConnection, OPCUADataPoint } from '../../../../src/plugins/opcua/types';
import type { Logger } from '../../../../src/plugins/types';

jest.mock('../../../../src/plugins/opcua/client');

const MockedOPCUADeviceClient = OPCUADeviceClient as jest.MockedClass<typeof OPCUADeviceClient>;

let createdWrappers: any[] = [];
let createdClientInstances: any[] = [];
let nextSessionId = 0;
let connectDelayMs = 0;

function makeMockInstance() {
	const sessionId = `sess-${++nextSessionId}`;
	const client = new EventEmitter() as any;
	const session = new EventEmitter() as any;
	session.sessionId = { toString: () => sessionId };
	session.close = jest.fn().mockResolvedValue(undefined);
	client.disconnect = jest.fn().mockResolvedValue(undefined);

	// validateNodeIds() reads 4 attributes per data point (Value, NodeClass,
	// DataType, Description) in one batched call — only exercised by tests
	// that configure non-empty dataPoints (most of this file uses [] to skip
	// it — see makeDevice()'s doc comment). Fake a "Good" Variable/Double
	// response for each so any such data point validates successfully and
	// classifies as a metric (NodeClass=2, DataType=11/Double).
	const goodStatus = { isGood: () => true, name: 'Good', description: '' };
	session.read = jest.fn().mockImplementation((nodesToRead: unknown[]) =>
		nodesToRead.map((_, i) => {
			switch (i % 4) {
				case 0: return { statusCode: goodStatus, value: { value: 42 } };
				case 1: return { statusCode: goodStatus, value: { value: 2 } };
				case 2: return { statusCode: goodStatus, value: { value: 11 } };
				default: return { statusCode: goodStatus, value: { value: undefined } };
			}
		}),
	);

	const sessionWrapper = {
		client,
		session,
		subscription: null,
		subscriptions: [],
		monitoredItems: new Map(),
		validatedNodes: new Set(),
		reconnecting: false,
		currentRetryDelay: 5000,
		consecutiveFailures: 0,
	};
	createdWrappers.push(sessionWrapper);

	const instance = {
		connect: jest.fn().mockImplementation(async () => {
			if (connectDelayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, connectDelayMs));
			}
		}),
		getSessionWrapper: jest.fn(() => sessionWrapper),
		disconnect: jest.fn().mockResolvedValue(undefined),
		cleanup: jest.fn().mockResolvedValue(undefined),
		isConnected: jest.fn(() => true),
		write: jest.fn().mockResolvedValue(undefined),
	} as any;
	createdClientInstances.push(instance);

	return instance;
}

function makeDevice(
	name: string,
	connectionOverrides: Partial<OPCUAConnection> = {},
	dataPoints: Partial<OPCUADataPoint>[] = []
): OPCUADeviceConfig {
	return {
		name,
		protocol: 'opcua',
		enabled: true,
		pollInterval: 5000,
		connection: {
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
			...connectionOverrides,
		},
		// Empty dataPoints takes the early "nothing to validate/subscribe" path
		// in connectDevice(), keeping the connect/disconnect/reconnect tests
		// focused on session-pooling lifecycle rather than node validation/
		// subscription plumbing — same reasoning as opcua-reconnect-race's makeDevice().
		dataPoints,
	} as OPCUADeviceConfig;
}

function silentLogger(): Logger {
	return {
		debug: jest.fn(),
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
	};
}

describe('OPCUAAdapter session pooling (issue #11)', () => {
	beforeEach(() => {
		createdWrappers = [];
		createdClientInstances = [];
		nextSessionId = 0;
		connectDelayMs = 0;
		MockedOPCUADeviceClient.mockReset();
		MockedOPCUADeviceClient.mockImplementation(() => makeMockInstance());
	});

	describe('grouping', () => {
		it('pools 3 devices sharing one endpoint onto a single client/session', async () => {
			const a = makeDevice('ahu-1');
			const b = makeDevice('ahu-2');
			const c = makeDevice('ahu-3');
			const adapter = new OPCUAAdapter([a, b, c], silentLogger());

			const sa = await (adapter as any).connectDevice(a);
			const sb = await (adapter as any).connectDevice(b);
			const sc = await (adapter as any).connectDevice(c);

			expect(MockedOPCUADeviceClient).toHaveBeenCalledTimes(1);
			expect(sa).toBe(sb);
			expect(sb).toBe(sc);
		});

		it('does not pool devices with different endpointUrls', async () => {
			const a = makeDevice('dev-a', { endpointUrl: 'opc.tcp://host-a:4840' });
			const b = makeDevice('dev-b', { endpointUrl: 'opc.tcp://host-b:4840' });
			const adapter = new OPCUAAdapter([a, b], silentLogger());

			const sa = await (adapter as any).connectDevice(a);
			const sb = await (adapter as any).connectDevice(b);

			expect(MockedOPCUADeviceClient).toHaveBeenCalledTimes(2);
			expect(sa).not.toBe(sb);
		});

		it('does not pool devices on the same endpoint with different security settings', async () => {
			const a = makeDevice('dev-a', { securityPolicy: 'Basic256Sha256', securityMode: 'SignAndEncrypt' });
			const b = makeDevice('dev-b', { securityPolicy: 'None', securityMode: 'None' });
			const adapter = new OPCUAAdapter([a, b], silentLogger());

			const sa = await (adapter as any).connectDevice(a);
			const sb = await (adapter as any).connectDevice(b);

			expect(MockedOPCUADeviceClient).toHaveBeenCalledTimes(2);
			expect(sa).not.toBe(sb);
		});
	});

	describe('reference-counted teardown', () => {
		async function connectGroupOfThree(adapter: OPCUAAdapter, a: OPCUADeviceConfig, b: OPCUADeviceConfig, c: OPCUADeviceConfig) {
			const sa = await (adapter as any).connectDevice(a);
			await (adapter as any).connectDevice(b);
			await (adapter as any).connectDevice(c);
			return sa;
		}

		it('leaves the shared session up when only one of several group members disconnects', async () => {
			const a = makeDevice('ahu-1');
			const b = makeDevice('ahu-2');
			const c = makeDevice('ahu-3');
			const adapter = new OPCUAAdapter([a, b, c], silentLogger());
			const sa = await connectGroupOfThree(adapter, a, b, c);
			const clientInstance = createdClientInstances[0];

			await (adapter as any).disconnectDevice(b.name);

			expect(clientInstance.disconnect).not.toHaveBeenCalled();
			expect((adapter as any).sessions.get(a.name)).toBe(sa);
			expect((adapter as any).sessions.get(c.name)).toBe(sa);
			expect((adapter as any).sessions.get(b.name)).toBeUndefined();
		});

		it('tears down the shared session exactly once, only after the last group member disconnects', async () => {
			const a = makeDevice('ahu-1');
			const b = makeDevice('ahu-2');
			const c = makeDevice('ahu-3');
			const adapter = new OPCUAAdapter([a, b, c], silentLogger());
			await connectGroupOfThree(adapter, a, b, c);
			const clientInstance = createdClientInstances[0];

			await (adapter as any).disconnectDevice(b.name);
			expect(clientInstance.disconnect).not.toHaveBeenCalled();

			await (adapter as any).disconnectDevice(a.name);
			expect(clientInstance.disconnect).not.toHaveBeenCalled();

			await (adapter as any).disconnectDevice(c.name);
			expect(clientInstance.disconnect).toHaveBeenCalledTimes(1);
		});

		it('tears down the shared session exactly once even when all members disconnect concurrently', async () => {
			const a = makeDevice('ahu-1');
			const b = makeDevice('ahu-2');
			const c = makeDevice('ahu-3');
			const adapter = new OPCUAAdapter([a, b, c], silentLogger());
			await connectGroupOfThree(adapter, a, b, c);
			const clientInstance = createdClientInstances[0];

			await Promise.all([
				(adapter as any).disconnectDevice(a.name),
				(adapter as any).disconnectDevice(b.name),
				(adapter as any).disconnectDevice(c.name),
			]);

			expect(clientInstance.disconnect).toHaveBeenCalledTimes(1);
		});
	});

	describe('group-level reconnect', () => {
		it('rebuilds the shared session for every group member on reconnect', async () => {
			const a = makeDevice('ahu-1');
			const b = makeDevice('ahu-2');
			const c = makeDevice('ahu-3');
			const adapter = new OPCUAAdapter([a, b, c], silentLogger());
			const sa = await (adapter as any).connectDevice(a);
			await (adapter as any).connectDevice(b);
			await (adapter as any).connectDevice(c);
			expect(MockedOPCUADeviceClient).toHaveBeenCalledTimes(1);

			await (adapter as any).attemptReconnect(a, sa);

			expect(MockedOPCUADeviceClient).toHaveBeenCalledTimes(2);
			const newSession = createdWrappers[1];
			expect((adapter as any).sessions.get(a.name)).toBe(newSession);
			expect((adapter as any).sessions.get(b.name)).toBe(newSession);
			expect((adapter as any).sessions.get(c.name)).toBe(newSession);
		});

		it("does not create a duplicate session when a base-class retry races the group's own reconnect", async () => {
			const a = makeDevice('ahu-1');
			const b = makeDevice('ahu-2');
			const adapter = new OPCUAAdapter([a, b], silentLogger());
			const sa = await (adapter as any).connectDevice(a);
			await (adapter as any).connectDevice(b);
			expect(MockedOPCUADeviceClient).toHaveBeenCalledTimes(1);

			// Simulate scheduleReconnect() having already flagged the shared
			// wrapper as reconnecting, the way a real connection_lost/close event
			// (fired from device A's side) would.
			sa.reconnecting = true;
			connectDelayMs = 20;

			// Start the adapter's own reconnect path (mirrors scheduleReconnect's
			// setTimeout callback calling attemptReconnect for device A).
			const reconnectPromise = (adapter as any).attemptReconnect(a, sa);

			// Let attemptReconnect() get past cleanup()/invalidateGroupForReconnect()
			// and into connectDevice() (which registers the group-scoped in-flight
			// promise synchronously before awaiting connect()).
			await new Promise((resolve) => setImmediate(resolve));

			// Simulate BaseProtocolAdapter's independent poll-failure retry
			// (scheduleDeviceRetry -> initializeDevice) calling connectDevice()
			// for sibling B — a DIFFERENT device name on the same shared session —
			// while the group's own reconnect (triggered via device A) is still
			// in flight.
			const racingConnectPromise = (adapter as any).connectDevice(b);

			await reconnectPromise;
			const racingResult = await racingConnectPromise;

			// Exactly one new client was built for the whole group's reconnect —
			// the racing call for sibling B coalesced onto it instead of building
			// a second, orphaned session. Group-scoped extension of the
			// device-scoped issue-#18 assertion.
			expect(MockedOPCUADeviceClient).toHaveBeenCalledTimes(2);
			expect(racingResult).toBe(createdWrappers[1]);
			expect((adapter as any).sessions.get(a.name)).toBe(createdWrappers[1]);
			expect((adapter as any).sessions.get(b.name)).toBe(createdWrappers[1]);
		});
	});

	describe('buildCompositeDevice (pure logic)', () => {
		it('reconciles maxMonitoredItemsPerSubscription to the minimum across the group, with a warning on mismatch', () => {
			const logger = silentLogger();
			const a = makeDevice('dev-a', { maxMonitoredItemsPerSubscription: 50 });
			const b = makeDevice('dev-b', { maxMonitoredItemsPerSubscription: 20 });
			const adapter = new OPCUAAdapter([a, b], logger);

			const { device: composite } = (adapter as any).buildCompositeDevice([a, b]);

			expect(composite.connection.maxMonitoredItemsPerSubscription).toBe(20);
			expect(logger.warn).toHaveBeenCalledTimes(1);
		});

		it('does not warn when every member configures the same maxMonitoredItemsPerSubscription', () => {
			const logger = silentLogger();
			const a = makeDevice('dev-a', { maxMonitoredItemsPerSubscription: 100 });
			const b = makeDevice('dev-b', { maxMonitoredItemsPerSubscription: 100 });
			const adapter = new OPCUAAdapter([a, b], logger);

			const { device: composite } = (adapter as any).buildCompositeDevice([a, b]);

			expect(composite.connection.maxMonitoredItemsPerSubscription).toBe(100);
			expect(logger.warn).not.toHaveBeenCalled();
		});

		it('attributes each merged data point to its real owning device by nodeId', () => {
			const a = makeDevice('dev-a', {}, [{ name: 'temp', nodeId: 'ns=2;s=a.temp' }]);
			const b = makeDevice('dev-b', {}, [{ name: 'pressure', nodeId: 'ns=2;s=b.pressure' }]);
			const adapter = new OPCUAAdapter([a, b], silentLogger());

			const { device: composite, nodeIdToDevice } = (adapter as any).buildCompositeDevice([a, b]);

			expect(composite.dataPoints).toHaveLength(2);
			expect(nodeIdToDevice.get('ns=2;s=a.temp')).toBe(a);
			expect(nodeIdToDevice.get('ns=2;s=b.pressure')).toBe(b);
		});
	});

	describe('writeNode() logical device name resolution', () => {
		it('resolves a logical device name (e.g. "AHU-1") to the endpoint that configured it, scoped to only that device\'s own points', async () => {
			const ahu1Point: Partial<OPCUADataPoint> = {
				name: 'setpoint', nodeId: 'ns=2;s=ahu1.setpoint', writable: true, device_uuid: 'ahu-1', device_name: 'AHU-1',
			};
			const ahu2Point: Partial<OPCUADataPoint> = {
				name: 'setpoint', nodeId: 'ns=2;s=ahu2.setpoint', writable: true, device_uuid: 'ahu-2', device_name: 'AHU-2',
			};
			const endpoint = makeDevice('opcua_server_4840', {}, [ahu1Point, ahu2Point]);
			const adapter = new OPCUAAdapter([endpoint], silentLogger());
			await (adapter as any).connectDevice(endpoint);
			const clientInstance = createdClientInstances[0];

			await adapter.writeNode('AHU-1', 'setpoint', 42);

			expect(clientInstance.write).toHaveBeenCalledTimes(1);
			expect(clientInstance.write).toHaveBeenCalledWith('ns=2;s=ahu1.setpoint', 42);
		});

		it('never writes to a different logical device sharing the same point name', async () => {
			const ahu1Point: Partial<OPCUADataPoint> = {
				name: 'setpoint', nodeId: 'ns=2;s=ahu1.setpoint', writable: true, device_uuid: 'ahu-1', device_name: 'AHU-1',
			};
			const ahu2Point: Partial<OPCUADataPoint> = {
				name: 'setpoint', nodeId: 'ns=2;s=ahu2.setpoint', writable: true, device_uuid: 'ahu-2', device_name: 'AHU-2',
			};
			const endpoint = makeDevice('opcua_server_4840', {}, [ahu1Point, ahu2Point]);
			const adapter = new OPCUAAdapter([endpoint], silentLogger());
			await (adapter as any).connectDevice(endpoint);
			const clientInstance = createdClientInstances[0];

			await adapter.writeNode('AHU-2', 'setpoint', 7);

			expect(clientInstance.write).toHaveBeenCalledTimes(1);
			expect(clientInstance.write).toHaveBeenCalledWith('ns=2;s=ahu2.setpoint', 7);
		});

		it('still resolves the raw configured endpoint name directly (unchanged behavior)', async () => {
			const point: Partial<OPCUADataPoint> = { name: 'setpoint', nodeId: 'ns=2;s=only.setpoint', writable: true };
			const endpoint = makeDevice('opcua_server_4840', {}, [point]);
			const adapter = new OPCUAAdapter([endpoint], silentLogger());
			await (adapter as any).connectDevice(endpoint);
			const clientInstance = createdClientInstances[0];

			await adapter.writeNode('opcua_server_4840', 'setpoint', 99);

			expect(clientInstance.write).toHaveBeenCalledWith('ns=2;s=only.setpoint', 99);
		});

		it('rejects an unknown device name', async () => {
			const endpoint = makeDevice('opcua_server_4840', {}, [{ name: 'setpoint', nodeId: 'ns=2;s=x', writable: true }]);
			const adapter = new OPCUAAdapter([endpoint], silentLogger());
			await (adapter as any).connectDevice(endpoint);

			await expect(adapter.writeNode('no-such-device', 'setpoint', 1)).rejects.toThrow('Device not found');
		});
	});

	describe('ownsDeviceName()', () => {
		it('recognizes both the raw endpoint name and any logical device name within it', () => {
			const point: Partial<OPCUADataPoint> = { name: 'setpoint', nodeId: 'ns=2;s=ahu1.setpoint', device_uuid: 'ahu-1', device_name: 'AHU-1' };
			const endpoint = makeDevice('opcua_server_4840', {}, [point]);
			const adapter = new OPCUAAdapter([endpoint], silentLogger());

			expect(adapter.ownsDeviceName('opcua_server_4840')).toBe(true);
			expect(adapter.ownsDeviceName('AHU-1')).toBe(true);
			expect(adapter.ownsDeviceName('ahu-1')).toBe(true); // device_uuid, case-insensitive
			expect(adapter.ownsDeviceName('AHU-99')).toBe(false);
		});
	});
});
