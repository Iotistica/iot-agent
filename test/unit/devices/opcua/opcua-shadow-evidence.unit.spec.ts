import { EventEmitter } from 'node:events';
import { ClientMonitoredItemGroup } from 'node-opcua-client';
import { AdapterManager } from '../../../../src/plugins/index';
import { OPCUAAdapter } from '../../../../src/plugins/opcua/adapter';
import { OPCUADeviceClient } from '../../../../src/plugins/opcua/client';
import { EndpointModel } from '../../../../src/db/models/endpoint.model';
import { DeviceModel } from '../../../../src/db/models/device.model';
import { PrivateEvidenceRegistry } from '../../../../src/points/private-evidence-registry';
import { PrivateShadowObserver } from '../../../../src/points/private-shadow-observer';

jest.mock('../../../../src/plugins/opcua/client');

const MockClient = OPCUADeviceClient as jest.MockedClass<typeof OPCUADeviceClient>;
const good = { isGood: () => true, name: 'Good', description: '' };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
let wrappers: any[];
let groups: any[];
let readValues: (nodes: any[]) => any[];
let repairDuringValidation: boolean;

function endpoint(id: number, uuid: string, name: string, nodes: string[], subscription = false): any {
	return {
		id, uuid, name, protocol: 'opcua', enabled: true, poll_interval: 60000,
		connection: { endpointUrl: 'opc.tcp://localhost:4840', useSubscription: subscription },
		data_points: nodes.map(nodeId => ({
			nodeId, name: 'same-name', nodeType: 'metric', semantic: 'metric',
			device_name: 'display', unit: 'C',
		})),
	};
}

function makeClient(): any {
	const session = new EventEmitter() as any;
	session.sessionId = { toString: () => 'session' };
	session.close = jest.fn().mockResolvedValue(undefined);
	session.read = jest.fn().mockImplementation((nodes: any[]) => {
		if (repairDuringValidation) {
			repairDuringValidation = false;
			session.emit('session_repaired');
		}
		return nodes.map((_, i) => ({
			statusCode: good, value: { value: [10, 2, 11, undefined][i % 4] },
		}));
	});
	session.createSubscription2 = jest.fn().mockImplementation(async () => {
		const subscription = new EventEmitter() as any;
		subscription.subscriptionId = 1;
		subscription.terminate = jest.fn().mockResolvedValue(undefined);
		return subscription;
	});
	const client = new EventEmitter() as any;
	const wrapper = {
		client, session, subscription: null, subscriptions: [], monitoredItems: new Map(),
		validatedNodes: new Set(), reconnecting: false, currentRetryDelay: 5000, consecutiveFailures: 0,
	};
	wrappers.push(wrapper);
	return {
		connect: jest.fn().mockResolvedValue(undefined),
		getSessionWrapper: jest.fn(() => wrapper),
		read: jest.fn().mockImplementation(async (nodes: any[]) => readValues(nodes)),
		cleanup: jest.fn().mockResolvedValue(undefined),
		disconnect: jest.fn().mockResolvedValue(undefined),
	};
}

