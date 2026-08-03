/**
 * End-to-end integration test for the MQTT device-write command feature
 * (GitHub issues #4/#5/#6 — implemented as one protocol-agnostic `device.write`
 * command rather than three separate opcua/modbus/bacnet-specific ones; see
 * src/commands/index.ts and src/commands/write-dispatcher.ts).
 *
 * Exercises the full real pipeline — CommandService (parse, expiry check,
 * dedup, bounded queue) -> write-dispatcher (owning-adapter lookup) -> a real
 * OPCUAAdapter -> CommandResultPublisher -> CommandDestination — with mocking
 * only at the true network/DB boundaries: the OPC-UA client (node-opcua),
 * the destination lookup (PublishDestinationsModel), and the MQTT client
 * built from that destination's config (ExternalMqttClient). Commands ride
 * whichever publish destination an admin flags `use_for_commands` (not the
 * cloud/provisioning-gated CloudMqttClient — see command-destination.ts), so
 * that's the boundary this test fakes instead.
 *
 * Raw MQTT bytes are fed straight into CommandService.handleMessage() rather
 * than through a real broker — MQTT transport itself isn't the interesting
 * part here; what matters is that a real command payload produces a real,
 * correctly-attributed OPC-UA write and a real, correctly-shaped result.
 */

import { EventEmitter } from 'events';
import { CommandService } from '../../src/commands/command-service';
import { CommandDeduplicator } from '../../src/commands/command-deduplicator';
import { CommandResultPublisher } from '../../src/commands/command-result-publisher';
import { CommandDestination } from '../../src/commands/command-destination';
import { OPCUAAdapter } from '../../src/plugins/opcua/adapter';
import { OPCUADeviceClient } from '../../src/plugins/opcua/client';
import { PublishDestinationsModel, type PublishDestinationRecord } from '../../src/db/models/publish-destinations.model';
import * as mqttPlugin from '../../src/publish/plugins/mqtt';
import type { OPCUADeviceConfig } from '../../src/plugins/opcua/types';
import type { AdapterManager } from '../../src/plugins/index';
import type { AgentLogger } from '../../src/logging/agent-logger';
import type { CommandResult, CommandServiceConfig } from '../../src/commands/types';

jest.mock('../../src/plugins/opcua/client');
jest.mock('../../src/db/models/publish-destinations.model');
jest.mock('../../src/publish/plugins/mqtt');

const MockedOPCUADeviceClient = OPCUADeviceClient as jest.MockedClass<typeof OPCUADeviceClient>;
const MockedPublishDestinationsModel = PublishDestinationsModel as jest.Mocked<typeof PublishDestinationsModel>;
const mockedCreateExternalMqttClientFromDestination = mqttPlugin.createExternalMqttClientFromDestination as jest.Mock;

// Declared with `var` so the jest.mock() factory above (hoisted to the top of
// the file by Jest) can close over it before this point in the file runs.
// eslint-disable-next-line no-var
var mockMqttPublish: jest.Mock;

let writeNodeMock: jest.Mock;
let publishedResults: CommandResult[];

function makeDevice(name: string, nodeWritable: boolean): OPCUADeviceConfig {
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
		dataPoints: [
			{ name: 'speed-setpoint', nodeId: 'ns=2;s=Motor1.SpeedSetpoint', nodeType: 'metric', writable: nodeWritable },
		],
	} as OPCUADeviceConfig;
}

function silentAgentLogger(): AgentLogger {
	return {
		debugSync: jest.fn(),
		infoSync: jest.fn(),
		warnSync: jest.fn(),
		errorSync: jest.fn(),
	} as unknown as AgentLogger;
}

/** OPCUAAdapter (and its diagnostics helper) take the plain plugins/types.Logger shape, not AgentLogger. */
function silentPluginLogger() {
	return {
		debug: jest.fn(),
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
	};
}

const CONFIG: CommandServiceConfig = {
	enabled: true,
	maximumCommandAgeSeconds: 30,
	maximumQueueSize: 100,
	writeTimeoutMs: 2000,
	dedupTtlMs: 60_000,
};

