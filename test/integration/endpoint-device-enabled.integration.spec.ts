import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';

describe('Endpoint device enabled state (integration)', () => {
	let dbPath: string;
	let EndpointModel: typeof import('../../src/db/models/endpoint.model').EndpointModel;
	let ProtocolDevicesModel: typeof import('../../src/db/models/device.model').DeviceModel;
	let closeDatabase: () => void;

	beforeAll(() => {
		dbPath = path.join(os.tmpdir(), `endpoint-device-enabled-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
		process.env.DATABASE_PATH = dbPath;

		const sqlite = require('../../src/db/sqlite');
		const { runMigrations } = require('../../src/db/migration-runner');
		const db: DatabaseSync = sqlite.getDatabase();
		runMigrations(db);
		closeDatabase = sqlite.closeDatabase;

		EndpointModel = require('../../src/db/models/endpoint.model').EndpointModel;
		ProtocolDevicesModel = require('../../src/db/models/device.model').DeviceModel;
	});

	afterAll(() => {
		closeDatabase();
		for (const suffix of ['', '-wal', '-shm']) {
			fs.rmSync(`${dbPath}${suffix}`, { force: true });
		}
	});

	it('propagates source state transitions to its devices without resetting devices on no-op updates', async () => {
		const endpoint = await EndpointModel.create({
			uuid: '7c0e0a77-594c-49cc-a4d2-8d0b32e080e7',
			fingerprint: 'unit-test-fingerprint',
			name: 'disabled-opcua-source',
			protocol: 'opcua',
			enabled: false,
			poll_interval: 5000,
			connection: { endpointUrl: 'opc.tcp://localhost:4840' },
			data_points: [
				{ device_uuid: 'unit-device-a' },
				{ device_uuid: 'unit-device-b' },
			],
		});
		await ProtocolDevicesModel.syncFromEndpoint(endpoint);

		let devices = await ProtocolDevicesModel.getByEndpointId(endpoint.id!);
		expect(devices).toHaveLength(2);
		expect(devices.every((device) => !device.enabled)).toBe(true);

		await EndpointModel.update(endpoint.name, { enabled: true });
		devices = await ProtocolDevicesModel.getByEndpointId(endpoint.id!);
		expect(devices.every((device) => device.enabled)).toBe(true);

		const manuallyDisabledUuid = devices[0].uuid;
		await ProtocolDevicesModel.setEnabled(manuallyDisabledUuid, false);
		await EndpointModel.update(endpoint.name, { enabled: true });
		devices = await ProtocolDevicesModel.getByEndpointId(endpoint.id!);
		expect(devices.find((device) => device.uuid === manuallyDisabledUuid)?.enabled).toBe(false);

		await EndpointModel.updateByUuid(endpoint.uuid!, { enabled: false });
		devices = await ProtocolDevicesModel.getByEndpointId(endpoint.id!);
		expect(devices.every((device) => !device.enabled)).toBe(true);

		await EndpointModel.updateByFingerprint('unit-test-fingerprint', { enabled: true });
		devices = await ProtocolDevicesModel.getByEndpointId(endpoint.id!);
		expect(devices.every((device) => device.enabled)).toBe(true);
	});

	it('renames a source by UUID and rejects conflicts without changing target configuration', async () => {
		const actions: typeof import('../../src/api/actions') = require('../../src/api/actions');
		const endpoint = await EndpointModel.create({
			uuid: '7c0e0a77-594c-49cc-a4d2-8d0b32e080e8',
			name: 'original-source',
			protocol: 'opcua',
			enabled: true,
			poll_interval: 5000,
			connection: { endpointUrl: 'opc.tcp://localhost:4841' },
			data_points: [{ device_uuid: 'rename-device', device_name: 'device', name: 'temperature' }],
		});
		const other = await EndpointModel.create({
			uuid: '7c0e0a77-594c-49cc-a4d2-8d0b32e080e9',
			name: 'other-source',
			protocol: 'opcua',
			enabled: true,
			poll_interval: 5000,
			connection: { endpointUrl: 'opc.tcp://localhost:4842' },
		});
		await ProtocolDevicesModel.syncFromEndpoint(endpoint);
		const beforeDevices = await ProtocolDevicesModel.getByEndpointId(endpoint.id!);
		let target: { apps: Record<string, unknown>; config: Record<string, unknown> } = { apps: {}, config: { endpoints: [] } };
		const manager = {
			getTargetState: () => target,
			setTarget: jest.fn(async (state: typeof target) => { target = state; }),
		};
		actions.setStateManager(manager as unknown as Parameters<typeof actions.setStateManager>[0]);
		try {
			const body = {
				name: 'renamed-source', protocol: 'opcua', enabled: true,
				connection: endpoint.connection, data_points: endpoint.data_points,
			};
			await actions.replaceEndpoint(endpoint.uuid!, body);
			const saved = await EndpointModel.getByUuid(endpoint.uuid!);
			expect(saved).toMatchObject({ id: endpoint.id, uuid: endpoint.uuid, name: 'renamed-source', data_points: endpoint.data_points });
			expect(await ProtocolDevicesModel.getByEndpointId(endpoint.id!)).toHaveLength(beforeDevices.length);
			expect((target.config.endpoints as Array<{ uuid: string; name: string }>).find(e => e.uuid === endpoint.uuid)?.name).toBe('renamed-source');
			expect((target.config.endpoints as Array<{ uuid: string; name: string }>).find(e => e.uuid === other.uuid)?.name).toBe(other.name);

			const writes = manager.setTarget.mock.calls.length;
			await expect(actions.replaceEndpoint(endpoint.uuid!, { ...body, name: other.name }))
				.rejects.toMatchObject({ statusCode: 409 });
			await expect(actions.replaceEndpoint(endpoint.uuid!, { ...body, connection: other.connection }))
				.rejects.toMatchObject({ statusCode: 409 });
			expect(manager.setTarget).toHaveBeenCalledTimes(writes);
			expect((await EndpointModel.getByUuid(endpoint.uuid!))?.name).toBe('renamed-source');
			expect((await EndpointModel.getByUuid(other.uuid!))?.name).toBe(other.name);
		} finally {
			actions.setStateManager(undefined);
		}
	});
});
