/**
 * Unit tests for BACnetClient.write() — application-tag resolution, value
 * coercion, and dispatch to bacstack's writeProperty. Mocks the 'bacstack'
 * transport entirely; no real UDP socket is used.
 */

jest.mock('bacstack', () => {
	const ApplicationTags = {
		NULL: 0,
		BOOLEAN: 1,
		UNSIGNED_INTEGER: 2,
		SIGNED_INTEGER: 3,
		REAL: 4,
		DOUBLE: 5,
		OCTET_STRING: 6,
		CHARACTER_STRING: 7,
		BIT_STRING: 8,
		ENUMERATED: 9,
	};

	const MockBACnet: any = jest.fn().mockImplementation(function (this: any) {
		this.writeProperty = jest.fn();
		this.readProperty = jest.fn();
		this.close = jest.fn();
		this._transport = null;
		MockBACnet.instances.push(this);
	});
	MockBACnet.instances = [] as any[];
	MockBACnet.enum = { ApplicationTags };

	return { __esModule: true, default: MockBACnet };
});

import BACnetCtor from 'bacstack';
import { BACnetClient } from '../../../../src/plugins/bacnet/client';
import { BACnetObjectType, BACnetProperty } from '../../../../src/plugins/bacnet/types';
import type { BACnetDevice } from '../../../../src/plugins/bacnet/types';

const MockBACnet = BACnetCtor as unknown as { instances: any[] };

function makeLogger() {
	return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
}

function makeDevice(overrides: Partial<BACnetDevice> = {}, objectOverrides: Record<string, unknown> = {}): BACnetDevice {
	return {
		name: 'ahu-1',
		ipAddress: '192.168.1.50',
		port: 47808,
		deviceInstance: 100,
		enabled: true,
		pollIntervalMs: 5000,
		maxConcurrentReads: 5,
		connectionTimeoutMs: 200,
		retryAttempts: 0,
		retryDelayMs: 100,
		objects: [
			{
				name: 'SpeedSetpoint',
				objectType: BACnetObjectType.ANALOG_VALUE,
				objectInstance: 1,
				propertyId: BACnetProperty.PRESENT_VALUE,
				unit: '',
				pollIntervalMs: 5000,
				enabled: true,
				writable: true,
				writePriority: 8,
				...objectOverrides,
			},
		],
		...overrides,
	} as BACnetDevice;
}

async function makeConnectedClient(device: BACnetDevice): Promise<BACnetClient> {
	const client = new BACnetClient(device, 47810, makeLogger());
	await client.connect();
	return client;
}

function latestMockBacnetInstance() {
	return MockBACnet.instances[MockBACnet.instances.length - 1];
}

describe('BACnetClient.write', () => {
	beforeEach(() => {
		MockBACnet.instances.length = 0;
	});

	it('writes an analog-value using an inferred REAL tag and configured priority', async () => {
		const device = makeDevice();
		const client = await makeConnectedClient(device);
		const mockInstance = latestMockBacnetInstance();
		mockInstance.writeProperty.mockImplementation((_addr: string, _objId: any, _propId: number, _values: any, _options: any, next: any) => next(null));

		await client.write('SpeedSetpoint', 42.5);

		expect(mockInstance.writeProperty).toHaveBeenCalledWith(
			'192.168.1.50',
			{ type: 2, instance: 1 }, // analog-value = 2
			BACnetProperty.PRESENT_VALUE,
			[{ type: 4, value: 42.5 }], // REAL = 4
			expect.objectContaining({ priority: 8 }),
			expect.any(Function),
		);
	});

	it('writes a binary-output using an inferred BOOLEAN tag', async () => {
		const device = makeDevice({}, { objectType: BACnetObjectType.BINARY_OUTPUT, name: 'FanStart' });
		const client = await makeConnectedClient(device);
		const mockInstance = latestMockBacnetInstance();
		mockInstance.writeProperty.mockImplementation((_a: string, _o: any, _p: number, _v: any, _opt: any, next: any) => next(null));

		await client.write('FanStart', true);

		expect(mockInstance.writeProperty).toHaveBeenCalledWith(
			expect.any(String),
			{ type: 4, instance: 1 }, // binary-output = 4
			expect.any(Number),
			[{ type: 1, value: true }], // BOOLEAN = 1
			expect.any(Object),
			expect.any(Function),
		);
	});

	it('writes a multi-state-value using an inferred UNSIGNED_INTEGER tag', async () => {
		const device = makeDevice({}, { objectType: BACnetObjectType.MULTI_STATE_VALUE, name: 'OpMode' });
		const client = await makeConnectedClient(device);
		const mockInstance = latestMockBacnetInstance();
		mockInstance.writeProperty.mockImplementation((_a: string, _o: any, _p: number, _v: any, _opt: any, next: any) => next(null));

		await client.write('OpMode', 2);

		expect(mockInstance.writeProperty).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(Object),
			expect.any(Number),
			[{ type: 2, value: 2 }], // UNSIGNED_INTEGER = 2
			expect.any(Object),
			expect.any(Function),
		);
	});

	it('honors an explicit writeDataType override instead of the inferred type', async () => {
		const device = makeDevice({}, { writeDataType: 'double' });
		const client = await makeConnectedClient(device);
		const mockInstance = latestMockBacnetInstance();
		mockInstance.writeProperty.mockImplementation((_a: string, _o: any, _p: number, _v: any, _opt: any, next: any) => next(null));

		await client.write('SpeedSetpoint', 1.5);

		expect(mockInstance.writeProperty).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(Object),
			expect.any(Number),
			[{ type: 5, value: 1.5 }], // DOUBLE = 5
			expect.any(Object),
			expect.any(Function),
		);
	});

	it('rejects a write to an object not marked writable', async () => {
		const device = makeDevice({}, { writable: false });
		const client = await makeConnectedClient(device);

		await expect(client.write('SpeedSetpoint', 1)).rejects.toThrow(/not writable/);
	});

	it('rejects a write to a point name that does not exist', async () => {
		const device = makeDevice();
		const client = await makeConnectedClient(device);

		await expect(client.write('DoesNotExist', 1)).rejects.toThrow(/not found/);
	});

	it('rejects a boolean value for a numeric (analog) object instead of silently coercing it', async () => {
		const device = makeDevice();
		const client = await makeConnectedClient(device);

		await expect(client.write('SpeedSetpoint', true as any)).rejects.toThrow(/numeric/);
	});

	it('rejects a numeric value for a boolean (binary) object instead of silently coercing it', async () => {
		const device = makeDevice({}, { objectType: BACnetObjectType.BINARY_OUTPUT, name: 'FanStart' });
		const client = await makeConnectedClient(device);

		await expect(client.write('FanStart', 1 as any)).rejects.toThrow(/boolean/);
	});

	it('propagates a bacstack error (e.g. BadNotWritable) via the callback', async () => {
		const device = makeDevice();
		const client = await makeConnectedClient(device);
		const mockInstance = latestMockBacnetInstance();
		mockInstance.writeProperty.mockImplementation((_a: string, _o: any, _p: number, _v: any, _opt: any, next: any) =>
			next(new Error('BacnetError - class: 2, code: 27')));

		await expect(client.write('SpeedSetpoint', 1)).rejects.toThrow(/BacnetError/);
	});

	it('rejects a write while disconnected', async () => {
		const device = makeDevice();
		const client = new BACnetClient(device, 47810, makeLogger()); // never connected

		await expect(client.write('SpeedSetpoint', 1)).rejects.toThrow(/not connected/);
	});
});
