import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../../src/db/migration-runner';
import * as sqlite from '../../src/db/sqlite';
import { AdapterManager } from '../../src/plugins/index';
import { MqttAdapter } from '../../src/plugins/mqtt/adapter';
import type { MqttAdapterConfig, MqttDevice } from '../../src/plugins/mqtt/types';
import type { DeviceDataPoint } from '../../src/plugins/types';
import { resolveMqttConfiguredFields } from '../../src/points/mqtt-configured-fields';
import { canonicalizeAddress, CANONICAL_ADDRESS_VERSION } from '../../src/points/canonical-address';
import { PointIdentityCatalog } from '../../src/points/point-identity-catalog';
import { ConfiguredPointVerifier } from '../../src/points/configured-point-verifier';
import { EndpointModel } from '../../src/db/models/endpoint.model';
import { getConfiguredPointRows } from '../../src/api/configured-points';

const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const agentLogger = { infoSync: jest.fn(), warnSync: jest.fn(), errorSync: jest.fn(), debugSync: jest.fn() };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const field = (topic: string, ...keys: string[]) => ({
	topic, selector: { kind: 'path', tokens: keys.map(key => ({ kind: 'key', key })) },
});

describe('MQTT field identities', () => {
	let db: DatabaseSync;
	let adapter: MqttAdapter;
	let manager: AdapterManager;
	let endpointMap: Map<string, string>;

	function source(connection: Record<string, unknown>, dataPoints: unknown[] = []): void {
		db.prepare(`INSERT INTO endpoints (uuid, name, protocol, enabled, connection, data_points, poll_interval)
			VALUES (?, ?, 'mqtt', 1, ?, ?, 5000)`)
			.run('source-uuid', 'source', JSON.stringify(connection), JSON.stringify(dataPoints));
	}

	function runtime(overrides: Partial<MqttDevice> = {}): void {
		const device: MqttDevice = {
			name: 'source', enabled: true, baseTopic: 'factory/sim-002',
			subscriptionTopic: 'factory/sim-002/#', autoMetrics: true, dataType: 'number', ...overrides,
		};
		const config: MqttAdapterConfig = {
			broker: { host: 'localhost', port: 1883 }, qos: 1, reconnect: { period: 1000, maxAttempts: 1 }, devices: [device],
		};
		adapter = new MqttAdapter(config, logger, 'agent');
		(adapter as any).connected = true;
		manager = new AdapterManager({}, agentLogger as any, 'agent');
		endpointMap = new Map([['source', 'source-uuid']]);
	}

	async function send(topic: string, payload: string): Promise<DeviceDataPoint[]> {
		let result: DeviceDataPoint[] = [];
		const listener = (points: DeviceDataPoint[]) => {
			result = (manager as any).enrichWithEndpointUuid(points, endpointMap, undefined, adapter);
		};
		adapter.on('data', listener);
		(adapter as any).handleMessage(topic, Buffer.from(payload), true);
		for (let i = 0; i < 5; i++) await tick();
		adapter.off('data', listener);
		return result;
	}

	beforeEach(() => {
		db = new DatabaseSync(':memory:');
		const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
		runMigrations(db);
		consoleLog.mockRestore();
		jest.spyOn(sqlite, 'getDatabase').mockReturnValue(db);
	});

	afterEach(() => {
		jest.restoreAllMocks();
		db.close();
	});

	it('assigns stable distinct field UUIDs without reusing the whole-topic identity', async () => {
		const topic = 'factory/sim-002/telemetry';
		source({ baseTopic: 'factory/sim-002', pointIdentityFields: [
			field(topic, 'temperature'), field(topic, 'pressure'), field(topic, 'flow_rate'),
		] }, [{ name: 'telemetry', fullTopic: topic }, { name: 'status', fullTopic: 'factory/sim-002/status' }]);
		runtime();
		manager.mergePointIdentities(new Map([['source-uuid\0status', 'wrong-topic-uuid']]));
		const payload = JSON.stringify({ temperature: 23, pressure: 4, flow_rate: 5, dynamic: 6, status: 1 });
		expect((await send(topic, payload)).every(point => !point.pointUuid)).toBe(true);
		const points = await send(topic, payload);
		const uuids = points.slice(0, 3).map(point => point.pointUuid);
		expect(uuids.every(Boolean)).toBe(true);
		expect(new Set(uuids).size).toBe(3);
		expect(points[3].pointUuid).toBeUndefined();
		expect(points[4].pointUuid).toBeUndefined();
		expect(JSON.stringify(points)).not.toContain('selector');
		expect(JSON.stringify(points)).not.toContain('subscriptionTopic');
		const scalar = await send(topic, '42');
		expect(scalar[0].pointUuid).toBeTruthy();
		expect(uuids).not.toContain(scalar[0].pointUuid);
		const endpoint = await EndpointModel.getByUuid('source-uuid');
		if (!endpoint) throw new Error('test source is missing');
		const sourcePoints = getConfiguredPointRows(endpoint, db);
		expect(sourcePoints).toHaveLength(2);
		expect(sourcePoints[0].pointUuid).toBe(scalar[0].pointUuid);
		expect(sourcePoints[0].identityStatus).toBe('resolved');
		await adapter.updateDevices([{ ...(adapter as any).config.devices[0] }]);
		expect((await send(topic, payload)).slice(0, 3).map(point => point.pointUuid)).toEqual(uuids);
		runtime();
		await send(topic, payload);
		expect((await send(topic, payload)).slice(0, 3).map(point => point.pointUuid)).toEqual(uuids);
		expect(db.prepare('SELECT * FROM point_identity').all()).toHaveLength(5);
	});

	it('uses the concrete topic and exact nested selector instead of metric names', async () => {
		const first = 'factory/sim-002/a';
		const second = 'factory/sim-002/b';
		source({ baseTopic: 'factory/sim-002', pointIdentityFields: [
			field(first, 'one', 'temperature'), field(first, 'two', 'temperature'), field(second, 'one', 'temperature'),
		] });
		runtime({ autoMetrics: false, metrics: [
			{ field: 'one.temperature', metric: 'temperature' },
			{ field: 'two.temperature', metric: 'temperature' },
		] });
		const payload = '{"one":{"temperature":1},"two":{"temperature":2}}';
		await send(first, payload);
		const a = await send(first, payload);
		const b = await send(second, payload);
		expect(a[0].pointUuid).toBeTruthy();
		expect(a[1].pointUuid).toBeTruthy();
		expect(b[0].pointUuid).toBeTruthy();
		expect(new Set([a[0].pointUuid, a[1].pointUuid, b[0].pointUuid]).size).toBe(3);
		expect(b[1].pointUuid).toBeUndefined();
	});

	it('distinguishes array indexes from numeric object keys', async () => {
		const topic = 'factory/sim-002/telemetry';
		source({ baseTopic: 'factory/sim-002', pointIdentityFields: [
			{ topic, selector: { kind: 'path', tokens: [{ kind: 'key', key: 'values' }, { kind: 'index', index: 0 }] } },
			field(topic, 'object', '0'),
		] });
		runtime({ autoMetrics: false, allowArrayMetrics: true, metrics: [
			{ field: 'values[0]', metric: 'value' }, { field: 'object.0', metric: 'value' },
		] });
		const payload = '{"values":[5],"object":{"0":6}}';
		await send(topic, payload);
		const points = await send(topic, payload);
		expect(points[0].pointUuid).toBeTruthy();
		expect(points[1].pointUuid).toBeTruthy();
		expect(points[0].pointUuid).not.toBe(points[1].pointUuid);
	});

	it('preserves the UUID when only the displayed metric changes', async () => {
		const topic = 'factory/sim-002/telemetry';
		source({ baseTopic: 'factory/sim-002', pointIdentityFields: [field(topic, 'motor', 'speed')] });
		runtime({ autoMetrics: false, metrics: [{ field: 'motor.speed', metric: 'speed' }] });
		await send(topic, '{"motor":{"speed":5}}');
		const before = (await send(topic, '{"motor":{"speed":5}}'))[0].pointUuid;
		expect(before).toBeTruthy();
		runtime({ autoMetrics: false, metrics: [{ field: 'motor.speed', metric: 'motor_speed' }] });
		await send(topic, '{"motor":{"speed":5}}');
		expect((await send(topic, '{"motor":{"speed":5}}'))[0].pointUuid).toBe(before);
	});

	it('treats a renamed payload key as a different address', async () => {
		const topic = 'factory/sim-002/telemetry';
		source({ baseTopic: 'factory/sim-002', pointIdentityFields: [field(topic, 'speed'), field(topic, 'motor_speed')] });
		runtime();
		await send(topic, '{"speed":5,"motor_speed":5}');
		const points = await send(topic, '{"speed":5,"motor_speed":5}');
		expect(points[0].pointUuid).toBeTruthy();
		expect(points[1].pointUuid).toBeTruthy();
		expect(points[0].pointUuid).not.toBe(points[1].pointUuid);
	});

	it('fails closed for removed approvals, overlapping sources and missing provenance', async () => {
		const topic = 'factory/sim-002/telemetry';
		source({ baseTopic: 'factory/sim-002', pointIdentityFields: [field(topic, 'temperature')] });
		runtime();
		await send(topic, '{"temperature":1}');
		expect((await send(topic, '{"temperature":1}'))[0].pointUuid).toBeTruthy();
		db.prepare('UPDATE endpoints SET connection = ? WHERE uuid = ?')
			.run(JSON.stringify({ baseTopic: 'factory/sim-002' }), 'source-uuid');
		expect((await send(topic, '{"temperature":1}'))[0].pointUuid).toBeUndefined();
		db.prepare(`INSERT INTO endpoints (uuid, name, protocol, enabled, connection, poll_interval)
			VALUES ('other', 'other', 'mqtt', 1, ?, 5000)`)
			.run(JSON.stringify({ baseTopic: 'factory' }));
		expect((await send(topic, '{"temperature":1}'))[0].pointUuid).toBeUndefined();
		const forged: DeviceDataPoint = {
			deviceName: 'source', protocol: 'mqtt', metric: 'temperature', value: 1,
			timestamp: new Date().toISOString(), quality: 'GOOD', pointUuid: 'unverified',
		};
		expect((manager as any).enrichWithEndpointUuid([forged], endpointMap, undefined, adapter)[0].pointUuid).toBeUndefined();
	});

	it('rejects changed parsing settings even after the subscription is refreshed', async () => {
		const topic = 'factory/sim-002/telemetry';
		source({ baseTopic: 'factory/sim-002', pointIdentityFields: [field(topic, 'temperature')] });
		runtime();
		await send(topic, '{"temperature":1}');
		expect((await send(topic, '{"temperature":1}'))[0].pointUuid).toBeTruthy();
		const changed = { ...(adapter as any).config.devices[0], autoMetrics: false };
		await adapter.updateDevices([changed]);
		(adapter as any).subscriptions.set(changed.subscriptionTopic, changed);
		const point = (await send(topic, '{"temperature":1}'))[0];
		expect(point.value).toBe(1);
		expect(point.pointUuid).toBeUndefined();
	});

	it('rejects invalid and unbounded approval lists without approving discovery samples', () => {
		expect(resolveMqttConfiguredFields({ sampleFields: ['temperature'] })).toEqual({ status: 'resolved', fields: [] });
		expect(resolveMqttConfiguredFields({ pointIdentityFields: [field('factory/+', 'x')] }).status).toBe('invalid');
		expect(resolveMqttConfiguredFields({ pointIdentityFields: [field('factory/a', 'x'), field('factory/a', 'x')] }).status).toBe('invalid');
		expect(resolveMqttConfiguredFields({ pointIdentityFields: Array.from({ length: 1001 }, (_, i) => field('factory/a', String(i))) }).status).toBe('invalid');
	});

	it('requires the current configured approval even for a canonical request', async () => {
		const topic = 'factory/sim-002/telemetry';
		const approved = field(topic, 'temperature');
		source({ baseTopic: 'factory/sim-002', pointIdentityFields: [approved] });
		const resolverRef = {};
		const catalog = new PointIdentityCatalog(db, new ConfiguredPointVerifier(db, resolverRef));
		const input = {
			protocol: 'mqtt' as const, topic,
			selector: { kind: 'path' as const, tokens: [{ kind: 'key' as const, key: 'temperature' }] },
			selectorSource: 'configured' as const,
		};
		const canonical = canonicalizeAddress(input);
		if (canonical.status !== 'resolved') throw new Error('test address is invalid');
		const address = { endpointUuid: 'source-uuid', protocol: 'mqtt' as const, version: 1, key: canonical.addressKey };
		const evidence = { resolverRef, canonicalInput: input, endpointUuid: 'source-uuid', protocol: 'mqtt' };
		expect(await catalog.createIdentityIfAbsent(address, evidence)).toMatchObject({ status: 'resolved' });
		db.prepare('UPDATE endpoints SET connection = ? WHERE uuid = ?')
			.run(JSON.stringify({ baseTopic: 'factory/sim-002' }), 'source-uuid');
		expect(await catalog.createIdentityIfAbsent(address, evidence)).toMatchObject({
			status: 'unresolved', reason: 'evidence-missing',
		});
	});

	it('keeps the same canonical field separate under different endpoint UUIDs', async () => {
		const topic = 'factory/sim-002/telemetry';
		const connection = { baseTopic: 'factory/sim-002', pointIdentityFields: [field(topic, 'temperature')] };
		source(connection);
		db.prepare(`INSERT INTO endpoints (uuid, name, protocol, enabled, connection, poll_interval)
			VALUES ('second-uuid', 'second', 'mqtt', 1, ?, 5000)`).run(JSON.stringify(connection));
		const resolverRef = {};
		const catalog = new PointIdentityCatalog(db, new ConfiguredPointVerifier(db, resolverRef));
		const input = {
			protocol: 'mqtt' as const, topic,
			selector: { kind: 'path' as const, tokens: [{ kind: 'key' as const, key: 'temperature' }] },
			selectorSource: 'configured' as const,
		};
		const canonical = canonicalizeAddress(input);
		if (canonical.status !== 'resolved') throw new Error('test address is invalid');
		const create = (endpointUuid: string) => catalog.createIdentityIfAbsent(
			{ endpointUuid, protocol: 'mqtt', version: 1, key: canonical.addressKey },
			{ resolverRef, canonicalInput: input, endpointUuid, protocol: 'mqtt' },
		);
		const first = await create('source-uuid');
		const second = await create('second-uuid');
		expect(first.status).toBe('resolved');
		expect(second.status).toBe('resolved');
		if (first.status !== 'resolved' || second.status !== 'resolved') throw new Error('identity creation failed');
		expect(first.value.pointUuid).not.toBe(second.value.pointUuid);
	});

	it('enforces the lifetime cap atomically while allowing existing UUIDs to be reused', async () => {
		source({ baseTopic: 'factory/sim-002' });
		const catalog = new PointIdentityCatalog(db, { verify: () => true });
		const makeAddress = (key: string) => {
			const result = canonicalizeAddress({
				protocol: 'mqtt', topic: 'factory/sim-002/telemetry',
				selector: { kind: 'path', tokens: [{ kind: 'key', key }] }, selectorSource: 'configured',
			});
			if (result.status !== 'resolved') throw new Error('test address is invalid');
			return { endpointUuid: 'source-uuid', protocol: 'mqtt' as const, version: CANONICAL_ADDRESS_VERSION, key: result.addressKey };
		};
		const insertIdentity = db.prepare(`INSERT INTO point_identity (point_uuid, endpoint_uuid, protocol)
			VALUES (?, 'source-uuid', 'mqtt')`);
		const insertAddress = db.prepare(`INSERT INTO point_identity_address
			(endpoint_uuid, protocol, address_version, address_key, point_uuid) VALUES ('source-uuid', 'mqtt', 1, ?, ?)`);
		db.exec('BEGIN');
		for (let i = 0; i < 1000; i++) {
			const uuid = `field-${i}`;
			insertIdentity.run(uuid);
			insertAddress.run(makeAddress(String(i)).key, uuid);
		}
		db.exec('COMMIT');
		expect(await catalog.createIdentityIfAbsent(makeAddress('0'), {})).toMatchObject({
			status: 'resolved', value: { pointUuid: 'field-0' },
		});
		expect(await catalog.createIdentityIfAbsent(makeAddress('new'), {})).toMatchObject({
			status: 'unresolved', reason: 'field-capacity-exceeded',
		});
		expect(db.prepare('SELECT count(*) AS count FROM point_identity').get()?.count).toBe(1000);
	});

	it('continues telemetry if the identity database is unavailable', async () => {
		source({ baseTopic: 'factory/sim-002' });
		runtime();
		jest.spyOn(sqlite, 'getDatabase').mockImplementation(() => { throw new Error('database unavailable'); });
		const points = await send('factory/sim-002/telemetry', '{"temperature":23}');
		expect(points).toHaveLength(1);
		expect(points[0].value).toBe(23);
		expect(points[0].pointUuid).toBeUndefined();
		expect(agentLogger.warnSync).toHaveBeenCalledWith(expect.stringContaining('database unavailable'), expect.anything());
	});

	it('retries transient identity resolution without interrupting readings', async () => {
		const topic = 'factory/sim-002/telemetry';
		source({ baseTopic: 'factory/sim-002', pointIdentityFields: [field(topic, 'temperature')] });
		runtime();
		jest.spyOn(EndpointModel, 'getByUuid').mockRejectedValueOnce(new Error('temporary failure'));
		const first = await send(topic, '{"temperature":23}');
		expect(first[0].value).toBe(23);
		expect(first[0].pointUuid).toBeUndefined();
		const future = Date.now() + 6000;
		jest.spyOn(Date, 'now').mockReturnValue(future);
		await send(topic, '{"temperature":23}');
		expect((await send(topic, '{"temperature":23}'))[0].pointUuid).toBeTruthy();
	});
});
