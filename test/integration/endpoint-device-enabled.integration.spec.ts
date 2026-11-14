import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';

jest.mock('node-opcua-client', () => require('../../__mocks__/node-opcua-client'));

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

	it('validates and persists OPC UA identification before creating a source', async () => {
		const actions: typeof import('../../src/api/actions') = require('../../src/api/actions');
		let target: { apps: Record<string, unknown>; config: Record<string, unknown> } = { apps: {}, config: { endpoints: [] } };
		const manager = {
			getTargetState: () => target,
			setTarget: jest.fn(async (state: typeof target) => { target = state; }),
		};
		const browseOPCUAAddressSpace = jest.fn().mockResolvedValue([]);
		actions.setStateManager(manager as unknown as Parameters<typeof actions.setStateManager>[0]);
		actions.setDiscoveryService({ browseOPCUAAddressSpace } as unknown as Parameters<typeof actions.setDiscoveryService>[0]);
		const deviceIdentification = {
			rootNodeId: 'ns=2;i=1', scopeNodeId: 'ns=0;i=85', deviceTypeNodeId: 'ns=0;i=61',
			identifierProperty: 'AssetId', identifierPath: 'Identification/AssetId',
		};
		try {
			const body = {
				name: 'identified-source', protocol: 'opcua',
				connection: { endpointUrl: 'opc.tcp://localhost:4850', deviceIdentification },
			};
			const saved = await actions.addEndpoint(body);
			expect(browseOPCUAAddressSpace).toHaveBeenCalledWith(expect.objectContaining({ identifierValidation: deviceIdentification }));
			expect((await EndpointModel.getByUuid(saved.uuid))?.connection.deviceIdentification).toEqual(deviceIdentification);
			const targetSource = (target.config.endpoints as Array<{ uuid: string; connection: Record<string, unknown> }>).find(item => item.uuid === saved.uuid);
			expect(targetSource?.connection.deviceIdentification).toEqual(deviceIdentification);

			browseOPCUAAddressSpace.mockRejectedValueOnce(new Error('Duplicate device identifier'));
			const writes = manager.setTarget.mock.calls.length;
			await expect(actions.addEndpoint({ ...body, name: 'invalid-source' }))
				.rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('Duplicate device identifier') });
			expect(manager.setTarget).toHaveBeenCalledTimes(writes);
			expect(await EndpointModel.getByName('invalid-source')).toBeNull();
		} finally {
			actions.setStateManager(undefined);
			actions.setDiscoveryService(undefined);
		}
	});

	it('previews OPC UA device candidates without creating devices and reconciles existing source evidence', async () => {
		const actions: typeof import('../../src/api/actions') = require('../../src/api/actions');
		const { DeviceResolutionStore } = require('../../src/discovery/device-resolution-store');
		const sqlite = require('../../src/db/sqlite');
		const endpoint = await EndpointModel.create({
			uuid: '7c0e0a77-594c-49cc-a4d2-8d0b32e080e6',
			name: 'preview-source', protocol: 'opcua', enabled: false, poll_interval: 5000,
			connection: { endpointUrl: 'opc.tcp://localhost:4851' },
		});
		const snapshot = {
			objects: [
				{ address: 'root', parentAddress: null, name: 'Site', browsePath: ['Site'] },
				{ address: 'pump', parentAddress: 'root', name: 'Pump', browsePath: ['Site', 'Pump'], identifiers: { AssetId: 'A1' } },
			],
			points: [{ address: 'temp', parentAddress: 'pump', name: 'Temperature' }],
		};
		const snapshotOPCUAAddressSpace = jest.fn().mockResolvedValue(snapshot);
		actions.setDiscoveryService({ snapshotOPCUAAddressSpace } as unknown as Parameters<typeof actions.setDiscoveryService>[0]);
		try {
			const connection = { endpointUrl: 'opc.tcp://localhost:4851' };
			const strategy = { type: 'identifier' as const, identifierPath: 'AssetId' };
			await expect(actions.previewOPCUADevices({ endpointUrl: 'opc.tcp://localhost:4852' }, strategy, endpoint.uuid))
				.rejects.toMatchObject({ statusCode: 409 });
			expect(snapshotOPCUAAddressSpace).not.toHaveBeenCalled();
			const preview = await actions.previewOPCUADevices(connection, strategy, endpoint.uuid);
			expect(preview.candidates[0].status).toBe('new');
			expect(preview.unassignedPointAddresses).toEqual(['temp']);
			expect(await ProtocolDevicesModel.getByEndpointId(endpoint.id!)).toHaveLength(0);
			new DeviceResolutionStore(sqlite.getDatabase()).confirm(endpoint.uuid, [preview.candidates[0].candidate], [preview.candidates[0].candidate.candidateId]);
			const after = await actions.previewOPCUADevices(connection, strategy, endpoint.uuid);
			expect(after.candidates[0].status).toBe('matched');
			expect(after.unassignedPointAddresses).toEqual([]);
			expect(snapshotOPCUAAddressSpace).toHaveBeenCalledWith(connection, 'AssetId');
		} finally {
			actions.setDiscoveryService(undefined);
		}
	});

	it('preserves device records and confirmed evidence when OPC UA points disappear from a scan', async () => {
		const { DeviceResolutionStore } = require('../../src/discovery/device-resolution-store');
		const db: DatabaseSync = require('../../src/db/sqlite').getDatabase();
		const endpoint = await EndpointModel.create({
			uuid: '7c0e0a77-594c-49cc-a4d2-8d0b32e080e5',
			name: 'preserve-devices', protocol: 'opcua', enabled: true, poll_interval: 5000,
			connection: { endpointUrl: 'opc.tcp://localhost:4853' },
			data_points: [{ nodeId: 'ns=2;s=A', device_uuid: 'preserve-device-a' }, { nodeId: 'ns=2;s=B', device_uuid: 'preserve-device-b' }],
		});
		await ProtocolDevicesModel.syncFromEndpoint(endpoint);
		const candidate = {
			candidateId: 'confirmed', name: 'Confirmed',
			keys: [{ kind: 'external-identifier', value: 'confirmed-id' }],
			pointAddresses: ['ns=2;s=confirmed'], reasons: [],
		};
		const [confirmed] = new DeviceResolutionStore(db).confirm(endpoint.uuid!, [candidate], ['confirmed']);
		db.prepare(`INSERT INTO point_name_mappings
			(source_system, endpoint_name, device_key, raw_name, provisional_point_id, normalized_name, method, rules_version)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
			.run('opcua', endpoint.name, 'preserve-device-a', 'Raw A', 'point-a', 'normalized_a', 'manual', '1');
		const before = await ProtocolDevicesModel.getByEndpointId(endpoint.id!);
		const disabled = before.find(device => device.identifier === 'preserve-device-a')!;
		await ProtocolDevicesModel.setEnabled(disabled.uuid, false);

		await ProtocolDevicesModel.syncFromEndpoint({
			...endpoint, data_points: [{ nodeId: 'ns=2;s=A', device_uuid: 'preserve-device-a' }],
		});
		expect((await ProtocolDevicesModel.getByEndpointId(endpoint.id!)).map(d => d.uuid).sort())
			.toEqual(before.map(d => d.uuid).sort());
		expect((await ProtocolDevicesModel.getByEndpointId(endpoint.id!)).find(d => d.uuid === disabled.uuid)?.enabled).toBe(false);
		expect(db.prepare('SELECT device_uuid FROM device_resolution_points WHERE endpoint_id = ? AND address = ?')
			.get(endpoint.id!, 'ns=2;s=confirmed')).toMatchObject({ device_uuid: confirmed.identity.deviceUuid });
		expect(db.prepare('SELECT device_uuid FROM device_resolution_keys WHERE endpoint_id = ? AND value = ?')
			.get(endpoint.id!, 'confirmed-id')).toMatchObject({ device_uuid: confirmed.identity.deviceUuid });
		expect(db.prepare('SELECT provisional_point_id, normalized_name FROM point_name_mappings WHERE endpoint_name = ? AND raw_name = ?')
			.get(endpoint.name, 'Raw A')).toMatchObject({ provisional_point_id: 'point-a', normalized_name: 'normalized_a' });
	});

	it('preserves configured points and device mappings across partial and empty discovery results', async () => {
		const { DiscoveryStore } = require('../../src/discovery/db');
		const endpoint = await EndpointModel.create({
			uuid: '7c0e0a77-594c-49cc-a4d2-8d0b32e080e4',
			name: 'preserve-points', protocol: 'opcua', enabled: true, poll_interval: 5000,
			connection: { endpointUrl: 'opc.tcp://localhost:4854' },
			data_points: [
				{ nodeId: 'ns=2;s=A', name: 'a', device_uuid: 'preserve-point-a', device_name: 'Pump A' },
				{ nodeId: 'ns=2;s=B', name: 'b', device_uuid: 'preserve-point-b' },
			],
		});
		await ProtocolDevicesModel.syncFromEndpoint(endpoint);
		const store = new DiscoveryStore();
		const result = {
			name: endpoint.name, protocol: 'opcua' as const, fingerprint: 'preserve-points-fingerprint',
			connection: endpoint.connection, confidence: 'medium' as const,
			discoveredAt: new Date().toISOString(), validated: false,
		};
		await store.save([{ ...result, dataPointsComplete: false, dataPoints: [
			{ nodeId: 'ns=2;s=A', name: 'a-updated' },
			{ nodeId: 'ns=2;s=C', name: 'c' },
		] }], 'partial');
		let saved = await EndpointModel.getByUuid(endpoint.uuid!);
		expect(saved?.data_points).toEqual([
			{ nodeId: 'ns=2;s=A', name: 'a', device_uuid: 'preserve-point-a', device_name: 'Pump A' },
			{ nodeId: 'ns=2;s=B', name: 'b', device_uuid: 'preserve-point-b' },
			{ nodeId: 'ns=2;s=C', name: 'c' },
		]);
		await store.save([{ ...result, dataPoints: [], metadata: { profile: 'changed' } }], 'empty');
		saved = await EndpointModel.getByUuid(endpoint.uuid!);
		expect(saved?.data_points).toHaveLength(3);
		expect(await ProtocolDevicesModel.getByEndpointId(endpoint.id!)).toHaveLength(2);
		await store.save([{ ...result, dataPointsComplete: true, dataPoints: [
			{ nodeId: 'ns=2;s=A', name: 'a-complete', device_uuid: null },
			{ nodeId: 'ns=2;s=B', name: 'b' },
			{ nodeId: 'ns=2;s=C', name: 'c' },
		], metadata: { profile: 'changed' } }], 'complete');
		saved = await EndpointModel.getByUuid(endpoint.uuid!);
		expect(saved?.data_points?.find(point => point.nodeId === 'ns=2;s=A'))
			.toMatchObject({ name: 'a', device_uuid: 'preserve-point-a' });
	});

	it('does not turn blank identifiers into devices and preserves the existing placeholder', async () => {
		const endpoint = await EndpointModel.create({
			uuid: '7c0e0a77-594c-49cc-a4d2-8d0b32e080e3',
			name: 'blank-identifiers', protocol: 'opcua', enabled: true, poll_interval: 5000,
			connection: { endpointUrl: 'opc.tcp://localhost:4855' },
			data_points: [],
		});
		await ProtocolDevicesModel.syncFromEndpoint(endpoint);
		const placeholder = (await ProtocolDevicesModel.getByEndpointId(endpoint.id!))[0];
		await ProtocolDevicesModel.syncFromEndpoint({
			...endpoint, data_points: [{ device_uuid: '   ' }, { device_uuid: null }, { device_uuid: 'pump-1' }],
		});
		const devices = await ProtocolDevicesModel.getByEndpointId(endpoint.id!);
		expect(devices).toHaveLength(2);
		expect(devices.find(d => d.uuid === placeholder.uuid)?.identifier).toBeNull();
		expect(devices.find(d => d.identifier === 'pump-1')?.uuid)
			.toBe(require('../../src/db/models/device.model').toDeviceUuid('pump-1'));
		expect(devices.find(d => d.identifier === '   ')).toBeUndefined();
	});

	it('treats a nonempty DeviceUUID equal to the old default sentinel as a real identifier', async () => {
		const endpoint = await EndpointModel.create({
			name: 'sentinel-identifier', protocol: 'opcua', enabled: true, poll_interval: 5000,
			connection: { endpointUrl: 'opc.tcp://localhost:4857' }, data_points: [],
		});
		await ProtocolDevicesModel.syncFromEndpoint(endpoint);
		const [placeholder] = await ProtocolDevicesModel.getByEndpointId(endpoint.id!);
		await ProtocolDevicesModel.syncFromEndpoint({
			...endpoint, data_points: [{ nodeId: 'ns=2;s=A', device_uuid: '__default__' }],
		});
		const devices = await ProtocolDevicesModel.getByEndpointId(endpoint.id!);
		expect(devices.find(device => device.uuid === placeholder.uuid)?.identifier).toBeNull();
		expect(devices.find(device => device.identifier === '__default__')?.uuid)
			.toBe(require('../../src/db/models/device.model').toDeviceUuid('__default__'));
	});

	it.each([
		{
			protocol: 'modbus' as const, suffix: 'modbus', connection: { host: '127.0.0.1', port: 1502, slaveId: 1 },
			existing: [{ address: 1, type: 'holding', name: 'one' }, { address: 2, type: 'holding', name: 'two' }],
			incoming: [{ address: 1, functionCode: 3, name: 'changed' }, { address: 3, functionCode: 3, name: 'three' }],
		},
		{
			protocol: 'mqtt' as const, suffix: 'mqtt', connection: { baseTopic: 'phase1' },
			existing: [{ fullTopic: 'phase1/one', name: 'one' }, { fullTopic: 'phase1/two', name: 'two' }],
			incoming: [{ fullTopic: 'phase1/one', name: 'changed' }, { fullTopic: 'phase1/three', name: 'three' }],
		},
	])('retains configured $protocol points during non-authoritative scans', async scenario => {
		const { DiscoveryStore } = require('../../src/discovery/db');
		const endpoint = await EndpointModel.create({
			name: `partial-${scenario.suffix}`, protocol: scenario.protocol, enabled: true, poll_interval: 5000,
			connection: scenario.connection, data_points: scenario.existing,
		});
		await new DiscoveryStore().save([{
			name: endpoint.name, protocol: scenario.protocol, fingerprint: `phase1-${scenario.suffix}`,
			connection: scenario.connection, dataPoints: scenario.incoming, confidence: 'high',
			discoveredAt: new Date().toISOString(), validated: false,
		}], 'partial');
		const saved = await EndpointModel.getByName(endpoint.name);
		expect(saved?.data_points).toHaveLength(3);
		expect(saved?.data_points?.[0].name).toBe('one');
		expect(saved?.data_points?.[1].name).toBe('two');
		expect(saved?.data_points?.[2].name).toBe('three');
	});

	it('preserves the configured list when point addresses are ambiguous', async () => {
		const { DiscoveryStore } = require('../../src/discovery/db');
		const existing = [{ nodeId: 'ns=2;s=A', name: 'first' }, { nodeId: 'ns=2;s=A', name: 'second' }];
		const endpoint = await EndpointModel.create({
			name: 'ambiguous-points', protocol: 'opcua', enabled: false, poll_interval: 5000,
			connection: { endpointUrl: 'opc.tcp://localhost:4856' }, data_points: existing,
		});
		const logger = { warnSync: jest.fn(), debugSync: jest.fn(), infoSync: jest.fn(), errorSync: jest.fn() };
		await new DiscoveryStore(logger).save([{
			name: endpoint.name, protocol: 'opcua', fingerprint: 'ambiguous-points-fingerprint',
			connection: endpoint.connection, dataPoints: [{ nodeId: 'ns=2;s=A', name: 'replacement' }],
			dataPointsComplete: true, confidence: 'medium', discoveredAt: new Date().toISOString(), validated: false,
		}], 'ambiguous');
		expect((await EndpointModel.getByName(endpoint.name))?.data_points).toEqual(existing);
		expect(logger.warnSync).toHaveBeenCalledWith(
			expect.stringContaining('could not be matched safely'), expect.any(Object),
		);
	});

	it.each([
		{ protocol: 'modbus' as const, suffix: 'failed-modbus', status: { successful: false, complete: false, authoritative: false } },
		{ protocol: 'modbus' as const, suffix: 'thrown-modbus', status: undefined, throws: true },
		{ protocol: 'modbus' as const, suffix: 'partial-modbus', status: { successful: true, complete: false, authoritative: true } },
		{ protocol: 'bacnet' as const, suffix: 'failed-bacnet', status: { successful: false, complete: false, authoritative: false } },
		{ protocol: 'bacnet' as const, suffix: 'thrown-bacnet', status: undefined, throws: true },
		{ protocol: 'bacnet' as const, suffix: 'partial-bacnet', status: { successful: true, complete: false, authoritative: true } },
		{ protocol: 'mqtt' as const, suffix: 'unknown-mqtt', status: undefined },
		{ protocol: 'opcua' as const, suffix: 'non-authoritative-opcua', status: { successful: true, complete: true, authoritative: false } },
		{ protocol: 'opcua' as const, suffix: 'unsuccessful-opcua', status: { successful: false, complete: true, authoritative: true } },
	])('does not prune on a $suffix scan', async scenario => {
		const { protocol, suffix, status } = scenario;
		const { DiscoveryService } = require('../../src/discovery/service');
		const endpoint = await EndpointModel.create({
			name: `scan-${suffix}`, protocol, enabled: true, poll_interval: 5000,
			connection: { test: suffix },
		});
		const service = new DiscoveryService();
		const internals = service as unknown as {
			plugins: Map<string, unknown>;
			optionsBuilder: { build: () => object };
		};
		internals.optionsBuilder = { build: () => ({}) };
		internals.plugins.set(protocol, {
			isAvailable: async () => true,
			discover: async () => {
				if ('throws' in scenario && scenario.throws) throw new Error('interrupted scan');
				return Object.assign([], { scanComplete: true, scanStatus: status });
			},
		});
		try {
			for (let i = 0; i < 2; i++) {
				await service.runDiscovery({ trigger: 'manual', protocols: [protocol], forceRun: true, prune: true });
			}
			const saved = await EndpointModel.getByName(endpoint.name);
			expect(saved?.enabled).toBe(true);
			expect(saved?.metadata?.pruneMissCount ?? 0).toBe(0);
		} finally {
			service.cleanup();
		}
	});

	it('permits explicit pruning after complete authoritative successful scans', async () => {
		const { DiscoveryService } = require('../../src/discovery/service');
		const endpoint = await EndpointModel.create({
			name: 'scan-authoritative', protocol: 'can', enabled: true, poll_interval: 5000,
			connection: { test: 'authoritative' },
		});
		const service = new DiscoveryService();
		const internals = service as unknown as {
			plugins: Map<string, unknown>;
			optionsBuilder: { build: () => object };
		};
		internals.optionsBuilder = { build: () => ({}) };
		internals.plugins.set('can', {
			isAvailable: async () => true,
			discover: async () => Object.assign([], {
				scanComplete: false,
				scanStatus: { successful: true, complete: true, authoritative: true },
			}),
		});
		try {
			await service.runDiscovery({ trigger: 'manual', protocols: ['can'], forceRun: true });
			expect((await EndpointModel.getByName(endpoint.name))?.enabled).toBe(true);
			for (let i = 0; i < 2; i++) {
				await service.runDiscovery({ trigger: 'manual', protocols: ['can'], forceRun: true, prune: true });
			}
			expect((await EndpointModel.getByName(endpoint.name))?.enabled).toBe(false);
		} finally {
			service.cleanup();
		}
	});

	it('does not prune when a point inventory is incomplete despite authoritative scan status', async () => {
		const { DiscoveryService } = require('../../src/discovery/service');
		const endpoint = await EndpointModel.create({
			name: 'scan-incomplete-points-protected', protocol: 'can', enabled: true, poll_interval: 5000,
			connection: { test: 'incomplete-points' },
		});
		const service = new DiscoveryService();
		const internals = service as unknown as {
			plugins: Map<string, unknown>;
			optionsBuilder: { build: () => object };
		};
		internals.optionsBuilder = { build: () => ({}) };
		internals.plugins.set('can', {
			isAvailable: async () => true,
			discover: async () => Object.assign([{
				name: 'scan-incomplete-points-observed', protocol: 'can', fingerprint: 'incomplete-points',
				connection: {}, dataPoints: [], dataPointsComplete: false,
				confidence: 'medium', discoveredAt: new Date().toISOString(), validated: false,
			}], { scanStatus: { successful: true, complete: true, authoritative: true } }),
		});
		try {
			for (let i = 0; i < 2; i++) {
				await service.runDiscovery({ trigger: 'manual', protocols: ['can'], forceRun: true, prune: true, skipDbWrites: true });
			}
			const saved = await EndpointModel.getByName(endpoint.name);
			expect(saved?.enabled).toBe(true);
			expect(saved?.metadata?.pruneMissCount ?? 0).toBe(0);
		} finally {
			service.cleanup();
		}
	});

	it.each(['complete-first', 'partial-first', 'throws-second'])('does not prune when repeated protocol scans are mixed: %s', async order => {
		const { DiscoveryService } = require('../../src/discovery/service');
		const endpoint = await EndpointModel.create({
			name: `scan-repeated-${order}`, protocol: 'can', enabled: true, poll_interval: 5000,
			connection: { test: order },
		});
		const service = new DiscoveryService();
		const internals = service as unknown as {
			plugins: Map<string, unknown>;
			optionsBuilder: { build: () => object };
		};
		internals.optionsBuilder = { build: () => ({}) };
		let calls = 0;
		internals.plugins.set('can', {
			isAvailable: async () => true,
			discover: async () => {
				const first = ++calls % 2 === 1;
				if (order === 'throws-second' && !first) throw new Error('interrupted scan');
				const complete = first === (order !== 'partial-first');
				return Object.assign([], { scanStatus: { successful: true, complete, authoritative: true } });
			},
		});
		try {
			for (let i = 0; i < 2; i++) {
				await service.runDiscovery({ trigger: 'manual', protocols: ['can', 'can'], forceRun: true, prune: true });
			}
			const saved = await EndpointModel.getByName(endpoint.name);
			expect(saved?.enabled).toBe(true);
			expect(saved?.metadata?.pruneMissCount ?? 0).toBe(0);
		} finally {
			service.cleanup();
		}
	});

	it.each([
		{
			protocol: 'opcua' as const, connection: { endpointUrl: 'opc.tcp://localhost:4890' },
			address: { nodeId: 'ns=2;s=A' }, otherAddress: { nodeId: 'ns=2;s=B' },
			oldObservation: { browseName: 'Old' }, newObservation: { browseName: 'Fresh' },
		},
		{
			protocol: 'mqtt' as const, connection: { baseTopic: 'merge-test' },
			address: { fullTopic: 'merge-test/a' }, otherAddress: { fullTopic: 'merge-test/b' },
			oldObservation: { sampleFields: ['old'] }, newObservation: { sampleFields: ['fresh'] },
		},
		{
			protocol: 'bacnet' as const, connection: { ipAddress: '127.0.0.2', deviceInstance: 456 },
			address: { objectType: 'analog-input', objectInstance: 1 },
			otherAddress: { objectType: 'analog-input', objectInstance: 2 },
			oldObservation: { objectName: 'Old' }, newObservation: { objectName: 'Fresh' }, incomingAddress: { propertyId: 85 },
		},
		{
			protocol: 'modbus' as const, connection: { host: '127.0.0.2', port: 1502, slaveId: 2 },
			address: { address: 1, type: 'holding' }, otherAddress: { address: 2, type: 'holding' },
			oldObservation: {}, newObservation: {}, incomingConfig: { label: 'New profile label' },
		},
	])('updates $protocol observations without replacing user configuration or absent points', async scenario => {
		const { DiscoveryStore } = require('../../src/discovery/db');
		const settings = { name: 'custom-name', scale: 2, offset: 3, unit: 'custom-unit', enabled: false, writable: false };
		const first = { ...scenario.address, ...settings, ...scenario.oldObservation };
		const second = { ...scenario.otherAddress, name: 'other' };
		const endpoint = await EndpointModel.create({
			name: `merge-${scenario.protocol}`, protocol: scenario.protocol, enabled: true, poll_interval: 5000,
			connection: scenario.connection, data_points: [first, second],
		});
		await new DiscoveryStore().save([{
			name: endpoint.name, protocol: scenario.protocol, fingerprint: `merge-${scenario.protocol}`,
			connection: scenario.connection, dataPoints: [{
				...scenario.address, ...scenario.newObservation,
				...('incomingAddress' in scenario ? scenario.incomingAddress : {}),
				...('incomingConfig' in scenario ? scenario.incomingConfig : {}),
				name: 'discovered-name', scale: 8, offset: 9, unit: 'discovered-unit', enabled: true, writable: true,
			}], dataPointsComplete: false, confidence: 'medium', discoveredAt: new Date().toISOString(), validated: false,
		}], 'partial');
		const points = (await EndpointModel.getByName(endpoint.name))!.data_points!;
		expect(points).toHaveLength(2);
		expect(points[0]).toMatchObject({ ...scenario.address, ...settings, ...scenario.newObservation });
		if ('incomingConfig' in scenario) expect(points[0]).not.toHaveProperty('label');
		expect(points[1]).toEqual(second);
	});

	it('does not add unconfigured point settings or a conflicting device name during OPC UA rediscovery', async () => {
		const { DiscoveryStore } = require('../../src/discovery/db');
		const previous = { nodeId: 'ns=2;s=A', name: 'custom', device_uuid: 'old-device', browseName: 'Old' };
		const endpoint = await EndpointModel.create({
			name: 'merge-opcua-settings', protocol: 'opcua', enabled: true, poll_interval: 5000,
			connection: { endpointUrl: 'opc.tcp://localhost:4891' }, data_points: [previous],
		});
		await new DiscoveryStore().save([{
			name: endpoint.name, protocol: 'opcua', fingerprint: 'opcua-settings', connection: endpoint.connection,
			dataPoints: [{
				nodeId: previous.nodeId, name: 'new', browseName: 'Fresh', device_uuid: 'other-device',
				device_name: 'Other', writable: true, unit: 'C', scalingFactor: 5, semantic: 'metadata',
			}], confidence: 'medium', discoveredAt: new Date().toISOString(), validated: false,
		}], 'settings');
		expect((await EndpointModel.getByName(endpoint.name))?.data_points).toEqual([
			{ ...previous, browseName: 'Fresh' },
		]);
	});

	it('warns about conflicting OPC UA identifiers and preserves confirmed evidence', async () => {
		const { DiscoveryStore } = require('../../src/discovery/db');
		const { DeviceResolutionStore } = require('../../src/discovery/device-resolution-store');
		const db: DatabaseSync = require('../../src/db/sqlite').getDatabase();
		const endpoint = await EndpointModel.create({
			name: 'opcua-association-conflict', protocol: 'opcua', enabled: true, poll_interval: 5000,
			connection: { endpointUrl: 'opc.tcp://localhost:4893' }, data_points: [],
		});
		const candidate = {
			candidateId: 'owner', name: 'Owner', keys: [{ kind: 'external-identifier', value: 'owner-id' }],
			pointAddresses: ['ns=2;s=A'], reasons: [],
		};
		const [confirmed] = new DeviceResolutionStore(db).confirm(endpoint.uuid!, [candidate], ['owner']);
		const previousUuid = confirmed.identity.deviceUuid;
		await EndpointModel.update(endpoint.name, {
			data_points: [{ nodeId: 'ns=2;s=A', device_uuid: previousUuid, device_name: 'Owner' }],
		});
		const logger = { debugSync: jest.fn(), infoSync: jest.fn(), warnSync: jest.fn(), errorSync: jest.fn() };
		await new DiscoveryStore(logger).save([{
			name: endpoint.name, protocol: 'opcua', fingerprint: 'opcua-conflict', connection: endpoint.connection,
			dataPoints: [{ nodeId: 'ns=2;s=A', device_uuid: 'different-id', device_name: 'Other', browseName: 'Fresh' }],
			confidence: 'medium', discoveredAt: new Date().toISOString(), validated: false,
		}], 'conflict-trace');
		expect((await EndpointModel.getByName(endpoint.name))?.data_points).toEqual([
			{ nodeId: 'ns=2;s=A', device_uuid: previousUuid, device_name: 'Owner', browseName: 'Fresh' },
		]);
		expect(logger.warnSync).toHaveBeenCalledWith(
			'OPC UA device association conflict; preserving existing association',
			expect.objectContaining({
				endpointName: endpoint.name, endpointUuid: endpoint.uuid, pointAddress: 'ns=2;s=A',
				existingIdentifier: previousUuid, discoveredIdentifier: 'different-id', traceId: 'conflict-trace',
			}),
		);
		expect(db.prepare('SELECT device_uuid FROM device_resolution_points WHERE endpoint_id = ? AND address = ?')
			.get(endpoint.id!, 'ns=2;s=A')).toMatchObject({ device_uuid: previousUuid });
		expect(db.prepare('SELECT device_uuid FROM device_resolution_keys WHERE endpoint_id = ? AND value = ?')
			.get(endpoint.id!, 'owner-id')).toMatchObject({ device_uuid: previousUuid });
	});

	it.each([
		{ protocol: 'opcua' as const, original: { endpointUrl: 'opc.tcp://old:4840', securityMode: 'Sign', securityPolicy: 'Basic256Sha256', certificateTrustMode: 'strict', username: 'operator', password: 'configured', useSubscription: false }, incoming: { endpointUrl: 'opc.tcp://new:4840', securityMode: 'None', securityPolicy: 'None', certificateTrustMode: 'trust-on-first-use', username: 'other', password: 'discovered', useSubscription: true } },
		{ protocol: 'mqtt' as const, original: { host: 'old', port: 1883, baseTopic: 'configured', username: 'operator', password: 'configured', autoMetrics: false }, incoming: { host: 'new', port: 1884, baseTopic: 'observed', username: 'other', password: 'discovered', autoMetrics: true } },
		{ protocol: 'modbus' as const, original: { host: 'old', port: 502, slaveId: 1, timeout: 7000 }, incoming: { host: 'new', port: 503, slaveId: 2, timeout: 1000 } },
		{ protocol: 'bacnet' as const, original: { host: 'old', port: 47808, deviceInstance: 1, maxApdu: 480 }, incoming: { host: 'new', port: 47809, deviceInstance: 2, maxApdu: 1476 } },
	])('preserves $protocol connection settings on both rediscovery update paths', async scenario => {
		const { DiscoveryStore } = require('../../src/discovery/db');
		for (const changed of [false, true]) {
			const original = scenario.protocol === 'opcua'
				? { ...scenario.original, endpointUrl: `opc.tcp://old-${changed}:4840` }
				: scenario.original;
			const endpoint = await EndpointModel.create({
				name: `connection-${scenario.protocol}-${changed}`, protocol: scenario.protocol,
				enabled: false, poll_interval: 5000, connection: original, data_points: [],
			});
			const emit = jest.fn();
			await new DiscoveryStore(undefined, undefined, emit).save([{
				name: endpoint.name, protocol: scenario.protocol, fingerprint: `connection-${scenario.protocol}-${changed}`,
				connection: scenario.incoming, dataPoints: [], confidence: 'medium',
				discoveredAt: new Date().toISOString(), validated: false,
				...(changed ? { metadata: { profile: 'Observed' } } : {}),
			}], 'connection', false, undefined, true);
			const saved = await EndpointModel.getByName(endpoint.name);
			expect(saved?.connection).toEqual(original);
			expect(saved?.enabled).toBe(true);
			expect(emit).toHaveBeenCalledWith('endpoint-enabled', expect.objectContaining({
				endpoint: expect.objectContaining({ connection: original }),
			}));
		}
	});

	it('matches equivalent OPC UA numeric NodeIds without adding a duplicate point', async () => {
		const { DiscoveryStore } = require('../../src/discovery/db');
		const endpoint = await EndpointModel.create({
			name: 'equivalent-node-id', protocol: 'opcua', enabled: true, poll_interval: 5000,
			connection: { endpointUrl: 'opc.tcp://localhost:4892' },
			data_points: [{ nodeId: 'ns=0;i=85', name: 'custom', browseName: 'Old' }],
		});
		await new DiscoveryStore().save([{
			name: endpoint.name, protocol: 'opcua', fingerprint: 'equivalent-node-id', connection: endpoint.connection,
			dataPoints: [{ nodeId: 'i=85', name: 'discovered', browseName: 'Fresh' }],
			confidence: 'medium', discoveredAt: new Date().toISOString(), validated: false,
		}], 'equivalent-node-id');
		expect((await EndpointModel.getByName(endpoint.name))?.data_points).toEqual([
			{ nodeId: 'ns=0;i=85', name: 'custom', browseName: 'Fresh' },
		]);
	});

	it.each([
		{ suffix: 'conflicting', existing: [{ address: 1, type: 'holding', functionCode: 4, name: 'first' }], incoming: [{ address: 1, functionCode: 4, name: 'replace' }] },
		{ suffix: 'out-of-range', existing: [{ address: 65536, functionCode: 3, name: 'first' }], incoming: [{ address: 65536, functionCode: 3, name: 'replace' }] },
	])('preserves the configured list for $suffix Modbus addresses', async ({ suffix, existing, incoming }) => {
		const { DiscoveryStore } = require('../../src/discovery/db');
		const endpoint = await EndpointModel.create({
			name: `ambiguous-modbus-${suffix}`, protocol: 'modbus', enabled: false, poll_interval: 5000,
			connection: { host: `modbus-${suffix}`, port: 1502, slaveId: 1 }, data_points: existing,
		});
		const logger = { warnSync: jest.fn(), debugSync: jest.fn(), infoSync: jest.fn(), errorSync: jest.fn() };
		await new DiscoveryStore(logger).save([{
			name: endpoint.name, protocol: 'modbus', fingerprint: `modbus-${suffix}`, connection: endpoint.connection,
			dataPoints: incoming, confidence: 'medium', discoveredAt: new Date().toISOString(), validated: false,
		}], suffix);
		expect((await EndpointModel.getByName(endpoint.name))?.data_points).toEqual(existing);
		expect(logger.warnSync).toHaveBeenCalledWith(expect.stringContaining('could not be matched safely'), expect.any(Object));
	});

	it.each([
		{ protocol: 'opcua' as const, suffix: 'node-id', existing: [{ nodeId: 'i=1invalid', name: 'first' }], incoming: [{ nodeId: 'i=1', name: 'second' }] },
		{ protocol: 'opcua' as const, suffix: 'node-aliases', existing: [{ nodeId: 'i=85', name: 'first' }, { nodeId: 'ns=0;i=85', name: 'second' }], incoming: [{ nodeId: 'i=85', name: 'replace' }] },
		{ protocol: 'mqtt' as const, suffix: 'wildcard', existing: [{ fullTopic: 'devices/+', name: 'first' }], incoming: [{ fullTopic: 'devices/1', name: 'second' }] },
		{ protocol: 'bacnet' as const, suffix: 'unknown-type', existing: [{ objectType: 'type-0', objectInstance: 1, name: 'first' }], incoming: [{ objectType: 'analog-input', objectInstance: 1, name: 'second' }] },
		{ protocol: 'bacnet' as const, suffix: 'missing-instance', existing: [{ objectType: 'analog-input', name: 'first' }], incoming: [{ objectType: 'analog-input', objectInstance: 1, name: 'second' }] },
	])('preserves $suffix points when an address cannot be proven safe', async scenario => {
		const { DiscoveryStore } = require('../../src/discovery/db');
		const endpoint = await EndpointModel.create({
			name: `invalid-address-${scenario.suffix}`, protocol: scenario.protocol, enabled: false, poll_interval: 5000,
			connection: { test: scenario.suffix }, data_points: scenario.existing,
		});
		const logger = { warnSync: jest.fn(), debugSync: jest.fn(), infoSync: jest.fn(), errorSync: jest.fn() };
		await new DiscoveryStore(logger).save([{
			name: endpoint.name, protocol: scenario.protocol, fingerprint: `invalid-${scenario.suffix}`,
			connection: endpoint.connection, dataPoints: scenario.incoming, confidence: 'medium',
			discoveredAt: new Date().toISOString(), validated: false,
		}], scenario.suffix);
		expect((await EndpointModel.getByName(endpoint.name))?.data_points).toEqual(scenario.existing);
		expect(logger.warnSync).toHaveBeenCalledWith(expect.stringContaining('could not be matched safely'), expect.any(Object));
	});

	it('preserves a confirmed BACnet object name when a scan only has a synthetic fallback', async () => {
		const { DiscoveryStore } = require('../../src/discovery/db');
		const point = { objectType: 'analog-input', objectInstance: 7, name: 'custom', objectName: 'Real Name' };
		const endpoint = await EndpointModel.create({
			name: 'bacnet-fallback-name', protocol: 'bacnet', enabled: false, poll_interval: 5000,
			connection: { test: 'fallback' }, data_points: [point],
		});
		await new DiscoveryStore().save([{
			name: endpoint.name, protocol: 'bacnet', fingerprint: 'bacnet-fallback', connection: endpoint.connection,
			dataPoints: [{ ...point, objectName: 'analog-input_7', propertyId: 85 }],
			confidence: 'medium', discoveredAt: new Date().toISOString(), validated: false,
		}], 'bacnet-fallback');
		expect((await EndpointModel.getByName(endpoint.name))?.data_points).toEqual([point]);
	});

	it.each(['modbus', 'mqtt', 'bacnet'] as const)('preserves disabled %s devices during endpoint resynchronization', async protocol => {
		const endpoint = await EndpointModel.create({
			name: `disabled-${protocol}-device`, protocol, enabled: true, poll_interval: 5000,
			connection: protocol === 'modbus' ? { host: 'disabled-device', port: 1502, slaveId: 1 } : { test: protocol },
		});
		await ProtocolDevicesModel.syncFromEndpoint(endpoint);
		const [device] = await ProtocolDevicesModel.getByEndpointId(endpoint.id!);
		await ProtocolDevicesModel.upsertDevice({
			uuid: require('crypto').randomUUID(), endpoint_id: endpoint.id!, name: 'other',
			protocol, enabled: true, identifier: 'other',
		});
		await ProtocolDevicesModel.setEnabled(device.uuid, false);
		await ProtocolDevicesModel.syncFromEndpoint(endpoint);
		expect(await ProtocolDevicesModel.getByUuid(device.uuid)).toMatchObject({ uuid: device.uuid, enabled: false });
	});
});
