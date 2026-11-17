import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { ClientMonitoredItemGroup, coerceNodeId } from 'node-opcua-client';
import { AdapterManager } from '../../../../src/plugins/index';
import { OPCUAAdapter } from '../../../../src/plugins/opcua/adapter';
import { OPCUADeviceClient } from '../../../../src/plugins/opcua/client';
import { EndpointModel } from '../../../../src/db/models/endpoint.model';
import { DeviceModel } from '../../../../src/db/models/device.model';
import { PrivateEvidenceRegistry } from '../../../../src/points/private-evidence-registry';
import { PrivateShadowObserver } from '../../../../src/points/private-shadow-observer';
import { runMigrations } from '../../../../src/db/migration-runner';
import * as sqlite from '../../../../src/db/sqlite';
import { PointIdentityCatalog } from '../../../../src/points/point-identity-catalog';

jest.mock('../../../../src/plugins/opcua/client');

const MockClient = OPCUADeviceClient as jest.MockedClass<typeof OPCUADeviceClient>;
const good = { isGood: () => true, name: 'Good', description: '' };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
let wrappers: any[];
let groups: any[];
let readValues: (nodes: any[]) => any[];
let repairDuringValidation: boolean;
let namespaceReader: () => Promise<string[]>;

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
	session.readNamespaceArray = jest.fn().mockResolvedValue(['stale cached value']);
	session.read = jest.fn().mockImplementation((nodes: any[] | { nodeId: string }) => {
		if (!Array.isArray(nodes)) {
			if (nodes.nodeId !== 'ns=0;i=2255') throw new Error('Unexpected single-node read');
			return namespaceReader().then(value => ({ statusCode: good, value: { value } }));
		}
		if (repairDuringValidation) {
			repairDuringValidation = false;
			namespaceReader = async () => { throw new Error('Namespace unavailable'); };
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
	let logs: any[];

	beforeEach(() => {
		wrappers = [];
		groups = [];
		managers = [];
		adapters = [];
		sockets = [];
		logs = [];
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
		logs.push(log);
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

	describe('production OPC UA identity resolution', () => {
		let db: DatabaseSync;
		const standard = 'http://opcfoundation.org/UA/';

		beforeEach(() => {
			db = new DatabaseSync(':memory:');
			runMigrations(db);
			jest.spyOn(sqlite, 'getDatabase').mockReturnValue(db);
			namespaceReader = async () => [standard, 'urn:other', 'urn:plc'];
		});

		afterEach(async () => {
			for (const adapter of adapters) await adapter.stop();
			await tick();
			db.close();
		});

		function insert(row: any): void {
			db.prepare(`
				INSERT INTO endpoints (id, uuid, name, protocol, enabled, poll_interval, connection, data_points)
				VALUES (?, ?, ?, ?, 1, ?, ?, ?)
			`).run(row.id, row.uuid, row.name, row.protocol, row.poll_interval,
				JSON.stringify(row.connection), JSON.stringify(row.data_points));
		}

		async function waitForCount(count: number): Promise<void> {
			for (let attempt = 0; attempt < 100; attempt++) {
				const result = db.prepare('SELECT count(*) AS count FROM point_identity').get();
				if (result?.count === count) {
					await tick();
					return;
				}
				await new Promise(resolve => setTimeout(resolve, 10));
			}
			throw new Error(`Timed out waiting for ${count} identities: ${JSON.stringify(logs.map(log => log.warnSync.mock.calls))}`);
		}

		function identityMap(): Map<string, string> {
			const rows = db.prepare('SELECT address_key, point_uuid FROM point_identity_address').all() as
				Array<{ address_key: string; point_uuid: string }>;
			return new Map(rows.map(row => [JSON.parse(row.address_key)[2] as string, row.point_uuid]));
		}

		it('creates distinct identities for same-named nodes and attaches the right UUID to each reading', async () => {
			const row = endpoint(1, 'source-1', 'plc', ['ns=2;s=a', 'ns=2;s=b', 'ns=2;s=c']);
			insert(row);
			readValues = nodes => nodes.map((node, index) => {
				node.nodeId = coerceNodeId(node.nodeId);
				return { statusCode: good, value: { value: index + 10 } };
			});
			const { adapter, device, socket } = await start([row], undefined, false);
			await waitForCount(3);
			const identities = identityMap();
			expect(new Set(identities.values()).size).toBe(3);

			const readings = await adapter.readDeviceData(device.name, device);
			adapter.emit('data', readings);
			const enriched = socket.sendData.mock.calls[0][0];
			expect(enriched.map((point: any) => point.metric)).toEqual(['same-name', 'same-name', 'same-name']);
			expect(enriched.map((point: any) => point.pointUuid)).toEqual([
				identities.get('a'), identities.get('b'), identities.get('c'),
			]);
			expect(enriched.every((point: any) => !('nodeId' in point))).toBe(true);
		});

		it('reuses identities after reconnect, point rename, and namespace index remapping', async () => {
			const row = endpoint(1, 'source-1', 'plc', ['ns=2;s=a', 'ns=2;s=b']);
			insert(row);
			const first = await start([row], undefined, false);
			await waitForCount(2);
			const original = identityMap();
			await first.adapter.stop();

			const changed = {
				...row,
				data_points: row.data_points.map((point: any) => ({
					...point, name: 'renamed', nodeId: point.nodeId.replace('ns=2;', 'ns=1;'),
				})),
			};
			db.prepare('UPDATE endpoints SET data_points = ? WHERE uuid = ?')
				.run(JSON.stringify(changed.data_points), row.uuid);
			namespaceReader = async () => [standard, 'urn:plc', 'urn:other'];
			const second = await start([changed], undefined, false);
			await waitForCount(2);
			for (let attempt = 0; attempt < 100 && !second.manager.getOpcuaNamespaceEvidence(changed); attempt++) {
				await new Promise(resolve => setTimeout(resolve, 10));
			}
			const readings = await second.adapter.readDeviceData(second.device.name, second.device);
			second.adapter.emit('data', readings);
			expect(second.socket.sendData.mock.calls[0][0].map((point: any) => point.pointUuid))
				.toEqual([original.get('a'), original.get('b')]);
			expect(identityMap()).toEqual(original);
		});

		it('resolves pooled endpoints independently', async () => {
			const first = endpoint(1, 'source-1', 'plc-1', ['ns=2;s=a']);
			const second = endpoint(2, 'source-2', 'plc-2', ['ns=2;s=b']);
			insert(first);
			insert(second);
			const { manager } = await start([first, second], undefined, false);
			await waitForCount(2);
			expect(wrappers).toHaveLength(1);
			expect(manager.getOpcuaNamespaceEvidence(first)?.validatedNodeIds.has('ns=2;s=a')).toBe(true);
			expect(manager.getOpcuaNamespaceEvidence(second)?.validatedNodeIds.has('ns=2;s=b')).toBe(true);
			const sources = db.prepare('SELECT endpoint_uuid FROM point_identity ORDER BY endpoint_uuid').all();
			expect(sources.map(source => source.endpoint_uuid)).toEqual(['source-1', 'source-2']);
		});

		it('does not trust pooled namespace evidence for a source with different session credentials', async () => {
			const first = endpoint(1, 'source-1', 'plc-1', ['ns=2;s=a']);
			const second = endpoint(2, 'source-2', 'plc-2', ['ns=2;s=b']);
			first.connection = { ...first.connection, username: 'operator', password: 'first' };
			second.connection = { ...second.connection, username: 'operator', password: 'second' };
			insert(first);
			insert(second);
			const { manager } = await start([first, second], undefined, false);
			await waitForCount(1);
			expect(manager.getOpcuaNamespaceEvidence(first)).toBeDefined();
			expect(manager.getOpcuaNamespaceEvidence(second)).toBeUndefined();
			const sources = db.prepare('SELECT endpoint_uuid FROM point_identity').all();
			expect(sources.map(source => source.endpoint_uuid)).toEqual(['source-1']);
		});

		it('rejects a late NamespaceArray result from an obsolete session epoch', async () => {
			const row = endpoint(1, 'source-1', 'plc', ['ns=2;s=a']);
			insert(row);
			let finishOld: (uris: string[]) => void = () => { throw new Error('Missing pending read'); };
			let calls = 0;
			namespaceReader = () => {
				calls++;
				if (calls === 1) return new Promise(resolve => { finishOld = resolve; });
				return Promise.resolve([standard, 'urn:other', 'urn:current']);
			};
			const { manager } = await start([row], undefined, false);
			wrappers[0].session.emit('session_repaired');
			await waitForCount(1);
			finishOld([standard, 'urn:other', 'urn:obsolete']);
			await tick();
			const address = db.prepare('SELECT address_key FROM point_identity_address').get();
			expect(JSON.parse(String(address?.address_key))[0]).toBe('urn:current');
			expect(manager.getOpcuaNamespaceEvidence(row)?.namespaceArray[2]).toBe('urn:current');
		});

		it('rereads NamespaceArray from the server after repair instead of using the session cache', async () => {
			const row = endpoint(1, 'source-1', 'plc', ['ns=2;s=a']);
			insert(row);
			const { manager } = await start([row], undefined, false);
			await waitForCount(1);
			namespaceReader = async () => [standard, 'urn:other', 'urn:repaired'];
			wrappers[0].session.emit('session_repaired');
			await waitForCount(2);
			expect(wrappers[0].session.readNamespaceArray).not.toHaveBeenCalled();
			expect(manager.getOpcuaNamespaceEvidence(row)?.namespaceArray[2]).toBe('urn:repaired');
		});

		it('correlates subscription readings by monitored NodeId', async () => {
			const row = endpoint(1, 'source-1', 'plc', ['ns=2;s=a', 'ns=2;s=b'], true);
			insert(row);
			jest.mocked(ClientMonitoredItemGroup.create).mockImplementationOnce((_subscription, items) => {
				const group = new EventEmitter() as any;
				for (const item of items) item.nodeId = coerceNodeId(item.nodeId);
				group.monitoredItems = items.map(() => new EventEmitter());
				groups.push(group);
				setImmediate(() => group.emit('initialized'));
				return group;
			});
			jest.useFakeTimers({ doNotFake: ['setImmediate'] });
			try {
				const { socket } = await start([row], undefined, false);
				await waitForCount(2);
				const identities = identityMap();
				groups[0].emit('changed', groups[0].monitoredItems[1], { statusCode: good, value: { value: 42 } }, 1);
				jest.advanceTimersByTime(1100);
				await tick();
				expect(socket.sendData.mock.calls[0][0][0]).toMatchObject({
					metric: 'same-name', value: 42, pointUuid: identities.get('b'),
				});
			} finally {
				jest.useRealTimers();
			}
		});

		it('does not attach a new-session UUID to a poll result from before session repair', async () => {
			const row = endpoint(1, 'source-1', 'plc', ['ns=2;s=a']);
			insert(row);
			const { adapter, device, socket } = await start([row], undefined, false);
			await waitForCount(1);
			let finishRead: (values: any[]) => void = () => { throw new Error('Missing pending poll'); };
			const runtimeClient = adapter.clients.get(device.name);
			jest.spyOn(runtimeClient, 'read').mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
			const pending = adapter.readDeviceData(device.name, device);
			wrappers[0].session.emit('session_repaired');
			await tick();
			finishRead([{ statusCode: good, value: { value: 55 } }]);
			adapter.emit('data', await pending);
			expect(socket.sendData.mock.calls[0][0][0]).toMatchObject({ metric: 'same-name', value: 55 });
			expect(socket.sendData.mock.calls[0][0][0].pointUuid).toBeUndefined();
		});

		it('leaves telemetry running during identity failure and retries without reconnecting', async () => {
			const row = endpoint(1, 'source-1', 'plc', ['ns=2;s=a']);
			insert(row);
			const create = jest.spyOn(PointIdentityCatalog.prototype, 'createIdentityIfAbsent')
				.mockRejectedValueOnce(new Error('Transient identity failure'));
			jest.useFakeTimers({ doNotFake: ['setImmediate'] });
			try {
				const { adapter, device, socket } = await start([row], undefined, false);
				for (let attempt = 0; attempt < 100 && create.mock.calls.length === 0; attempt++) await tick();
				await tick();
				const readings = await adapter.readDeviceData(device.name, device);
				adapter.emit('data', readings);
				expect(socket.sendData.mock.calls[0][0][0]).toMatchObject({ metric: 'same-name', value: 10 });
				expect(socket.sendData.mock.calls[0][0][0].pointUuid).toBeUndefined();
				await jest.advanceTimersByTimeAsync(5000);
				await tick();
				expect(db.prepare('SELECT count(*) AS count FROM point_identity').get()?.count).toBe(1);
				expect(wrappers).toHaveLength(1);
			} finally {
				jest.useRealTimers();
			}
		});

		it('retries a transient failure to verify a previously valid node', async () => {
			const row = endpoint(1, 'source-1', 'plc', ['ns=2;s=a']);
			insert(row);
			const { manager } = await start([row], undefined, false);
			await waitForCount(1);
			const read = wrappers[0].session.read;
			const originalRead = read.getMockImplementation();
			let fail = true;
			read.mockImplementation((nodes: any) => {
				if (Array.isArray(nodes) && nodes.length === 1 && fail) {
					fail = false;
					return Promise.resolve([{ statusCode: { isGood: () => false } }]);
				}
				return originalRead(nodes);
			});
			jest.useFakeTimers({ doNotFake: ['setImmediate'] });
			try {
				wrappers[0].session.emit('session_repaired');
				for (let attempt = 0; attempt < 10 && fail; attempt++) await tick();
				await tick();
				expect(manager.getOpcuaNamespaceEvidence(row)?.validatedNodeIds.has('ns=2;s=a')).toBe(false);
				await jest.advanceTimersByTimeAsync(5000);
				await tick();
				expect(manager.getOpcuaNamespaceEvidence(row)?.validatedNodeIds.has('ns=2;s=a')).toBe(true);
				expect(db.prepare('SELECT count(*) AS count FROM point_identity').get()?.count).toBe(1);
			} finally {
				jest.useRealTimers();
			}
		});

		it('keeps invalid namespace evidence deferred without stopping telemetry', async () => {
			const row = endpoint(1, 'source-1', 'plc', ['ns=2;s=a']);
			insert(row);
			namespaceReader = async () => ['invalid'];
			const { adapter, device, manager, socket } = await start([row], undefined, false);
			await tick();
			expect(manager.getOpcuaNamespaceEvidence(row)).toBeUndefined();
			expect(db.prepare('SELECT count(*) AS count FROM point_identity').get()?.count).toBe(0);
			adapter.emit('data', await adapter.readDeviceData(device.name, device));
			expect(socket.sendData.mock.calls[0][0][0]).toMatchObject({ metric: 'same-name', value: 10 });
			expect(socket.sendData.mock.calls[0][0][0].pointUuid).toBeUndefined();
		});
	});

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
