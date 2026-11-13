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
});
