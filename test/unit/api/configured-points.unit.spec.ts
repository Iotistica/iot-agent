import express from 'express';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../../../src/db/migration-runner';
import { canonicalizeAddress, type OpcuaAddressInput } from '../../../src/points/canonical-address';
import * as sqlite from '../../../src/db/sqlite';
import { AdminSessionModel } from '../../../src/db/models/admin-session.model';
import { EndpointModel, type Endpoint } from '../../../src/db/models/endpoint.model';
import { UserModel, type User } from '../../../src/db/models/admin-user.model';
import {
	getConfiguredPointRows, configuredPointsRouter, type ConfiguredEndpoint,
} from '../../../src/api/configured-points';

const namespaces: OpcuaAddressInput['namespaceArray'] = {
	verified: true,
	uris: ['http://opcfoundation.org/UA/', 'urn:configured-point-test'],
};

function mqttEndpoint(dataPoints: any[], uuid = 'source-mqtt', id = 1): Endpoint {
	return {
		id,
		uuid,
		name: 'MQTT Source',
		protocol: 'mqtt',
		enabled: true,
		poll_interval: 1000,
		connection: {},
		data_points: dataPoints,
	};
}

function insertEndpoint(db: DatabaseSync, endpoint: ConfiguredEndpoint): void {
	db.prepare(`
		INSERT INTO endpoints (id, uuid, name, protocol, enabled, poll_interval, connection, data_points)
		VALUES (?, ?, ?, ?, 1, ?, ?, ?)
	`).run(endpoint.id, endpoint.uuid, endpoint.name, endpoint.protocol, endpoint.poll_interval,
		JSON.stringify(endpoint.connection), JSON.stringify(endpoint.data_points));
}

function storeIdentity(
	db: DatabaseSync, endpointUuid: string, protocol: string, addressKey: string, pointUuid: string,
	deviceUuid: string | null = null,
): void {
	db.prepare('INSERT INTO point_identity (point_uuid, endpoint_uuid, protocol, device_uuid) VALUES (?, ?, ?, ?)')
		.run(pointUuid, endpointUuid, protocol, deviceUuid);
	db.prepare(`
		INSERT INTO point_identity_address (endpoint_uuid, protocol, address_version, address_key, point_uuid)
		VALUES (?, ?, 1, ?, ?)
	`).run(endpointUuid, protocol, addressKey, pointUuid);
}