/** Builds a real CommandService wired to a real, already-connected OPCUAAdapter. */
async function setup(nodeWritable = true) {
	writeNodeMock = jest.fn().mockResolvedValue(undefined);

	MockedOPCUADeviceClient.mockImplementation(() => {
		const client = new EventEmitter() as any;
		const session = new EventEmitter() as any;
		session.sessionId = { toString: () => 'sess-1' };
		session.close = jest.fn().mockResolvedValue(undefined);
		client.disconnect = jest.fn().mockResolvedValue(undefined);

		// validateNodeIds() reads 4 attributes per data point (Value, NodeClass,
		// DataType, Description) in one batched call — fake a "Good" Variable/Double
		// response for each so the configured data point validates successfully and
		// classifies as a metric (NodeClass=2, DataType=11/Double; see
		// classifyNodeByMetadata()).
		const goodStatus = { isGood: () => true, name: 'Good', description: '' };
		session.read = jest.fn().mockImplementation((nodesToRead: unknown[]) =>
			nodesToRead.map((_, i) => {
				switch (i % 4) {
					case 0: return { statusCode: goodStatus, value: { value: 42 } }; // Value
					case 1: return { statusCode: goodStatus, value: { value: 2 } }; // NodeClass = Variable
					case 2: return { statusCode: goodStatus, value: { value: 11 } }; // DataType = Double
					default: return { statusCode: goodStatus, value: { value: undefined } }; // Description
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

		return {
			connect: jest.fn().mockResolvedValue(undefined),
			getSessionWrapper: jest.fn(() => sessionWrapper),
			disconnect: jest.fn().mockResolvedValue(undefined),
			cleanup: jest.fn().mockResolvedValue(undefined),
			isConnected: jest.fn(() => true),
			write: writeNodeMock,
		} as any;
	});

	const device = makeDevice('motor-1', nodeWritable);
	const adapter = new OPCUAAdapter([device], silentPluginLogger() as any);
	await (adapter as any).connectDevice(device);

	const adapterManager = { getAllAdapters: () => new Map([['opcua', adapter]]) } as unknown as AdapterManager;

	// Fake the destination an admin would flag `use_for_commands` in the
	// admin UI, and the MQTT client CommandDestination builds from it —
	// commands ride this, not the cloud/provisioning-gated CloudMqttClient.
	const fakeDestination: PublishDestinationRecord = {
		id: 1,
		name: 'test-command-destination',
		type: 'mqtt',
		config_json: { host: 'broker.local', port: 1883 },
		enabled: true,
		use_for_commands: true,
	};
	MockedPublishDestinationsModel.getCommandDestination.mockReturnValue(fakeDestination);

	publishedResults = [];
	mockMqttPublish = jest.fn().mockImplementation(async (_topic: string, payload: string) => {
		publishedResults.push(JSON.parse(payload) as CommandResult);
	});
	const fakeMqttClient = {
		connect: jest.fn().mockResolvedValue(undefined),
		disconnect: jest.fn().mockResolvedValue(undefined),
		subscribe: jest.fn().mockResolvedValue(undefined),
		unsubscribe: jest.fn().mockResolvedValue(undefined),
		publish: mockMqttPublish,
	};
	mockedCreateExternalMqttClientFromDestination.mockReturnValue(fakeMqttClient);
	await CommandDestination.resetForTests();

	const deduplicator = new CommandDeduplicator(CONFIG.dedupTtlMs);
	const resultPublisher = new CommandResultPublisher('cmd/result', silentAgentLogger(), 'test-device-uuid');
	const commandService = new CommandService(silentAgentLogger(), () => adapterManager, deduplicator, resultPublisher, CONFIG);

	return { commandService };
}

/**
 * CommandService.handleMessage() intentionally fire-and-forgets its internal
 * queue (`void this.drainQueue()`) — MQTT delivery isn't meant to block on
 * write completion. So `await handleMessage()` resolving only means the
 * command was synchronously accepted/rejected into (or before) the queue,
 * not that the write + result publish finished. Poll for the expected
 * published-result count instead of assuming completion.
 */
async function waitForPublishedResults(minCount: number, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (publishedResults.length < minCount) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`Timed out waiting for ${minCount} published result(s); got ${publishedResults.length}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function command(overrides: Partial<Record<string, unknown>> = {}): Buffer {
	const now = new Date();
	const payload = {
		version: 1,
		commandId: `cmd-${Math.random().toString(36).slice(2)}`,
		type: 'device.write',
		issuedAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + 30_000).toISOString(),
		deviceUuid: 'motor-1',
		pointName: 'speed-setpoint',
		value: 1500,
		...overrides,
	};
	return Buffer.from(JSON.stringify(payload), 'utf8');
}

describe('MQTT device-write commands, end-to-end (issues #4/#5/#6)', () => {
	afterEach(() => {
		jest.clearAllMocks();
	});

	it('a valid, allowed command produces exactly one OPC-UA write and a succeeded result', async () => {
		const { commandService } = await setup();

		await commandService.handleMessage(command(), false);
		await waitForPublishedResults(1);

		expect(writeNodeMock).toHaveBeenCalledTimes(1);
		expect(writeNodeMock).toHaveBeenCalledWith('ns=2;s=Motor1.SpeedSetpoint', 1500);
		expect(publishedResults).toHaveLength(1);
		expect(publishedResults[0]).toMatchObject({ status: 'succeeded', deviceUuid: 'motor-1', pointName: 'speed-setpoint' });
	});

	it('a write to a non-writable node is rejected without touching the OPC-UA server', async () => {
		const { commandService } = await setup(/* nodeWritable */ false);

		await commandService.handleMessage(command(), false);
		await waitForPublishedResults(1);

		expect(writeNodeMock).not.toHaveBeenCalled();
		expect(publishedResults).toHaveLength(1);
		expect(publishedResults[0].status).toBe('failed');
		expect(publishedResults[0].error?.code).toBe('NODE_NOT_ALLOWED');
	});

	it('a duplicate commandId does not cause a second write', async () => {
		const { commandService } = await setup();
		const payload = command();
		const commandId = JSON.parse(payload.toString('utf8')).commandId;

		await commandService.handleMessage(payload, false);
		await waitForPublishedResults(1); // wait for the first delivery to fully complete...

		await commandService.handleMessage(Buffer.from(payload), false); // ...before the "duplicate" (same bytes, same commandId) arrives
		await waitForPublishedResults(2);

		expect(writeNodeMock).toHaveBeenCalledTimes(1);
		expect(publishedResults.filter((r) => r.commandId === commandId)).toHaveLength(2);
		expect(publishedResults[1].status).toBe('succeeded');
	});

	it('an expired command is rejected without ever reaching the OPC-UA server', async () => {
		const { commandService } = await setup();
		const now = new Date();
		const expired = command({
			issuedAt: new Date(now.getTime() - 60_000).toISOString(),
			expiresAt: new Date(now.getTime() - 30_000).toISOString(),
		});

		await commandService.handleMessage(expired, false);

		expect(writeNodeMock).not.toHaveBeenCalled();
		expect(publishedResults).toHaveLength(1);
		expect(publishedResults[0].status).toBe('expired');
		expect(publishedResults[0].error?.code).toBe('COMMAND_EXPIRED');
	});

	it('a retained MQTT command is rejected outright, with no result published (no commandId trusted from a retained message)', async () => {
		const { commandService } = await setup();

		await commandService.handleMessage(command(), /* retain */ true);

		expect(writeNodeMock).not.toHaveBeenCalled();
		expect(publishedResults).toHaveLength(0);
	});

	it('a command for an unknown device is rejected without touching the OPC-UA server', async () => {
		const { commandService } = await setup();

		await commandService.handleMessage(command({ deviceUuid: 'no-such-device' }), false);
		await waitForPublishedResults(1);

		expect(writeNodeMock).not.toHaveBeenCalled();
		expect(publishedResults).toHaveLength(1);
		expect(publishedResults[0].status).toBe('failed');
		expect(publishedResults[0].error?.code).toBe('NODE_NOT_ALLOWED');
	});
});
