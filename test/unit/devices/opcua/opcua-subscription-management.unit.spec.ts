import { EventEmitter } from 'events';
import { ClientMonitoredItemGroup } from 'node-opcua-client';
import { OPCUAAdapter } from '../../../../src/plugins/opcua/adapter';
import type { OPCUAConnection, OPCUADeviceConfig } from '../../../../src/plugins/opcua/types';
import type { Logger } from '../../../../src/plugins/types';

type MockGroupOptions = { statusByNode?: Record<string, boolean> };

function makeDevice(
	connectionOverrides: Partial<OPCUAConnection> = {},
	pointCount = 1,
): OPCUADeviceConfig {
	return {
		name: 'plc',
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
			useSubscription: true,
			publishingInterval: 1000,
			samplingInterval: 500,
			maxMonitoredItemsPerSubscription: 100,
			queueSize: 1,
			...connectionOverrides,
		},
		dataPoints: Array.from({ length: pointCount }, (_, index) => ({
			name: `point-${index}`,
			nodeId: `ns=2;s=point-${index}`,
			nodeType: 'metric',
		})),
	} as OPCUADeviceConfig;
}

function silentLogger(): Logger {
	return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeSessionWrapper(serverLimit?: number) {
	const goodStatus = { isGood: () => true, toString: () => 'Good' };
	const status = serverLimit === undefined
		? { isGood: () => false, toString: () => 'BadNodeIdUnknown' }
		: goodStatus;
	const session = {
		read: jest.fn().mockResolvedValue([{
			statusCode: status,
			value: { value: serverLimit },
		}]),
		createSubscription2: jest.fn(),
	};
	const wrapper = {
		session,
		subscription: null,
		subscriptions: [],
		monitoredItems: new Map(),
		validatedNodes: new Set<string>(),
		reconnecting: false,
	};
	return { wrapper, session };
}

function installGroupFactory(options: MockGroupOptions = {}) {
	const subscriptions: Array<EventEmitter & { subscriptionId: number; terminate: jest.Mock }> = [];
	let nextSubscriptionId = 0;
	jest.spyOn(ClientMonitoredItemGroup as any, 'create').mockImplementation((_subscription, items) => {
		const group = new EventEmitter() as EventEmitter & { monitoredItems: Array<EventEmitter & { statusCode: { isGood(): boolean; toString(): string } }> };
		group.monitoredItems = items.map((item: { nodeId: string }) => {
			const isGood = options.statusByNode?.[item.nodeId] ?? true;
			return Object.assign(new EventEmitter(), {
				statusCode: {
					isGood: () => isGood,
					toString: () => isGood ? 'Good' : 'BadNodeIdUnknown',
				},
			});
		});
		process.nextTick(() => group.emit('initialized'));
		return group;
	});

	const createSubscription = jest.fn().mockImplementation(async () => {
		const subscription = Object.assign(new EventEmitter(), {
			subscriptionId: ++nextSubscriptionId,
			publishingInterval: 1000,
			lifetimeCount: 100,
			maxKeepAliveCount: 10,
			maxNotificationsPerPublish: 100,
			terminate: jest.fn().mockResolvedValue(undefined),
		});
		subscriptions.push(subscription);
		return subscription;
	});

	return { subscriptions, createSubscription };
}

describe('OPCUA subscription management', () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('uses the lowest server, configured, and safety-ceiling limits', async () => {
		const device = makeDevice({
			maxMonitoredItemsPerSubscription: 10,
			maxMonitoredItemsPerSubscriptionCeiling: 3,
		}, 5);
		const { wrapper, session } = makeSessionWrapper(2);
		const groups = installGroupFactory();
		session.createSubscription2 = groups.createSubscription;
		wrapper.validatedNodes = new Set(device.dataPoints.map(point => point.nodeId));
		const adapter = new OPCUAAdapter([device], silentLogger());

		await (adapter as any).createSubscription(device.name, device, wrapper, new Map(), new Set());

		expect(session.read).toHaveBeenCalledWith([{
			nodeId: 'ns=0;i=24104',
			attributeId: 13,
		}]);
		expect(groups.createSubscription).toHaveBeenCalledTimes(3);
		expect((ClientMonitoredItemGroup.create as jest.Mock).mock.calls.map(call => call[1])).toEqual([
			expect.arrayContaining([{ nodeId: 'ns=2;s=point-0', attributeId: 13 }, { nodeId: 'ns=2;s=point-1', attributeId: 13 }]),
			expect.arrayContaining([{ nodeId: 'ns=2;s=point-2', attributeId: 13 }, { nodeId: 'ns=2;s=point-3', attributeId: 13 }]),
			[{ nodeId: 'ns=2;s=point-4', attributeId: 13 }],
		]);
		expect(wrapper.subscriptions).toHaveLength(3);
		expect(wrapper.monitoredItems.size).toBe(5);

		await (adapter as any).terminateSubscriptions(wrapper);
	});

	it('falls back to 100 items when the server does not expose a limit', async () => {
		const device = makeDevice({}, 101);
		const { wrapper, session } = makeSessionWrapper();
		const groups = installGroupFactory();
		session.createSubscription2 = groups.createSubscription;
		wrapper.validatedNodes = new Set(device.dataPoints.map(point => point.nodeId));
		const adapter = new OPCUAAdapter([device], silentLogger());

		await (adapter as any).createSubscription(device.name, device, wrapper, new Map(), new Set());

		expect(groups.createSubscription).toHaveBeenCalledTimes(2);
		expect((ClientMonitoredItemGroup.create as jest.Mock).mock.calls.map(call => call[1].length)).toEqual([100, 1]);
		await (adapter as any).terminateSubscriptions(wrapper);
	});

	it('caps configured batches at the default safety ceiling of 500', async () => {
		const device = makeDevice({ maxMonitoredItemsPerSubscription: 1000 }, 501);
		const { wrapper, session } = makeSessionWrapper(1000);
		const groups = installGroupFactory();
		session.createSubscription2 = groups.createSubscription;
		wrapper.validatedNodes = new Set(device.dataPoints.map(point => point.nodeId));
		const adapter = new OPCUAAdapter([device], silentLogger());

		await (adapter as any).createSubscription(device.name, device, wrapper, new Map(), new Set());

		expect((ClientMonitoredItemGroup.create as jest.Mock).mock.calls.map(call => call[1].length)).toEqual([500, 1]);
		await (adapter as any).terminateSubscriptions(wrapper);
	});

	it('shares the endpoint session but only subscribes points whose owning device enables subscriptions', async () => {
		const disabledDevice = makeDevice({ useSubscription: false, publishingInterval: 1000 });
		disabledDevice.name = 'polling-device';
		disabledDevice.dataPoints[0].nodeId = 'ns=2;s=polling-point';
		const enabledDevice = makeDevice({ useSubscription: true, publishingInterval: 2000 });
		enabledDevice.name = 'streaming-device';
		enabledDevice.dataPoints[0].nodeId = 'ns=2;s=streaming-point';
		const secondEnabledDevice = makeDevice({ useSubscription: true, publishingInterval: 3000 });
		secondEnabledDevice.name = 'streaming-device-2';
		secondEnabledDevice.dataPoints[0].nodeId = 'ns=2;s=streaming-point-2';
		const logger = silentLogger();
		const adapter = new OPCUAAdapter([disabledDevice, enabledDevice, secondEnabledDevice], logger);
		const { device: composite, nodeIdToDevice } = (adapter as any).buildCompositeDevice([disabledDevice, enabledDevice, secondEnabledDevice]);
		const { wrapper, session } = makeSessionWrapper(100);
		const groups = installGroupFactory();
		session.createSubscription2 = groups.createSubscription;
		wrapper.validatedNodes = new Set(composite.dataPoints.map(point => point.nodeId));

		expect(composite.connection.useSubscription).toBe(true);
		expect(composite.connection.publishingInterval).toBe(2000);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('subscription settings differ'));
		await (adapter as any).createSubscription(composite.name, composite, wrapper, nodeIdToDevice, new Set());

		expect((ClientMonitoredItemGroup.create as jest.Mock).mock.calls[0][1]).toEqual([
			{ nodeId: 'ns=2;s=streaming-point', attributeId: 13 },
			{ nodeId: 'ns=2;s=streaming-point-2', attributeId: 13 },
		]);
		await (adapter as any).terminateSubscriptions(wrapper);
	});

	it('terminates partially failed subscriptions and retries smaller batches', async () => {
		const device = makeDevice({ maxMonitoredItemsPerSubscription: 4 }, 4);
		const { wrapper, session } = makeSessionWrapper(4);
		const groups = installGroupFactory({ statusByNode: { 'ns=2;s=point-1': false } });
		session.createSubscription2 = groups.createSubscription;
		wrapper.validatedNodes = new Set(device.dataPoints.map(point => point.nodeId));
		const adapter = new OPCUAAdapter([device], silentLogger());

		await (adapter as any).createSubscription(device.name, device, wrapper, new Map(), new Set());

		expect((ClientMonitoredItemGroup.create as jest.Mock).mock.calls.map(call => call[1].length)).toEqual([4, 2, 2, 1, 1]);
		expect(groups.subscriptions.filter(subscription => subscription.terminate.mock.calls.length > 0)).toHaveLength(3);
		expect(wrapper.subscriptions).toHaveLength(2);
		expect(wrapper.monitoredItems.size).toBe(3);
		await (adapter as any).terminateSubscriptions(wrapper);
	});

	it('terminates the previous subscription set before recreating it and reconnects on unexpected termination', async () => {
		const device = makeDevice();
		const { wrapper, session } = makeSessionWrapper(100);
		const groups = installGroupFactory();
		session.createSubscription2 = groups.createSubscription;
		wrapper.validatedNodes = new Set(device.dataPoints.map(point => point.nodeId));
		const adapter = new OPCUAAdapter([device], silentLogger());
		const reconnect = jest.spyOn(adapter as any, 'scheduleReconnect').mockImplementation(() => {});

		await (adapter as any).createSubscription(device.name, device, wrapper, new Map(), new Set());
		const previousSubscription = wrapper.subscription;
		await (adapter as any).createSubscription(device.name, device, wrapper, new Map(), new Set());

		expect(previousSubscription.terminate).toHaveBeenCalledTimes(1);
		expect(wrapper.subscriptions).toHaveLength(1);
		expect(wrapper.monitoredItems.size).toBe(1);

		wrapper.subscription.emit('terminated');
		expect(wrapper.subscriptions).toHaveLength(0);
		expect(wrapper.subscription).toBeNull();
		expect(wrapper.monitoredItems.size).toBe(0);
		expect(reconnect).toHaveBeenCalledWith(device, wrapper, 'subscription_terminated');
	});
});
