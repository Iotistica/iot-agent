import { AdapterManager } from '../../../../src/plugins/index';
import { MqttAdapter, type MqttShadowOptions } from '../../../../src/plugins/mqtt/adapter';
import type { MqttAdapterConfig, MqttDevice } from '../../../../src/plugins/mqtt/types';
import { EndpointModel, type Endpoint } from '../../../../src/db/models/endpoint.model';
import { DeviceModel } from '../../../../src/db/models/device.model';
import { PrivateEvidenceRegistry } from '../../../../src/points/private-evidence-registry';
import { PrivateShadowObserver } from '../../../../src/points/private-shadow-observer';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const agentLogger = { infoSync: jest.fn(), warnSync: jest.fn(), errorSync: jest.fn(), debugSync: jest.fn() };

function device(overrides: Partial<MqttDevice> = {}): MqttDevice {
	return {
		name: 'source', enabled: true, baseTopic: 'factory', subscriptionTopic: 'factory/#',
		dataType: 'string', ...overrides,
	};
}

function config(devices: MqttDevice[]): MqttAdapterConfig {
	return { broker: { host: 'localhost', port: 1883 }, qos: 1, reconnect: { period: 1000, maxAttempts: 2 }, devices };
}

describe('MQTT private shadow integration', () => {
	let registry: PrivateEvidenceRegistry;
	let observer: PrivateShadowObserver;
	let adapters: MqttAdapter[];
	let managers: AdapterManager[];
	let originalBroker: string | undefined;

	beforeEach(() => {
		registry = new PrivateEvidenceRegistry(10, 10);
		observer = new PrivateShadowObserver(registry);
		adapters = [];
		managers = [];
		originalBroker = process.env.MQTT_BROKER_URL;
		process.env.MQTT_BROKER_URL = 'mqtt://localhost:1883';
		jest.spyOn(EndpointModel, 'updateLastSeenByName').mockResolvedValue(undefined);
		jest.spyOn(DeviceModel, 'updateLastSeenByEndpointName').mockResolvedValue(undefined);
	});

	afterEach(async () => {
		for (const manager of managers) await manager.stop();
		for (const adapter of adapters) await adapter.stop();
		await observer.dispose();
		registry.dispose();
		if (originalBroker === undefined) delete process.env.MQTT_BROKER_URL;
		else process.env.MQTT_BROKER_URL = originalBroker;
		jest.restoreAllMocks();
	});

	function create(devices: MqttDevice[], enabled = true): MqttAdapter {
		const sources = devices.map((configuration, index) => ({ configuration, endpointUuid: `endpoint-${index}` }));
		const shadow: MqttShadowOptions | undefined = enabled ? { registry, observer, sources } : undefined;
		const adapter = new MqttAdapter(config(devices), logger, 'agent', shadow);
		(adapter as any).connected = true;
		(adapter as any).shadowTransportReady = true;
		adapters.push(adapter);
		return adapter;
	}

	function inspect(point: object): any {
		const result = registry.correlation(point);
		return result.status === 'ok' ? registry.inspect(result.value) : result;
	}

	async function send(adapter: MqttAdapter, payload: string, topic = 'factory/line'): Promise<any> {
		let result: any;
		const listener = (points: object[]) => {
			result = { points, decisions: points.map(inspect) };
		};
		adapter.on('data', listener);
		(adapter as any).handleMessage(topic, Buffer.from(payload), true);
		await tick();
		await tick();
		adapter.off('data', listener);
		return result;
	}

	it('correlates concrete topics with actual configured traversal, including arrays and null', async () => {
		const adapter = create([device({
			allowArrayMetrics: true,
			metrics: [
				{ field: 'motor.speed', metric: 'nested' },
				{ field: 'list[0]', metric: 'array' },
				{ field: 'obj.0', metric: 'key' },
				{ field: 'nullable', metric: 'null' },
				{ field: 'missing', metric: 'missing' },
			],
		})]);
		const result = await send(adapter, JSON.stringify({
			'motor.speed': 99, motor: { speed: 5 }, list: [6], obj: { '0': 7 }, nullable: null,
		}), 'factory/line/sensor');
		expect(result.points.map((point: any) => point.metric)).toEqual(['nested', 'array', 'key', 'null']);
		expect(result.decisions.map((decision: any) => decision.observed)).toEqual([
			{ protocol: 'mqtt', topic: 'factory/line/sensor', origin: 'configured', selector: { kind: 'path', tokens: [
				{ kind: 'key', key: 'motor' }, { kind: 'key', key: 'speed' },
			] } },
			{ protocol: 'mqtt', topic: 'factory/line/sensor', origin: 'configured', selector: { kind: 'path', tokens: [
				{ kind: 'key', key: 'list' }, { kind: 'index', index: 0 },
			] } },
			{ protocol: 'mqtt', topic: 'factory/line/sensor', origin: 'configured', selector: { kind: 'path', tokens: [
				{ kind: 'key', key: 'obj' }, { kind: 'key', key: '0' },
			] } },
			{ protocol: 'mqtt', topic: 'factory/line/sensor', origin: 'configured', selector: { kind: 'path', tokens: [
				{ kind: 'key', key: 'nullable' },
			] } },
		]);
		const literalOnly = await send(adapter, '{"motor.speed":99}');
		expect(literalOnly.decisions[0].observed).toMatchObject({
			origin: 'fallback', selector: { kind: 'path', tokens: [{ kind: 'key', key: 'motor.speed' }] },
		});
	});

	it('distinguishes automatic literal dotted keys from fallback and whole-message selection', async () => {
		const automatic = create([device({ autoMetrics: true })]);
		let result = await send(automatic, JSON.stringify({ 'motor.speed': 2, motor: { speed: 3 }, nullable: null }));
		expect(result.decisions.map((d: any) => d.observed)).toEqual([
			expect.objectContaining({ origin: 'automatic', selector: { kind: 'path', tokens: [{ kind: 'key', key: 'motor.speed' }] } }),
			expect.objectContaining({ origin: 'automatic', selector: { kind: 'path', tokens: [{ kind: 'key', key: 'nullable' }] } }),
		]);
		await automatic.stop();
		const fallback = create([device()]);
		result = await send(fallback, '42');
		expect(result.decisions[0].observed).toMatchObject({ origin: 'fallback', selector: { kind: 'whole' } });
		result = await send(fallback, '{"value":null}');
		expect(result.decisions[0].observed).toMatchObject({
			origin: 'fallback', selector: { kind: 'path', tokens: [{ kind: 'key', key: 'value' }] },
		});
		result = await send(fallback, '{"motor.speed":2}');
		expect(result.decisions[0].observed).toMatchObject({
			origin: 'fallback', selector: { kind: 'path', tokens: [{ kind: 'key', key: 'motor.speed' }] },
		});
		result = await send(fallback, '{"motor":{"speed":2}}');
		expect(result.decisions[0]).toMatchObject({ reason: 'correlation-missing' });
	});

	it('rejects overlapping filters and duplicate subscription memberships without changing delivery', async () => {
		const adapter = create([
			device({ name: 'first', subscriptionTopic: 'factory/#' }),
			device({ name: 'second', subscriptionTopic: 'factory/+' }),
		]);
		const result = await send(adapter, '42');
		expect(result.points).toHaveLength(1);
		expect(result.decisions[0]).toMatchObject({ reason: 'correlation-missing' });
		await adapter.stop();
		const duplicate = create([
			device({ name: 'first' }), device({ name: 'second' }),
		]);
		expect((await send(duplicate, '42')).decisions[0]).toMatchObject({ reason: 'correlation-missing' });
	});

	it('transfers correlation through display and manager clones', async () => {
		const adapter = create([device({ displayName: 'Display' })]);
		const manager = new AdapterManager({ mqtt: { enabled: true } }, agentLogger as any, 'agent', undefined, { registry, observer });
		managers.push(manager);
		let cloned: any;
		const socket = { sendData: jest.fn((points: object[]) => { cloned = { points, decisions: points.map(inspect) }; }) };
		(manager as any).wireAdapterEvents('mqtt', adapter, socket, new Map([['source', 'endpoint-0']]), { registry, observer });
		const result = await send(adapter, '42');
		expect(cloned.decisions[0]).toMatchObject({
			claimedEndpointUuid: 'endpoint-0', phase: 'adapter-dispatched',
			observed: { topic: 'factory/line', selector: { kind: 'whole' } },
		});
		expect(cloned.points[0]).not.toBe(result.points[0]);
		expect(cloned.points[0].resolvedDisplayName).toBe('Display');
	});

	it('invalidates queued evidence on disconnect, reconnect, configuration update and disposal', async () => {
		const adapter = create([device()]);
		let release!: () => void;
		const blocked = new Promise<void>(resolve => { release = resolve; });
		let observedPoint: object | undefined;
		adapter.on('data', async (points: object[]) => { observedPoint = points[0]; await blocked; });
		(adapter as any).handleMessage('factory/line', Buffer.from('42'), true);
		expect(observedPoint).toBeDefined();
		expect(inspect(observedPoint!)).toMatchObject({ status: 'candidate-observed' });
		(adapter as any).brokerClient.handlers.onOffline();
		expect(inspect(observedPoint!)).toMatchObject({ reason: 'stale-observation' });
		release();
		await tick();
		(adapter as any).brokerClient.handlers.onReconnect(1, 1000);
		expect((await send(adapter, '43')).decisions[0]).toMatchObject({ reason: 'correlation-missing' });
		const client = { subscribe: jest.fn((_topic, _options, callback) => callback(null)), options: { clientId: 'agent' } };
		(adapter as any).brokerClient.handlers.onConnect(client, { sessionPresent: true }, false);
		await tick();
		const afterDisconnect = await send(adapter, '43');
		expect(afterDisconnect.decisions[0]).toMatchObject({ status: 'candidate-observed', transportGeneration: 4 });
		let releaseUpdate!: () => void;
		const updateBlocked = new Promise<void>(resolve => { releaseUpdate = resolve; });
		adapter.on('data', async (points: object[]) => { observedPoint = points[0]; await updateBlocked; });
		(adapter as any).handleMessage('factory/line', Buffer.from('44'), true);
		await tick();
		expect(inspect(observedPoint!)).toMatchObject({ status: 'candidate-observed' });
		await adapter.updateDevices([device()]);
		expect(inspect(observedPoint!)).toMatchObject({ reason: 'stale-observation' });
		releaseUpdate();
		await tick();
		const afterUpdate = await send(adapter, '45');
		expect(afterUpdate.decisions[0]).toMatchObject({ reason: 'correlation-missing' });
		await adapter.stop();
		const replacement = create([device()]);
		let releaseStop!: () => void;
		const stopBlocked = new Promise<void>(resolve => { releaseStop = resolve; });
		replacement.on('data', async (points: object[]) => { observedPoint = points[0]; await stopBlocked; });
		(replacement as any).handleMessage('factory/line', Buffer.from('46'), true);
		expect(inspect(observedPoint!)).toMatchObject({ status: 'candidate-observed' });
		await replacement.stop();
		expect(inspect(observedPoint!)).toMatchObject({ reason: 'stale-observation' });
		releaseStop();
		await tick();
	});

	it('keeps telemetry unchanged with evidence disabled or failing', async () => {
		jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-01-01T00:00:00.000Z');
		const disabled = create([device()], false);
		const baseline = await send(disabled, '42');
		await disabled.stop();
		const enabled = create([device()]);
		jest.spyOn(registry, 'observe').mockImplementation(() => { throw new Error('shadow failure'); });
		const failed = await send(enabled, '42');
		expect(failed.points).toEqual(baseline.points);
		expect(failed.decisions[0]).toMatchObject({ reason: 'correlation-missing' });
		expect(logger.warn).toHaveBeenCalledWith('MQTT shadow evidence failed; telemetry continues');
	});

	it('preserves all telemetry when observation capacity is exhausted', async () => {
		registry.dispose();
		registry = new PrivateEvidenceRegistry(10, 1);
		observer = new PrivateShadowObserver(registry);
		const adapter = create([device({ autoMetrics: true })]);
		const result = await send(adapter, '{"one":1,"two":2}');
		expect(result.points.map((point: any) => point.metric)).toEqual(['one', 'two']);
		expect(result.decisions[0]).toMatchObject({ status: 'candidate-observed' });
		expect(result.decisions[1]).toMatchObject({ reason: 'correlation-missing' });
		expect((await send(adapter, '42')).decisions[0]).toMatchObject({ status: 'candidate-observed' });
	});

	it('releases evidence when the existing queue is full or the observer fails', async () => {
		registry.dispose();
		registry = new PrivateEvidenceRegistry(10, 1);
		observer = new PrivateShadowObserver(registry);
		expect(observer.activate(jest.fn()).status).toBe('ok');
		const adapter = create([device()]);
		const observe = jest.spyOn(registry, 'observe');
		(adapter as any).processingEmitQueue = true;
		(adapter as any).emitQueue = Array.from({ length: 1000 }, () => []);
		(adapter as any).handleMessage('factory/line', Buffer.from('42'), true);
		const rejected = observe.mock.results[0].value;
		expect(rejected.status).toBe('ok');
		expect(registry.inspect(rejected.value)).toMatchObject({ reason: 'stale-observation' });
		(adapter as any).emitQueue = [];
		(adapter as any).processingEmitQueue = false;
		jest.spyOn(observer, 'submit').mockImplementation(() => { throw new Error('observer failure'); });
		const result = await send(adapter, '43');
		expect(result.points[0].value).toBe('43');
		expect(result.decisions[0]).toMatchObject({ status: 'candidate-observed' });
		expect(inspect(result.points[0])).toMatchObject({ reason: 'stale-observation' });
	});

	it('submits only successfully dispatched observations and isolates listener failures', async () => {
		const callback = jest.fn();
		expect(observer.activate(callback).status).toBe('ok');
		const adapter = create([device()]);
		const submit = jest.spyOn(observer, 'submit');
		const failure = jest.fn(() => { throw new Error('listener failure'); });
		adapter.on('data', failure);
		let result = await send(adapter, '42');
		expect(result.points[0].value).toBe('42');
		expect(submit).not.toHaveBeenCalled();
		expect(inspect(result.points[0])).toMatchObject({ reason: 'stale-observation' });
		adapter.off('data', failure);
		result = await send(adapter, '43');
		expect(result.points[0].value).toBe('43');
		expect(submit).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('binds only unique persistent endpoint records at the actual manager handoff', async () => {
		jest.spyOn(MqttAdapter.prototype, 'start').mockImplementation(async function (this: MqttAdapter) {
			(this as any).connected = true;
			(this as any).shadowTransportReady = true;
		});
		const manager = new AdapterManager({ mqtt: { enabled: true } }, agentLogger as any, 'agent', undefined, { registry, observer });
		managers.push(manager);
		const socket = { sendData: jest.fn(), sendControl: jest.fn(), stop: jest.fn().mockResolvedValue(undefined) };
		(manager as any).createSocketServer = jest.fn().mockResolvedValue(socket);
		(manager as any).ensureExternalPluginStartersRegistered = jest.fn().mockResolvedValue(undefined);
		const row: Endpoint = {
			id: 1, uuid: 'endpoint', name: 'source', protocol: 'mqtt', enabled: true, poll_interval: 5000,
			connection: { baseTopic: 'factory', subscriptionTopic: 'custom/+', dataType: 'string', autoMetrics: false }, data_points: [],
		};
		const getAll = jest.spyOn(EndpointModel, 'getAll').mockResolvedValue([row]);
		await manager.start();
		const adapter = (manager as any).adapters.get('mqtt') as MqttAdapter;
		const result = await send(adapter, '42');
		expect(result.decisions[0]).toMatchObject({ claimedEndpointUuid: 'endpoint', status: 'candidate-observed' });
		expect((adapter as any).subscriptions.has('factory/#')).toBe(true);
		expect((adapter as any).subscriptions.has('custom/+')).toBe(false);
		await manager.stop();
		const ambiguous = new AdapterManager({ mqtt: { enabled: true } }, agentLogger as any, 'agent', undefined, { registry, observer });
		managers.push(ambiguous);
		(ambiguous as any).createSocketServer = jest.fn().mockResolvedValue(socket);
		(ambiguous as any).ensureExternalPluginStartersRegistered = jest.fn().mockResolvedValue(undefined);
		getAll.mockResolvedValue([row, { ...row, id: 2, name: 'other', protocol: 'modbus' }]);
		await ambiguous.start();
		const ambiguousAdapter = (ambiguous as any).adapters.get('mqtt') as MqttAdapter;
		expect((await send(ambiguousAdapter, '42')).decisions[0]).toMatchObject({ reason: 'correlation-missing' });
		await ambiguous.stop();
		const explicitDevice = device({ uuid: 'endpoint', subscriptionTopic: 'custom/+' });
		const explicit = new AdapterManager({ mqtt: { enabled: true, config: config([explicitDevice]) } },
			agentLogger as any, 'agent', undefined, { registry, observer });
		managers.push(explicit);
		(explicit as any).createSocketServer = jest.fn().mockResolvedValue(socket);
		(explicit as any).ensureExternalPluginStartersRegistered = jest.fn().mockResolvedValue(undefined);
		getAll.mockResolvedValue([]);
		await explicit.start();
		const explicitAdapter = (explicit as any).adapters.get('mqtt') as MqttAdapter;
		expect((await send(explicitAdapter, '42', 'custom/line')).decisions[0]).toMatchObject({ reason: 'correlation-missing' });
		expect(await send(explicitAdapter, '42', 'factory/line')).toBeUndefined();
	});

	it('uses the grouped catch-all filter for missing bases and excludes disabled endpoints', async () => {
		jest.spyOn(MqttAdapter.prototype, 'start').mockImplementation(async function (this: MqttAdapter) {
			(this as any).connected = true;
			(this as any).shadowTransportReady = true;
		});
		const row: Endpoint = {
			id: 1, uuid: 'a', name: 'source', protocol: 'mqtt', enabled: true, poll_interval: 5000,
			connection: {}, data_points: [],
		};
		const getAll = jest.spyOn(EndpointModel, 'getAll').mockResolvedValue([
			row, { ...row, id: 2, uuid: 'b', name: 'disabled', enabled: false, connection: { baseTopic: 'factory' } },
		]);
		const manager = new AdapterManager({ mqtt: { enabled: true } }, agentLogger as any, 'agent', undefined, { registry, observer });
		managers.push(manager);
		(manager as any).createSocketServer = jest.fn().mockResolvedValue({ sendData: jest.fn(), sendControl: jest.fn() });
		(manager as any).ensureExternalPluginStartersRegistered = jest.fn().mockResolvedValue(undefined);
		await manager.start();
		const adapter = (manager as any).adapters.get('mqtt') as MqttAdapter;
		expect([...((adapter as any).subscriptions as Map<string, MqttDevice>).keys()]).toEqual(['#']);
		expect((adapter as any).shadow.activeFilters).toEqual(['#']);
		const result = await send(adapter, '42', 'factory/line');
		expect(result.points[0].value).toBe('42');
		expect(result.decisions[0]).toMatchObject({ claimedEndpointUuid: 'a', status: 'candidate-observed' });
		await manager.stop();
		getAll.mockResolvedValue([{ ...row, connection: { baseTopic: '' } }]);
		await manager.start();
		const emptyBase = (manager as any).adapters.get('mqtt') as MqttAdapter;
		expect([...((emptyBase as any).subscriptions as Map<string, MqttDevice>).keys()]).toEqual(['#']);
		expect((await send(emptyBase, '42', 'factory/line')).decisions[0]).toMatchObject({
			claimedEndpointUuid: 'a', status: 'candidate-observed',
		});
	});

	it('rejects overlapping subscriptions across manager groups', async () => {
		jest.spyOn(MqttAdapter.prototype, 'start').mockImplementation(async function (this: MqttAdapter) {
			(this as any).connected = true;
			(this as any).shadowTransportReady = true;
		});
		const row: Endpoint = {
			id: 1, uuid: 'a', name: 'first', protocol: 'mqtt', enabled: true, poll_interval: 5000,
			connection: { baseTopic: 'factory', dataType: 'string', autoMetrics: false }, data_points: [],
		};
		jest.spyOn(EndpointModel, 'getAll').mockResolvedValue([
			row, { ...row, id: 2, uuid: 'b', name: 'second', groupName: 'other', connection: { baseTopic: 'factory/line' } },
		]);
		const manager = new AdapterManager({ mqtt: { enabled: true } }, agentLogger as any, 'agent', undefined, { registry, observer });
		managers.push(manager);
		(manager as any).createSocketServer = jest.fn().mockResolvedValue({ sendData: jest.fn(), sendControl: jest.fn() });
		(manager as any).ensureExternalPluginStartersRegistered = jest.fn().mockResolvedValue(undefined);
		await manager.start();
		const adapter = (manager as any).adapters.get('mqtt') as MqttAdapter;
		const result = await send(adapter, '42', 'factory/line/sensor');
		expect(result.points).toHaveLength(1);
		expect(result.decisions[0]).toMatchObject({ reason: 'correlation-missing' });
	});

	it('invalidates other groups when a reload changes the default group filter', async () => {
		jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-01-01T00:00:00.000Z');
		jest.spyOn(MqttAdapter.prototype, 'start').mockImplementation(async function (this: MqttAdapter) {
			(this as any).connected = true;
			(this as any).shadowTransportReady = true;
		});
		const first: Endpoint = {
			id: 1, uuid: 'a', name: 'first', protocol: 'mqtt', enabled: true, poll_interval: 5000,
			connection: { baseTopic: 'alpha', dataType: 'string', autoMetrics: false }, data_points: [],
		};
		const second: Endpoint = {
			...first, id: 2, uuid: 'b', name: 'second', groupName: 'other',
			connection: { baseTopic: 'beta', dataType: 'string', autoMetrics: false },
		};
		jest.spyOn(EndpointModel, 'getAll').mockResolvedValue([first, second]);
		jest.spyOn(EndpointModel, 'getEnabled').mockResolvedValue([
			{ ...first, connection: { baseTopic: 'beta', dataType: 'string', autoMetrics: false } }, second,
		]);
		const manager = new AdapterManager({ mqtt: { enabled: true } }, agentLogger as any, 'agent', undefined, { registry, observer });
		managers.push(manager);
		(manager as any).createSocketServer = jest.fn().mockResolvedValue({ sendData: jest.fn(), sendControl: jest.fn() });
		(manager as any).ensureExternalPluginStartersRegistered = jest.fn().mockResolvedValue(undefined);
		await manager.start();
		const other = (manager as any).adapters.get('other') as MqttAdapter;
		const before = await send(other, '42', 'beta/line');
		expect(before.decisions[0]).toMatchObject({ claimedEndpointUuid: 'b', status: 'candidate-observed' });
		let release!: () => void;
		const blocked = new Promise<void>(resolve => { release = resolve; });
		let pending: object | undefined;
		const listener = async (points: object[]) => { pending = points[0]; await blocked; };
		other.on('data', listener);
		(other as any).handleMessage('beta/line', Buffer.from('42'), true);
		await tick();
		expect(inspect(pending!)).toMatchObject({ status: 'candidate-observed' });
		await manager.reloadAdapterGroup('mqtt');
		expect(inspect(pending!)).toMatchObject({ reason: 'stale-observation' });
		release();
		await tick();
		other.off('data', listener);
		const after = await send(other, '42', 'beta/line');
		expect(after.points).toEqual(before.points);
		expect(after.decisions[0]).toMatchObject({ reason: 'correlation-missing' });
		const reloaded = (manager as any).adapters.get('mqtt') as MqttAdapter;
		expect((reloaded as any).subscriptions.has('beta/#')).toBe(true);
	});
});
