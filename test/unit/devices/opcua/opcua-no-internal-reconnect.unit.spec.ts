/**
 * Regression tests for the BadSessionNotActivated fault storm fix.
 *
 * node-opcua's internal reconnection (`_repairConnection`) used to race with
 * the agent's own `scheduleReconnect`, creating a window where the publish
 * engine could send requests against an unactivated session. Setting
 * `connectionStrategy.maxRetry` to 0 disables node-opcua's internal
 * reconnection entirely, so only the agent's own reconnect path runs.
 *
 * These tests verify:
 * 1. connectionStrategy.maxRetry is 0 (internal reconnection disabled)
 * 2. Initial connection failures trigger application-level retries
 * 3. connection_lost triggers application-level reconnection
 * 4. Old sessions and subscriptions are cleaned up during reconnect
 * 5. A new session and subscriptions are created after reconnect
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
let connectShouldFail = false;

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
			if (connectShouldFail) {
				throw new Error('Connection refused');
			}
		}),
		getSessionWrapper: jest.fn(() => sessionWrapper),
		disconnect: jest.fn().mockResolvedValue(undefined),
		cleanup: jest.fn().mockResolvedValue(undefined),
		isConnected: jest.fn(() => true),
	} as any;
}

function makeDevice(name = 'sim-opcua-4k'): OPCUADeviceConfig {
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

describe('OPCUAAdapter no-internal-reconnect (BadSessionNotActivated fix)', () => {
	beforeEach(() => {
		jest.useFakeTimers();
		createdWrappers = [];
		nextSessionId = 0;
		connectShouldFail = false;
		MockedOPCUADeviceClient.mockReset();
		MockedOPCUADeviceClient.mockImplementation(() => makeMockInstance());
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('connectionStrategy.maxRetry is 0 in source', () => {
		// Verify the source code value directly — the real OPCUADeviceClient
		// cannot be instantiated under Jest's module mapper (node-opcua-client
		// is auto-mocked), so we read the source file instead.
		const fs = require('fs');
		const path = require('path');
		const source = fs.readFileSync(
			path.join(__dirname, '../../../../src/plugins/opcua/client.ts'),
			'utf-8'
		);
		// Match the connectionStrategy block in createClientOptions
		const match = source.match(/connectionStrategy:\s*\{[^}]*maxRetry:\s*(\d+)/);
		expect(match).not.toBeNull();
		expect(match![1]).toBe('0');
	});

	it('initial connection failure triggers application-level retry via scheduleDeviceRetry', async () => {
		const device = makeDevice();
		const adapter = new OPCUAAdapter([device], silentLogger());

		connectShouldFail = true;

		// initializeDevice catches the error and calls scheduleDeviceRetry
		await (adapter as any).initializeDevice(device);

		// The connection should be marked as not connected
		const connection = (adapter as any).connections.get(device.name);
		expect(connection).toBeDefined();
		expect(connection.connected).toBe(false);

		// Let the retry succeed
		connectShouldFail = false;

		// Advance past the retry delay (initialBackoffDelay = 1000ms)
		jest.advanceTimersByTime(1100);
		// Let the async initializeDevice() run
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		// Two OPCUADeviceClient instances should have been created:
		// one for the failed attempt, one for the retry
		expect(MockedOPCUADeviceClient).toHaveBeenCalledTimes(2);
	});

	it('connection_lost triggers agent scheduleReconnect, not internal reconnection', async () => {
		const device = makeDevice();
		const adapter = new OPCUAAdapter([device], silentLogger());

		const scheduleReconnectSpy = jest.spyOn(adapter as any, 'scheduleReconnect');

		const sessionWrapper = await (adapter as any).connectDevice(device);
		const mockClient = sessionWrapper.client;

		// Verify no repairConnectionStarted listener (internal reconnection would emit this)
		const repairStartedListeners = mockClient.listeners('repairConnectionStarted');
		expect(repairStartedListeners).toHaveLength(0);

		// Simulate connection_lost — this is what node-opcua emits when the channel drops
		mockClient.emit('connection_lost');

		expect(scheduleReconnectSpy).toHaveBeenCalledWith(
			expect.objectContaining({ name: device.name }),
			sessionWrapper,
			'connection_lost'
		);
	});

	it('attemptReconnect cleans up old session before creating a new one', async () => {
		const device = makeDevice();
		const adapter = new OPCUAAdapter([device], silentLogger());

		const initialWrapper = await (adapter as any).connectDevice(device);
		const runtimeClient = (adapter as any).clients.get(device.name);

		// Mark as reconnecting (normally done by scheduleReconnect)
		initialWrapper.reconnecting = true;

		await (adapter as any).attemptReconnect(device, initialWrapper);

		// cleanup(false) should have been called on the old client
		expect(runtimeClient.cleanup).toHaveBeenCalledWith(false);

		// A new client should have been created
		expect(MockedOPCUADeviceClient).toHaveBeenCalledTimes(2);

		// The new session should be registered, not the old one
		const currentSession = (adapter as any).sessions.get(device.name);
		expect(currentSession).toBe(createdWrappers[1]);
		expect(currentSession).not.toBe(initialWrapper);
	});

	it('old wrapper stays retired after reconnect (reconnecting stays true)', async () => {
		const device = makeDevice();
		const adapter = new OPCUAAdapter([device], silentLogger());

		const initialWrapper = await (adapter as any).connectDevice(device);
		initialWrapper.reconnecting = true;

		await (adapter as any).attemptReconnect(device, initialWrapper);

		// The old wrapper must remain permanently retired — its reconnecting flag
		// must stay true so stale event listeners on the old client can't schedule
		// another independent reconnect loop
		expect(initialWrapper.reconnecting).toBe(true);
	});

	it('full reconnect cycle: connection_lost → scheduleReconnect → attemptReconnect → new session', async () => {
		const device = makeDevice();
		const adapter = new OPCUAAdapter([device], silentLogger());

		const initialWrapper = await (adapter as any).connectDevice(device);
		const mockClient = initialWrapper.client;

		// Trigger connection_lost
		mockClient.emit('connection_lost');

		// scheduleReconnect should have flagged it and set a timer
		expect(initialWrapper.reconnecting).toBe(true);
		expect(initialWrapper.reconnectTimer).toBeDefined();

		// Advance past the reconnect delay (MIN_RETRY_DELAY=5000 + up to 500ms jitter)
		jest.advanceTimersByTime(6000);

		// Let the async attemptReconnect run
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		// Should have created a second client for the reconnect
		expect(MockedOPCUADeviceClient).toHaveBeenCalledTimes(2);

		// The new session should be the current one
		const currentSession = (adapter as any).sessions.get(device.name);
		expect(currentSession).toBe(createdWrappers[1]);
	});

	it('isSessionFatalError recognizes BadSessionNotActivated and related codes', () => {
		const device = makeDevice();
		const adapter = new OPCUAAdapter([device], silentLogger());

		expect((adapter as any).isSessionFatalError(
			new Error('serviceResult = BadSessionNotActivated (0x80270000)')
		)).toBe(true);
		expect((adapter as any).isSessionFatalError(
			new Error('serviceResult = BadSessionClosed (0x80260000)')
		)).toBe(true);
		expect((adapter as any).isSessionFatalError(
			new Error('serviceResult = BadSessionIdInvalid (0x80250000)')
		)).toBe(true);
		expect((adapter as any).isSessionFatalError(
			new Error('OPC UA NamespaceArray read failed')
		)).toBe(false);
		expect((adapter as any).isSessionFatalError(
			new Error('BadTimeout')
		)).toBe(false);
	});

	it('BadSessionNotActivated in identity evidence triggers scheduleReconnect instead of retry', async () => {
		const device = makeDevice();
		const adapter = new OPCUAAdapter([device], silentLogger());
		const scheduleReconnectSpy = jest.spyOn(adapter as any, 'scheduleReconnect');

		const sessionWrapper = await (adapter as any).connectDevice(device);

		// Simulate a group being tracked (connectGroup populates this)
		const groupKey = (adapter as any).computeGroupKey(device);
		const group = (adapter as any).groups.get(groupKey);

		expect(group).toBeDefined();

		// Mock session.read to throw BadSessionNotActivated
		sessionWrapper.session.read = jest.fn().mockRejectedValue(
			new Error('serviceResult = BadSessionNotActivated (0x80270000)')
		);

		// Trigger identity evidence refresh — it will call session.read()
		// and hit the BadSessionNotActivated error
		(adapter as any).refreshNamespaceEvidence(group);

		// Let the async read() run
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(scheduleReconnectSpy).toHaveBeenCalledWith(
			group.compositeDevice,
			group.session,
			'session_not_activated'
		);
	});
});
