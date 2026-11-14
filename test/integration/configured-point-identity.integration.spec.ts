import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../../src/db/migration-runner';
import {
	resolveEndpoints, createIdentities,
	type EndpointInput,
} from '../../src/points/configured-point-resolver';
import type { OpcuaAddressInput } from '../../src/points/canonical-address';

function setupDb(): DatabaseSync {
	const db = new DatabaseSync(':memory:');
	db.exec('PRAGMA journal_mode = WAL');
	runMigrations(db);
	return db;
}

function insertEndpoint(db: DatabaseSync, id: number, uuid: string, name: string, protocol: string, connection = '{}', dataPoints = '[]') {
	db.exec(`
		INSERT INTO endpoints (id, uuid, name, protocol, enabled, connection, data_points, poll_interval)
			VALUES (${id}, '${uuid}', '${name}', '${protocol}', 1, '${connection}', '${dataPoints}', 5000);
	`);
}

const namespaces: OpcuaAddressInput['namespaceArray'] = {
	verified: true, uris: ['http://opcfoundation.org/UA/', 'urn:test-server'],
};

function mqttEndpoint(): EndpointInput {
	return {
		uuid: 'ep-mqtt', name: 'mqtt-source', protocol: 'mqtt',
		connection: { baseTopic: 'factory/line1' },
		data_points: [
			{ name: 'temperature', subTopic: 'temp', fullTopic: 'factory/line1/temp' },
			{ name: 'humidity', subTopic: 'hum', fullTopic: 'factory/line1/hum' },
		],
	};
}

function modbusEndpoint(): EndpointInput {
	return {
		uuid: 'ep-modbus', name: 'modbus-source', protocol: 'modbus',
		connection: { slaveId: 1, host: '10.0.0.1', port: 502, type: 'tcp' },
		data_points: [
			{ name: 'voltage', address: 100, type: 'holding', dataType: 'float32', count: 2 },
			{ name: 'current', address: 102, type: 'holding', dataType: 'float32', count: 2 },
		],
	};
}

function bacnetEndpoint(): EndpointInput {
	return {
		uuid: 'ep-bacnet', name: 'bacnet-source', protocol: 'bacnet',
		connection: { ipAddress: '10.0.0.1', deviceInstance: 42 },
		data_points: [
			{ name: 'space_temp', objectType: 'analog-input', objectInstance: 1, propertyId: 85 },
			{ name: 'setpoint', objectType: 'analog-value', objectInstance: 2 },
		],
	};
}

function opcuaEndpoint(): EndpointInput {
	return {
		uuid: 'ep-opcua', name: 'opcua-source', protocol: 'opcua',
		connection: { endpointUrl: 'opc.tcp://localhost:4840' },
		data_points: [
			{ name: 'temperature', nodeId: 'ns=1;s=Temperature' },
			{ name: 'pressure', nodeId: 'ns=1;s=Pressure' },
		],
	};
}