describe('OPC UA private shadow integration', () => {
	let registry: PrivateEvidenceRegistry;
	let observer: PrivateShadowObserver;
	let managers: AdapterManager[];
	let adapters: OPCUAAdapter[];
	let sockets: any[];

	beforeEach(() => {
		wrappers = [];
		groups = [];
		managers = [];
		adapters = [];
		sockets = [];
		repairDuringValidation = false;
		readValues = nodes => nodes.map((_, i) => ({ statusCode: good, value: { value: i + 10 } }));
		registry = new PrivateEvidenceRegistry(10, 10);
		observer = new PrivateShadowObserver(registry);
		MockClient.mockReset();
		MockClient.mockImplementation(() => makeClient());
		jest.spyOn(EndpointModel, 'updateLastSeenByName').mockResolvedValue(undefined);
		jest.spyOn(DeviceModel, 'updateLastSeenByEndpointName').mockResolvedValue(undefined);
		jest.spyOn(ClientMonitoredItemGroup, 'create').mockImplementation((_subscription, items) => {
			const group = new EventEmitter() as any;
			group.monitoredItems = items.map(() => new EventEmitter());
			groups.push(group);
			setImmediate(() => group.emit('initialized'));
			return group;
		});
	});

	afterEach(async () => {
		for (const adapter of adapters) await adapter.stop();
		for (const manager of managers) await manager.stop();
		await observer.dispose();
		registry.dispose();
		jest.restoreAllMocks();
	});

	async function start(rows: any[], explicit?: any, enabled = true): Promise<any> {
		const log = { infoSync: jest.fn(), warnSync: jest.fn(), errorSync: jest.fn(), debugSync: jest.fn() };
		const manager = new AdapterManager(
			{ opcua: { enabled: true, ...(explicit && { config: { devices: [explicit] } }) } },
			log as any, 'agent', enabled ? { registry, observer } : undefined,
		);
		const socket = { sendData: jest.fn(), sendControl: jest.fn(), stop: jest.fn().mockResolvedValue(undefined) };
		managers.push(manager);
		sockets.push(socket);
		const devices = explicit ? [explicit] : rows.map(row => ({
			uuid: row.uuid, name: row.name, protocol: 'opcua', enabled: row.enabled,
			pollInterval: row.poll_interval, connection: row.connection, dataPoints: row.data_points,
		}));
		const sources = (manager as any).opcuaSourceBindings(devices, rows, explicit ? undefined : rows);
		const adapter = new OPCUAAdapter(devices, {
			debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
		}, enabled ? { registry, observer, sources } : undefined);
		adapters.push(adapter);
		(manager as any).wireAdapterEvents('opcua', adapter, socket, new Map(rows.map(row => [row.name, row.uuid])),
			enabled ? { registry, observer } : undefined);
		const device = devices[0];
		await (adapter as any).connectDevice(device);
		return { manager, adapter, device, socket };
	}

	function inspect(point: object): any {
		const result = registry.correlation(point);
		return result.status === 'ok' ? registry.inspect(result.value) : result;
	}

	it('correlates actual read slots, including identical names, through manager clones', async () => {
		const { adapter, device, socket } = await start([endpoint(1, 'source-1', 'plc', ['ns=2;s=a', 'ns=2;s=b'])]);
		const captured: any[] = [];
		socket.sendData.mockImplementation((points: object[]) => captured.push(points.map(inspect)));
		const points = await adapter.readDeviceData(device.name, device);
		const originals = points.map(inspect);
		expect(originals.map((d: any) => d.observed.nodeId)).toEqual(['ns=2;s=a', 'ns=2;s=b']);
		expect(points.map((p: any) => p.metric)).toEqual(['same-name', 'same-name']);
		expect(points.map((p: any) => p.value)).toEqual([10, 11]);
		adapter.emit('data', points);
		expect(captured[0].map((d: any) => [d.observed.nodeId, d.claimedEndpointUuid, d.phase])).toEqual([
			['ns=2;s=a', 'source-1', 'adapter-dispatched'],
			['ns=2;s=b', 'source-1', 'adapter-dispatched'],
		]);
		expect(socket.sendData.mock.calls[0][0][0]).not.toBe(points[0]);
		expect(points[0]).not.toHaveProperty('nodeId');
		expect(inspect(points[0])).toMatchObject({ reason: 'stale-observation' });
	});

	it('dispatches a delayed read in the production poll continuation before cleanup', async () => {
		const callback = jest.fn();
		expect(observer.activate(callback).status).toBe('ok');
		const { adapter, device, socket } = await start([endpoint(1, 'source-1', 'plc', ['ns=2;s=a'])]);
		const runtimeClient = adapter.clients.get(device.name);
		jest.spyOn(runtimeClient, 'read').mockImplementation(async (nodes: any[]) => {
			await tick();
			return readValues(nodes);
		});
		const order: string[] = [];
		let emitted: any[] = [];
		let received: any[] = [];
		let cloneDecision: any;
		socket.sendData.mockImplementation((points: object[]) => {
			order.push('socket');
			cloneDecision = inspect(points[0]);
		});
		adapter.on('data', (points: any[]) => {
			order.push('data');
			emitted = points;
		});
		adapter.connections.set(device.name, { connected: true, errorCount: 0, backoffDelay: 1000 });
		adapter.running = true;
		await new Promise<void>(resolve => {
			adapter.once('data-received', (_name: string, points: any[]) => {
				order.push('data-received');
				received = points;
				resolve();
			});
			adapter.startPolling(device);
		});
		expect(order).toEqual(['socket', 'data', 'data-received']);
		expect(received).toBe(emitted);
		expect(cloneDecision).toMatchObject({
			observed: { nodeId: 'ns=2;s=a' }, phase: 'adapter-dispatched',
		});
		expect(emitted[0]).toMatchObject({ metric: 'same-name', value: 10, unit: 'C', quality: 'GOOD' });
		expect(observer.getCounters().accepted).toBe(1);
		await tick();
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('releases capacity for poll results that are never dispatched', async () => {
		registry.dispose();
		registry = new PrivateEvidenceRegistry(10, 1);
		observer = new PrivateShadowObserver(registry);
		const { adapter, device } = await start([endpoint(1, 'source-1', 'plc', ['ns=2;s=a'])]);
		for (let i = 0; i < 3; i++) {
			const points = await adapter.readDeviceData(device.name, device);
			expect(inspect(points[0])).toMatchObject({ status: 'candidate-observed', phase: 'constructed' });
			await tick();
			expect(inspect(points[0])).toMatchObject({ reason: 'stale-observation' });
		}
	});

	it('drops evidence and propagates the original error when a data listener throws', async () => {
		registry.dispose();
		registry = new PrivateEvidenceRegistry(10, 1);
		observer = new PrivateShadowObserver(registry);
		const callback = jest.fn();
		expect(observer.activate(callback).status).toBe('ok');
		const submit = jest.spyOn(observer, 'submit');
		const { adapter, device, socket } = await start([endpoint(1, 'source-1', 'plc', ['ns=2;s=a'])]);
		const failure = new Error('legacy listener failure');
		const listener = jest.fn(() => { throw failure; });
		adapter.on('data', listener);
		const points = await adapter.readDeviceData(device.name, device);
		let thrown: unknown;
		try {
			adapter.emit('data', points);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBe(failure);
		expect(listener).toHaveBeenCalledWith(points);
		expect(socket.sendData).toHaveBeenCalledTimes(1);
		expect(socket.sendData.mock.calls[0][0][0]).toMatchObject({ metric: 'same-name', value: 10 });
		expect(submit).not.toHaveBeenCalled();
		expect(inspect(points[0])).toMatchObject({ reason: 'stale-observation' });
		adapter.off('data', listener);
		const next = await adapter.readDeviceData(device.name, device);
		expect(inspect(next[0])).toMatchObject({ status: 'candidate-observed' });
		adapter.emit('data', next);
		expect(submit).toHaveBeenCalledTimes(1);
		await tick();
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('keeps explicit in-memory and duplicate-source configurations unresolved', async () => {
		const row = endpoint(1, 'source-1', 'plc', ['ns=2;s=a']);
		const explicit = {
			...row, pollInterval: row.poll_interval, dataPoints: row.data_points,
			connection: { ...row.connection, useSubscription: false },
		};
		let run = await start([], explicit);
		let points = await run.adapter.readDeviceData(run.device.name, run.device);
		expect(inspect(points[0])).toMatchObject({ reason: 'correlation-missing' });
		await run.manager.stop();

		run = await start([row, endpoint(2, 'source-1', 'other', ['ns=2;s=b'])]);
		points = await run.adapter.readDeviceData(run.device.name, run.device);
		expect(inspect(points[0])).toMatchObject({ reason: 'correlation-missing' });
	});

	it('does not capture a read response with extra, uncorrelated results', async () => {
		const { adapter, device, socket } = await start([endpoint(1, 'source-1', 'plc', ['ns=2;s=a'])]);
		readValues = () => [
			{ statusCode: good, value: { value: 10 } },
			{ statusCode: good, value: { value: 20 } },
		];
		const points = await adapter.readDeviceData(device.name, device);
		expect(inspect(points[0])).toMatchObject({ reason: 'correlation-missing' });
		adapter.emit('data', points);
		expect(socket.sendData.mock.calls[0][0]).toHaveLength(1);
	});

	it('rejects duplicate pooled NodeIds, including equivalent NodeId spellings', async () => {
		const { adapter, device } = await start([
			endpoint(1, 'source-1', 'plc-a', ['i=42']),
			endpoint(2, 'source-2', 'plc-b', ['ns=0;i=42']),
		]);
		const points = await adapter.readDeviceData(device.name, device);
		expect(inspect(points[0])).toMatchObject({ reason: 'correlation-missing' });
	});

	it('correlates subscription item identity and rejects a mismatched item', async () => {
		const { adapter, socket } = await start([endpoint(1, 'source-1', 'plc', ['ns=2;s=a', 'ns=2;s=b'], true)]);
		const observed: any[] = [];
		socket.sendData.mockImplementation((points: object[]) => observed.push(points.map(inspect)));
		const data = { statusCode: good, value: { value: 10 } };
		groups[0].emit('changed', groups[0].monitoredItems[1], data, 1);
		groups[0].emit('changed', groups[0].monitoredItems[1], data, 0);
		await tick();
		expect(observed[0][0]).toMatchObject({ observed: { nodeId: 'ns=2;s=b' }, phase: 'adapter-dispatched' });
		expect(observed[0][1]).toMatchObject({ reason: 'correlation-missing' });
		expect(socket.sendData.mock.calls[0][0]).toHaveLength(2);
		expect(adapter).toBeDefined();
	});

	it('invalidates old observations on reconnect and disposal without retaining capacity', async () => {
		registry.dispose();
		registry = new PrivateEvidenceRegistry(10, 1);
		observer = new PrivateShadowObserver(registry);
		const { adapter, device } = await start([endpoint(1, 'source-1', 'plc', ['ns=2;s=a'])]);
		const points = await adapter.readDeviceData(device.name, device);
		const ref = registry.correlation(points[0]);
		expect(ref.status).toBe('ok');
		wrappers[0].client.emit('connection_lost');
		expect(inspect(points[0])).toMatchObject({ reason: 'stale-observation' });
		clearTimeout(wrappers[0].reconnectTimer);
		await adapter.attemptReconnect(device, wrappers[0]);
		const next = await adapter.readDeviceData(device.name, device);
		expect(inspect(next[0])).toMatchObject({ status: 'candidate-observed' });
		await adapter.stop();
		expect(inspect(next[0])).toMatchObject({ reason: 'stale-observation' });
		const replacement = await start([endpoint(1, 'source-1', 'plc', ['ns=2;s=a'])]);
		const afterDisposal = await replacement.adapter.readDeviceData(replacement.device.name, replacement.device);
		expect(inspect(afterDisposal[0])).toMatchObject({ status: 'candidate-observed' });
	});

	it('leaves old subscription callbacks unresolved after session replacement', async () => {
		const { adapter, device, socket } = await start([endpoint(1, 'source-1', 'plc', ['ns=2;s=a'], true)]);
		const oldGroup = groups[0];
		const observed: any[] = [];
		socket.sendData.mockImplementation((points: object[]) => observed.push(points.map(inspect)));
		wrappers[0].client.emit('connection_lost');
		clearTimeout(wrappers[0].reconnectTimer);
		await adapter.attemptReconnect(device, wrappers[0]);
		oldGroup.emit('changed', oldGroup.monitoredItems[0], { statusCode: good, value: { value: 10 } }, 0);
		await tick();
		expect(observed[0][0]).toMatchObject({ reason: 'correlation-missing' });
	});

	it('invalidates observations on adapter replacement and session repair', async () => {
		const row = endpoint(1, 'source-1', 'plc', ['ns=2;s=a']);
		const first = await start([row]);
		const points = await first.adapter.readDeviceData(first.device.name, first.device);
		await first.adapter.stop();
		expect(inspect(points[0])).toMatchObject({ reason: 'stale-observation' });
		const replacement = await start([row]);
		const next = await replacement.adapter.readDeviceData(replacement.device.name, replacement.device);
		expect(inspect(next[0])).toMatchObject({ status: 'candidate-observed' });
		wrappers[1].session.emit('session_repaired');
		expect(inspect(next[0])).toMatchObject({ reason: 'stale-observation' });
		const afterRepair = await replacement.adapter.readDeviceData(replacement.device.name, replacement.device);
		expect(inspect(afterRepair[0])).toMatchObject({ reason: 'correlation-missing' });
	});

	it('fails closed if a session is repaired before connection setup finishes', async () => {
		repairDuringValidation = true;
		const { adapter, device } = await start([endpoint(1, 'source-1', 'plc', ['ns=2;s=a'])]);
		const points = await adapter.readDeviceData(device.name, device);
		expect(inspect(points[0])).toMatchObject({ reason: 'correlation-missing' });
	});

	it('isolates observer and clone-transfer failures from telemetry', async () => {
		expect(observer.activate(() => { throw new Error('test callback'); }).status).toBe('ok');
		const { adapter, device, socket } = await start([endpoint(1, 'source-1', 'plc', ['ns=2;s=a'])]);
		const first = await adapter.readDeviceData(device.name, device);
		adapter.emit('data', first);
		await tick();
		await tick();
		expect(observer.getCounters().errors).toBe(1);
		const second = await adapter.readDeviceData(device.name, device);
		jest.spyOn(registry, 'transfer').mockImplementation(() => { throw new Error('transfer'); });
		adapter.emit('data', second);
		expect(socket.sendData).toHaveBeenCalledTimes(2);
		expect(inspect(second[0])).toMatchObject({ reason: 'stale-observation' });
	});

	it('leaves telemetry unchanged when disabled or evidence capacity is exhausted', async () => {
		jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-01-01T00:00:00.000Z');
		let run = await start([endpoint(1, 'source-1', 'plc', ['ns=2;s=a'])], undefined, false);
		let points = await run.adapter.readDeviceData(run.device.name, run.device);
		run.adapter.emit('data', points);
		expect(inspect(points[0])).toMatchObject({ reason: 'correlation-missing' });
		expect(run.socket.sendData).toHaveBeenCalledTimes(1);
		const disabledPayload = run.socket.sendData.mock.calls[0][0];
		await run.manager.stop();

		run = await start([endpoint(1, 'source-1', 'plc', ['ns=2;s=a'])]);
		points = await run.adapter.readDeviceData(run.device.name, run.device);
		run.adapter.emit('data', points);
		expect(run.socket.sendData.mock.calls[0][0]).toEqual(disabledPayload);
		await run.adapter.stop();

		registry.dispose();
		registry = new PrivateEvidenceRegistry(10, 1);
		observer = new PrivateShadowObserver(registry);
		run = await start([endpoint(1, 'source-1', 'plc', ['ns=2;s=a', 'ns=2;s=b'])]);
		points = await run.adapter.readDeviceData(run.device.name, run.device);
		expect(inspect(points[0])).toMatchObject({ status: 'candidate-observed' });
		expect(inspect(points[1])).toMatchObject({ reason: 'correlation-missing' });
		run.adapter.emit('data', points);
		expect(run.socket.sendData.mock.calls[0][0]).toHaveLength(2);
	});
});
