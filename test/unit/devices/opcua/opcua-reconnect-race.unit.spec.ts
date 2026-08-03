/**
 * Regression tests for GitHub issue #18 ("Investigate multiple connections to
 * OPCUA"): repeated server restarts / network blips were causing the agent to
 * accumulate duplicate OPC-UA sessions, subscriptions, and monitored items on
 * the server, because:
 *
 *  1. OPCUAAdapter's own event-driven reconnect (scheduleReconnect/attemptReconnect)
 *     and BaseProtocolAdapter's poll-failure retry (scheduleDeviceRetry/initializeDevice)
 *     could both call connectDevice() for the same device concurrently, each
 *     building a full client/session/subscription stack — whichever finished
 *     last won the tracking map slot, leaking the other one forever.
 *  2. attemptReconnect() copied the freshly-committed session back onto the old,
 *     now-orphaned wrapper and reset its `reconnecting` flag to false, re-arming
 *     stale event listeners that could schedule their own untrackable reconnect
 *     loops.
 *  3. disconnectDevice() set `reconnecting = false` right before tearing the
 *     connection down, which is the value that *allows* scheduleReconnect() to
 *     run — the opposite of what shutdown needs.
 *
 * These tests exercise the fixes for all three directly against OPCUAAdapter,
 * with OPCUADeviceClient auto-mocked (no real OPC-UA server involved).
 */

import { EventEmitter } from 'events';
import { OPCUAAdapter } from '../../../../src/plugins/opcua/adapter';
import { OPCUADeviceClient } from '../../../../src/plugins/opcua/client';
import type { OPCUADeviceConfig } from '../../../../src/plugins/opcua/types';
import type { Logger } from '../../../../src/plugins/types';

jest.mock('../../../../src/plugins/opcua/client');

const MockedOPCUADeviceClient = OPCUADeviceClient as jest.MockedClass<typeof OPCUADeviceClient>;

let createdWrappers: any[] = [];
let nextSessionId = 0;
let connectDelayMs = 0;

function makeMockInstance() {
	const sessionId = `sess-${++nextSessionId}`;
	const client = new EventEmitter() as any;
	const session = new EventEmitter() as any;
	session.sessionId = { toString: () => sessionId };
	session.close = jest.fn().mockResolvedValue(undefined);
	client.disconnect = jest.fn().mockResolvedValue(undefined);

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

	return {
		connect: jest.fn().mockImplementation(async () => {
			if (connectDelayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, connectDelayMs));
			}
		}),
		getSessionWrapper: jest.fn(() => sessionWrapper),
		disconnect: jest.fn().mockResolvedValue(undefined),
		cleanup: jest.fn().mockResolvedValue(undefined),
		isConnected: jest.fn(() => true),
	} as any;
}

function makeDevice(name = 'plc-1'): OPCUADeviceConfig {
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
		},
		// Empty dataPoints takes the early "nothing to validate/subscribe" path
		// in connectDevice(), keeping these tests focused on session lifecycle
		// rather than node validation/subscription plumbing.
		dataPoints: [],
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

describe('OPCUAAdapter reconnect race (issue #18)', () => {
	beforeEach(() => {
		createdWrappers = [];
		nextSessionId = 0;
		connectDelayMs = 0;
		MockedOPCUADeviceClient.mockReset();
		MockedOPCUADeviceClient.mockImplementation(() => makeMockInstance());
	});

	it('coalesces concurrent connectDevice() calls for the same device into one client', async () => {
		const device = makeDevice();
		const adapter = new OPCUAAdapter([device], silentLogger());

		const [a, b] = await Promise.all([
			(adapter as any).connectDevice(device),
			(adapter as any).connectDevice(device),
		]);

		expect(MockedOPCUADeviceClient).toHaveBeenCalledTimes(1);
		expect(a).toBe(b);
	});

	it("does not create a duplicate session when a base-class retry races the adapter's own reconnect", async () => {
		const device = makeDevice();
		const adapter = new OPCUAAdapter([device], silentLogger());

		// Initial connect.
		const initialWrapper = await (adapter as any).connectDevice(device);
		expect(MockedOPCUADeviceClient).toHaveBeenCalledTimes(1);
		const originalClient = initialWrapper.client;
		const originalSession = initialWrapper.session;

		// Simulate scheduleReconnect() having already flagged this wrapper as
		// reconnecting, the way a real connection_lost/close event would.
		initialWrapper.reconnecting = true;

		// Make the *next* connect() take long enough that a concurrent caller
		// can land in the middle of it.
		connectDelayMs = 20;

		// Start the adapter's own reconnect path (mirrors scheduleReconnect's
		// setTimeout callback calling attemptReconnect).
		const reconnectPromise = (adapter as any).attemptReconnect(device, initialWrapper);

		// Let attemptReconnect() get past its `await runtimeClient.cleanup(false)`
		// and into `await this.connectDevice(device)` (which registers the
		// in-flight promise synchronously before awaiting connect()).
		await new Promise((resolve) => setImmediate(resolve));

		// Simulate BaseProtocolAdapter's independent poll-failure retry
		// (scheduleDeviceRetry -> initializeDevice) calling connectDevice()
		// again for the same device while the reconnect above is still in flight.
		const racingConnectPromise = (adapter as any).connectDevice(device);

		await reconnectPromise;
		const racingResult = await racingConnectPromise;

		// Exactly one new client was built for the reconnect — the racing call
		// coalesced onto it instead of building a second, orphaned session.
		expect(MockedOPCUADeviceClient).toHaveBeenCalledTimes(2);
		expect(createdWrappers).toHaveLength(2);
		expect(racingResult).toBe(createdWrappers[1]);
		expect((adapter as any).sessions.get(device.name)).toBe(createdWrappers[1]);

		// The old wrapper must be left alone: attemptReconnect() must not copy
		// the new session onto it, and must not reset its `reconnecting` flag —
		// doing so used to re-arm stale listeners still attached to the old
		// (disconnected) client/session into scheduling their own untrackable
		// reconnect loop.
		expect(initialWrapper.client).toBe(originalClient);
		expect(initialWrapper.session).toBe(originalSession);
		expect(initialWrapper.reconnecting).toBe(true);
	});

	it('disconnectDevice() blocks reconnect scheduling instead of re-enabling it', async () => {
		const device = makeDevice();
		const adapter = new OPCUAAdapter([device], silentLogger());

		const sessionWrapper = await (adapter as any).connectDevice(device);
		sessionWrapper.reconnecting = false;

		await (adapter as any).disconnectDevice(device.name);

		// scheduleReconnect() only proceeds when `reconnecting` is false, so
		// shutdown must leave it `true` — not flip it back to `false`, which
		// would let a close/session_closed event fired by the teardown itself
		// schedule a brand-new reconnect while the adapter is stopping.
		expect(sessionWrapper.reconnecting).toBe(true);
		expect((adapter as any).sessions.has(device.name)).toBe(false);
	});
});