describe('configured-point identity creation (integration)', () => {
	let db: DatabaseSync;

	beforeEach(() => {
		db = setupDb();
		insertEndpoint(db, 1, 'ep-mqtt', 'mqtt-source', 'mqtt');
		insertEndpoint(db, 2, 'ep-modbus', 'modbus-source', 'modbus');
		insertEndpoint(db, 3, 'ep-bacnet', 'bacnet-source', 'bacnet');
		insertEndpoint(db, 4, 'ep-opcua', 'opcua-source', 'opcua');
	});

	afterEach(() => { db.close(); });

	it('creates UUIDs for all resolved points across protocols', async () => {
		const endpoints = [mqttEndpoint(), modbusEndpoint(), bacnetEndpoint()];
		const resolved = resolveEndpoints(endpoints);
		const result = await createIdentities(db, resolved);

		expect(result.summary.created).toBe(6);
		expect(result.summary.failed).toBe(0);
		expect(result.lookup.size).toBe(6);

		const rows = db.prepare('SELECT * FROM point_identity ORDER BY rowid').all() as any[];
		expect(rows).toHaveLength(6);
		expect(rows[0].endpoint_uuid).toBe('ep-mqtt');
		expect(rows[0].protocol).toBe('mqtt');
	});

	it('is idempotent — same points get same UUIDs on restart', async () => {
		const endpoints = [mqttEndpoint()];
		const resolved = resolveEndpoints(endpoints);

		const first = await createIdentities(db, resolved);
		const second = await createIdentities(db, resolved);

		expect(first.summary.created).toBe(2);
		expect(second.summary.created).toBe(2);

		const firstUuids = [...first.lookup.values()].sort();
		const secondUuids = [...second.lookup.values()].sort();
		expect(secondUuids).toEqual(firstUuids);

		const rows = db.prepare('SELECT * FROM point_identity').all();
		expect(rows).toHaveLength(2);
	});

	it('preserves UUID when point is renamed (same address)', async () => {
		const original = resolveEndpoints([mqttEndpoint()]);
		const firstResult = await createIdentities(db, original);

		const renamed = resolveEndpoints([{
			...mqttEndpoint(),
			data_points: [
				{ name: 'renamed_temp', subTopic: 'temp', fullTopic: 'factory/line1/temp' },
				{ name: 'renamed_hum', subTopic: 'hum', fullTopic: 'factory/line1/hum' },
			],
		}]);
		const secondResult = await createIdentities(db, renamed);

		expect([...secondResult.lookup.values()].sort()).toEqual([...firstResult.lookup.values()].sort());
	});

	it('creates new UUIDs when endpoint UUID changes', async () => {
		const first = resolveEndpoints([mqttEndpoint()]);
		const firstResult = await createIdentities(db, first);

		insertEndpoint(db, 10, 'ep-mqtt-2', 'mqtt-source-2', 'mqtt');
		const second = resolveEndpoints([{ ...mqttEndpoint(), uuid: 'ep-mqtt-2' }]);
		const secondResult = await createIdentities(db, second);

		const firstUuids = [...firstResult.lookup.values()].sort();
		const secondUuids = [...secondResult.lookup.values()].sort();
		expect(secondUuids).not.toEqual(firstUuids);
	});

	it('scopes identities by endpoint — same topic on two endpoints gets separate UUIDs', async () => {
		insertEndpoint(db, 5, 'ep-mqtt-2', 'mqtt-source-2', 'mqtt');
		const endpoints = [
			mqttEndpoint(),
			{ ...mqttEndpoint(), uuid: 'ep-mqtt-2', name: 'mqtt-source-2' },
		];
		const resolved = resolveEndpoints(endpoints);
		const result = await createIdentities(db, resolved);

		expect(result.summary.created).toBe(4);
		const ep1Keys = [...result.lookup.keys()].filter((k) => k.startsWith('ep-mqtt:'));
		const ep2Keys = [...result.lookup.keys()].filter((k) => k.startsWith('ep-mqtt-2:'));
		expect(ep1Keys).toHaveLength(2);
		expect(ep2Keys).toHaveLength(2);
		expect(result.lookup.get(ep1Keys[0])).not.toBe(result.lookup.get(ep2Keys[0]));
	});

	it('rejects ambiguous points — two points with same address in one endpoint', async () => {
		const endpoints: EndpointInput[] = [{
			uuid: 'ep-bacnet', name: 'bacnet-source', protocol: 'bacnet',
			connection: { ipAddress: '10.0.0.1', deviceInstance: 42 },
			data_points: [
				{ name: 'point_a', objectType: 'analog-input', objectInstance: 1 },
				{ name: 'point_b', objectType: 'analog-input', objectInstance: 1 },
			],
		}];
		const resolved = resolveEndpoints(endpoints);
		const result = await createIdentities(db, resolved);

		expect(result.summary.failed).toBe(2);
		expect(result.summary.created).toBe(0);
		expect(db.prepare('SELECT * FROM point_identity').all()).toHaveLength(0);
	});

	it('defers OPC UA points when no namespace array is provided', async () => {
		const resolved = resolveEndpoints([opcuaEndpoint()]);
		expect(resolved.summary.deferred).toBe(2);
		expect(resolved.summary.resolved).toBe(0);

		const result = await createIdentities(db, resolved);
		expect(result.summary.created).toBe(0);
		expect(result.summary.failed).toBe(0);
	});

	it('creates OPC UA identities when namespace array is provided', async () => {
		const nsMap = new Map<string, OpcuaAddressInput['namespaceArray']>();
		nsMap.set('ep-opcua', namespaces);
		const resolved = resolveEndpoints([opcuaEndpoint()], nsMap);
		expect(resolved.summary.resolved).toBe(2);

		const result = await createIdentities(db, resolved, nsMap);
		expect(result.summary.created).toBe(2);
		expect(result.summary.failed).toBe(0);
	});

	it('OPC UA identities persist across reconnects', async () => {
		const nsMap = new Map<string, OpcuaAddressInput['namespaceArray']>();
		nsMap.set('ep-opcua', namespaces);

		const first = resolveEndpoints([opcuaEndpoint()], nsMap);
		const firstResult = await createIdentities(db, first, nsMap);

		const second = resolveEndpoints([opcuaEndpoint()], nsMap);
		const secondResult = await createIdentities(db, second, nsMap);

		expect([...secondResult.lookup.values()].sort()).toEqual([...firstResult.lookup.values()].sort());
	});

	it('fails when endpoint does not exist in DB', async () => {
		const endpoints: EndpointInput[] = [{
			uuid: 'nonexistent', name: 'ghost', protocol: 'mqtt',
			connection: {},
			data_points: [{ name: 'point', fullTopic: 'test/topic' }],
		}];
		const resolved = resolveEndpoints(endpoints);
		const result = await createIdentities(db, resolved);

		expect(result.summary.failed).toBe(1);
		expect(result.summary.created).toBe(0);
	});

	it('Modbus overlapping registers are rejected by the verifier', async () => {
		const endpoints: EndpointInput[] = [{
			uuid: 'ep-modbus', name: 'modbus-source', protocol: 'modbus',
			connection: { slaveId: 1 },
			data_points: [
				{ name: 'reg_a', address: 100, type: 'holding', dataType: 'float32', count: 2 },
				{ name: 'reg_b', address: 101, type: 'holding', dataType: 'float32', count: 2 },
			],
		}];
		const resolved = resolveEndpoints(endpoints);
		// Overlapping registers are unresolved at the resolver level, not the verifier level
		expect(resolved.summary.unresolved).toBe(2);

		const result = await createIdentities(db, resolved);
		expect(result.summary.created).toBe(0);
	});
});