describe('configured points read API', () => {
	let db: DatabaseSync;

	beforeEach(() => {
		db = new DatabaseSync(':memory:');
		runMigrations(db);
	});
	afterEach(() => {
		jest.restoreAllMocks();
		db.close();
	});

	async function requestPoints(path: string, authenticated = false): Promise<Response> {
		const app = express();
		app.use(configuredPointsRouter);
		const server = app.listen(0);
		await once(server, 'listening');
		try {
			const address = server.address();
			if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
			return await fetch(`http://127.0.0.1:${address.port}${path}`, {
				headers: authenticated ? { Cookie: 'admin_session=valid-session' } : {},
			});
		} finally {
			server.close();
			await once(server, 'close');
		}
	}

	function authorizeRouteRequest(): void {
		const user: User = {
			id: 1,
			username: 'viewer',
			is_superuser: false,
			role: 'viewer',
			is_active: true,
			must_change_password: false,
			created_at: '',
			updated_at: '',
		};
		jest.spyOn(AdminSessionModel, 'find').mockReturnValue({ username: user.username });
		jest.spyOn(UserModel, 'getByUsername').mockReturnValue(user);
	}

	it('returns canonical-address identity matches without writing to the catalog', () => {
		const endpoint = mqttEndpoint([{ name: 'temperature', fullTopic: 'factory/temperature' }]);
		insertEndpoint(db, endpoint);
		const canonical = canonicalizeAddress({
			protocol: 'mqtt', topic: 'factory/temperature',
			selector: { kind: 'whole' }, selectorSource: 'configured',
		});
		if (canonical.status !== 'resolved') throw new Error('Expected canonical MQTT address');
		storeIdentity(db, endpoint.uuid!, 'mqtt', canonical.addressKey, 'point-temperature');

		const before = db.prepare('SELECT * FROM point_identity').all();
		const rows = getConfiguredPointRows(endpoint, db);

		expect(rows).toEqual([{
			name: 'temperature',
			protocolAddress: 'factory/temperature',
			canonicalStatus: 'resolved',
			canonicalReason: null,
			identityStatus: 'resolved',
			identityReason: null,
			pointUuid: 'point-temperature',
		}]);
		expect(db.prepare('SELECT * FROM point_identity').all()).toEqual(before);
	});

	it('does not infer identities from point names or aliases', () => {
		const endpoint = mqttEndpoint([{ name: 'temperature' }]);
		insertEndpoint(db, endpoint);
		db.prepare('INSERT INTO point_identity (point_uuid, endpoint_uuid, protocol) VALUES (?, ?, ?)')
			.run('legacy-point', endpoint.uuid, 'mqtt');
		db.prepare(`
			INSERT INTO point_identity_alias (endpoint_uuid, alias_kind, alias_key, point_uuid, evidence)
			VALUES (?, 'name', 'temperature', 'legacy-point', 'legacy evidence')
		`).run(endpoint.uuid);

		const rows = getConfiguredPointRows(endpoint, db);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			name: 'temperature',
			canonicalStatus: 'unresolved',
			canonicalReason: 'invalid-input',
			identityStatus: 'unresolved',
			identityReason: 'invalid-input',
		});
		expect(rows[0].pointUuid).toBeUndefined();
		expect(db.prepare('SELECT count(*) AS count FROM point_identity').get()).toMatchObject({ count: 1 });
	});

	it('does not create or assign an identity found only in another endpoint scope', () => {
		const endpoint = mqttEndpoint([{ name: 'temperature', fullTopic: 'factory/temperature' }]);
		const otherEndpoint = { ...mqttEndpoint([], 'source-other', 2), name: 'Other MQTT Source' };
		insertEndpoint(db, endpoint);
		insertEndpoint(db, otherEndpoint);
		const canonical = canonicalizeAddress({
			protocol: 'mqtt', topic: 'factory/temperature',
			selector: { kind: 'whole' }, selectorSource: 'configured',
		});
		if (canonical.status !== 'resolved') throw new Error('Expected canonical MQTT address');
		storeIdentity(db, otherEndpoint.uuid!, 'mqtt', canonical.addressKey, 'other-point');

		const rows = getConfiguredPointRows(endpoint, db);

		expect(rows[0]).toMatchObject({
			canonicalStatus: 'resolved',
			identityStatus: 'unresolved',
			identityReason: 'not-found',
		});
		expect(rows[0].pointUuid).toBeUndefined();
		expect(db.prepare('SELECT count(*) AS count FROM point_identity').get()).toMatchObject({ count: 1 });
	});

	it('exposes an associated device only when its UUID matches a device row in the same endpoint', () => {
		const endpoint = mqttEndpoint([
			{ name: 'temperature', fullTopic: 'factory/temperature' },
			{ name: 'humidity', fullTopic: 'factory/humidity' },
		]);
		insertEndpoint(db, endpoint);
		const temperature = canonicalizeAddress({
			protocol: 'mqtt', topic: 'factory/temperature',
			selector: { kind: 'whole' }, selectorSource: 'configured',
		});
		const humidity = canonicalizeAddress({
			protocol: 'mqtt', topic: 'factory/humidity',
			selector: { kind: 'whole' }, selectorSource: 'configured',
		});
		if (temperature.status !== 'resolved' || humidity.status !== 'resolved') {
			throw new Error('Expected canonical MQTT addresses');
		}
		storeIdentity(db, endpoint.uuid!, 'mqtt', temperature.addressKey, 'point-temperature', 'device-temperature');
		storeIdentity(db, endpoint.uuid!, 'mqtt', humidity.addressKey, 'point-humidity');
		db.prepare(`
			INSERT INTO devices (uuid, endpoint_id, name, protocol, enabled)
			VALUES (?, ?, ?, 'mqtt', 1), (?, ?, ?, 'mqtt', 1)
		`).run('device-temperature', endpoint.id, 'Temperature Device', 'device-humidity', endpoint.id, 'Humidity Device');

		const rows = getConfiguredPointRows(endpoint, db);

		expect(rows[0]).toMatchObject({
			pointUuid: 'point-temperature',
			deviceUuid: 'device-temperature',
			deviceName: 'Temperature Device',
		});
		expect(rows[1]).toMatchObject({ pointUuid: 'point-humidity' });
		expect(rows[1].deviceUuid).toBeUndefined();
		expect(rows[1].deviceName).toBeUndefined();
	});

	it('leaves duplicate configured addresses unresolved even when a catalog identity exists', () => {
		const endpoint = mqttEndpoint([
			{ name: 'temperature-a', fullTopic: 'factory/temperature' },
			{ name: 'temperature-b', fullTopic: 'factory/temperature' },
		]);
		insertEndpoint(db, endpoint);
		const canonical = canonicalizeAddress({
			protocol: 'mqtt', topic: 'factory/temperature',
			selector: { kind: 'whole' }, selectorSource: 'configured',
		});
		if (canonical.status !== 'resolved') throw new Error('Expected canonical MQTT address');
		storeIdentity(db, endpoint.uuid!, 'mqtt', canonical.addressKey, 'point-temperature');

		const rows = getConfiguredPointRows(endpoint, db);

		expect(rows).toHaveLength(2);
		expect(rows.map(row => row.identityReason)).toEqual(['identity-ambiguous', 'identity-ambiguous']);
		expect(rows.every(row => row.identityStatus === 'unresolved' && row.pointUuid === undefined)).toBe(true);
	});

	it('defers OPC UA identity lookup when namespace evidence is unavailable', () => {
		const endpoint: ConfiguredEndpoint = {
			...mqttEndpoint([{ name: 'temperature', nodeId: 'ns=1;s=Temperature' }], 'source-opcua'),
			protocol: 'opcua',
		};
		insertEndpoint(db, endpoint);
		const canonical = canonicalizeAddress({
			protocol: 'opcua', nodeId: 'ns=1;s=Temperature',
			namespaceArray: namespaces, nodeIdVerifiedAgainstNamespaceArray: true,
		});
		if (canonical.status !== 'resolved') throw new Error('Expected canonical OPC UA fixture address');
		storeIdentity(db, endpoint.uuid!, 'opcua', canonical.addressKey, 'point-temperature');

		const rows = getConfiguredPointRows(endpoint, db);

		expect(rows[0]).toMatchObject({
			canonicalStatus: 'deferred',
			canonicalReason: 'namespace-evidence-required',
			identityStatus: 'deferred',
			identityReason: 'namespace-evidence-required',
		});
		expect(rows[0].pointUuid).toBeUndefined();
	});

	it('returns points over HTTP for an authenticated request', async () => {
		const endpoint = mqttEndpoint([{ name: 'temperature', fullTopic: 'factory/temperature' }]);
		insertEndpoint(db, endpoint);
		const canonical = canonicalizeAddress({
			protocol: 'mqtt', topic: 'factory/temperature',
			selector: { kind: 'whole' }, selectorSource: 'configured',
		});
		if (canonical.status !== 'resolved') throw new Error('Expected canonical MQTT address');
		storeIdentity(db, endpoint.uuid!, 'mqtt', canonical.addressKey, 'point-temperature');
		jest.spyOn(sqlite, 'getDatabase').mockReturnValue(db);
		jest.spyOn(EndpointModel, 'getAll').mockRejectedValue(new Error('Do not load all endpoints'));
		const getByUuid = jest.spyOn(EndpointModel, 'getByUuid');
		authorizeRouteRequest();

		const response = await requestPoints('/v1/endpoints/source-mqtt/points', true);

		expect(response.status).toBe(200);
		expect(EndpointModel.getAll).not.toHaveBeenCalled();
		expect(getByUuid).toHaveBeenCalledWith('source-mqtt');
		expect(await response.json()).toMatchObject({
			endpointUuid: 'source-mqtt',
			points: [{
				name: 'temperature',
				canonicalStatus: 'resolved',
				identityStatus: 'resolved',
				pointUuid: 'point-temperature',
			}],
		});
	});

	it('returns 404 over HTTP for an authenticated request to an unknown endpoint', async () => {
		jest.spyOn(sqlite, 'getDatabase').mockReturnValue(db);
		jest.spyOn(EndpointModel, 'getAll').mockRejectedValue(new Error('Do not load all endpoints'));
		authorizeRouteRequest();

		const response = await requestPoints('/v1/endpoints/missing/points', true);

		expect(response.status).toBe(404);
		expect(EndpointModel.getAll).not.toHaveBeenCalled();
		expect(await response.json()).toEqual({ error: 'Endpoint not found' });
	});

	it('returns 409 over HTTP when an endpoint UUID is duplicated', async () => {
		db.exec('DROP INDEX IF EXISTS endpoints_uuid_unique');
		const first = mqttEndpoint([]);
		const second = { ...mqttEndpoint([], 'source-mqtt', 2), name: 'Duplicate MQTT Source' };
		insertEndpoint(db, first);
		insertEndpoint(db, second);
		jest.spyOn(sqlite, 'getDatabase').mockReturnValue(db);
		const getByUuid = jest.spyOn(EndpointModel, 'getByUuid');
		authorizeRouteRequest();

		const response = await requestPoints('/v1/endpoints/source-mqtt/points', true);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: 'Endpoint UUID is ambiguous' });
		expect(getByUuid).not.toHaveBeenCalled();
	});

	it('requires authentication before reading configured endpoints', async () => {
		const response = await requestPoints('/v1/endpoints/source-mqtt/points');
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'Not authenticated' });
	});
});
