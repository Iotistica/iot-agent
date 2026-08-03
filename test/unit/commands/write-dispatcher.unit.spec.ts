import { BACnetAdapter } from '../../../src/plugins/bacnet/adapter';
import { ModbusAdapter } from '../../../src/plugins/modbus/adapter';
import { OPCUAAdapter } from '../../../src/plugins/opcua/adapter';
import type { AdapterManager } from '../../../src/plugins/index';
import { CommandError } from '../../../src/commands/command-errors';
import { CommandErrorCode } from '../../../src/commands/types';
import { dispatchWrite } from '../../../src/commands/write-dispatcher';
import { DeviceModel } from '../../../src/db/models/device.model';
import { EndpointModel } from '../../../src/db/models/endpoint.model';

jest.mock('../../../src/db/models/device.model');
jest.mock('../../../src/db/models/endpoint.model');

const MockedDeviceModel = DeviceModel as jest.Mocked<typeof DeviceModel>;
const MockedEndpointModel = EndpointModel as jest.Mocked<typeof EndpointModel>;

/** Builds a fake adapter that passes `instanceof <Ctor>` without running its (heavy) real constructor. */
function fakeInstance<T extends object>(ctor: { prototype: T }, overrides: Partial<T>): T {
	return Object.assign(Object.create(ctor.prototype), overrides);
}

function fakeAdapterManager(adapters: Record<string, { getDeviceStatuses: () => { deviceName: string }[] }>): AdapterManager {
	return {
		getAllAdapters: () => new Map(Object.entries(adapters)),
	} as unknown as AdapterManager;
}

describe('dispatchWrite', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		// Default: not a real devices.uuid — every existing test below exercises
		// the raw-name fallback path unless it explicitly overrides this.
		MockedDeviceModel.getByUuid.mockResolvedValue(null);
	});


	it('writes to a Modbus register when the register is marked writable', async () => {
		const writeRegister = jest.fn().mockResolvedValue(undefined);
		const modbusAdapter = fakeInstance(ModbusAdapter, {
			getDeviceStatuses: () => [{ deviceName: 'plc-1' }],
			getRegisterConfig: () => ({ name: 'speed', writable: true } as any),
			writeRegister,
		});
		const adapterManager = fakeAdapterManager({ modbus: modbusAdapter as any });

		await dispatchWrite(adapterManager, 'plc-1', 'speed', 1500);

		expect(writeRegister).toHaveBeenCalledWith('plc-1', 'speed', 1500);
	});

	it('rejects a Modbus register that is not marked writable, without calling writeRegister', async () => {
		const writeRegister = jest.fn();
		const modbusAdapter = fakeInstance(ModbusAdapter, {
			getDeviceStatuses: () => [{ deviceName: 'plc-1' }],
			getRegisterConfig: () => ({ name: 'speed', writable: false } as any),
			writeRegister,
		});
		const adapterManager = fakeAdapterManager({ modbus: modbusAdapter as any });

		await expect(dispatchWrite(adapterManager, 'plc-1', 'speed', 1500)).rejects.toMatchObject({
			code: CommandErrorCode.nodeNotAllowed,
		});
		expect(writeRegister).not.toHaveBeenCalled();
	});

	it('rejects a Modbus register that does not exist in device config', async () => {
		const modbusAdapter = fakeInstance(ModbusAdapter, {
			getDeviceStatuses: () => [{ deviceName: 'plc-1' }],
			getRegisterConfig: () => undefined,
			writeRegister: jest.fn(),
		});
		const adapterManager = fakeAdapterManager({ modbus: modbusAdapter as any });

		await expect(dispatchWrite(adapterManager, 'plc-1', 'unknown-point', 1)).rejects.toBeInstanceOf(CommandError);
	});

	it('writes to an OPC-UA node via writeNode', async () => {
		const writeNode = jest.fn().mockResolvedValue(undefined);
		const opcuaAdapter = fakeInstance(OPCUAAdapter, {
			getDeviceStatuses: () => [{ deviceName: 'ahu-1' }],
			writeNode,
		});
		const adapterManager = fakeAdapterManager({ opcua: opcuaAdapter as any });

		await dispatchWrite(adapterManager, 'ahu-1', 'SpeedSetpoint', 42);

		// 4th arg is the logicalIdentifier resolved via the devices table
		// (see write-dispatcher.ts's resolveWriteTarget) — undefined here since
		// 'ahu-1' isn't a real devices.uuid, so this falls back to the
		// raw-name path, which doesn't have one.
		expect(writeNode).toHaveBeenCalledWith('ahu-1', 'SpeedSetpoint', 42, undefined);
	});

	it('classifies a thrown "not writable" error from writeNode as NODE_NOT_ALLOWED', async () => {
		const opcuaAdapter = fakeInstance(OPCUAAdapter, {
			getDeviceStatuses: () => [{ deviceName: 'ahu-1' }],
			writeNode: jest.fn().mockRejectedValue(new Error('Node is not writable: Foo (ns=2;s=Foo)')),
		});
		const adapterManager = fakeAdapterManager({ opcua: opcuaAdapter as any });

		await expect(dispatchWrite(adapterManager, 'ahu-1', 'Foo', 1)).rejects.toMatchObject({
			code: CommandErrorCode.nodeNotAllowed,
		});
	});

	it('classifies a thrown "not connected" error as DEVICE_NOT_CONNECTED', async () => {
		const opcuaAdapter = fakeInstance(OPCUAAdapter, {
			getDeviceStatuses: () => [{ deviceName: 'ahu-1' }],
			writeNode: jest.fn().mockRejectedValue(new Error('Device ahu-1 is not connected')),
		});
		const adapterManager = fakeAdapterManager({ opcua: opcuaAdapter as any });

		await expect(dispatchWrite(adapterManager, 'ahu-1', 'Foo', 1)).rejects.toMatchObject({
			code: CommandErrorCode.deviceNotConnected,
		});
	});

	it('rejects a device name that no adapter recognizes', async () => {
		const adapterManager = fakeAdapterManager({});
		await expect(dispatchWrite(adapterManager, 'ghost-device', 'x', 1)).rejects.toMatchObject({
			code: CommandErrorCode.nodeNotAllowed,
		});
	});

	it('rejects a protocol with no write support at all (e.g. a future/unknown protocol)', async () => {
		const unknownAdapter = fakeInstance(class Fake {}, {
			getDeviceStatuses: () => [{ deviceName: 'ahu-1' }],
		});
		const adapterManager = fakeAdapterManager({ 'future-protocol': unknownAdapter as any });

		await expect(dispatchWrite(adapterManager, 'ahu-1', 'x', 1)).rejects.toMatchObject({
			code: CommandErrorCode.unsupportedCommandType,
		});
	});

	it('writes a BACnet object via writeProperty', async () => {
		const writeProperty = jest.fn().mockResolvedValue(undefined);
		const bacnetAdapter = fakeInstance(BACnetAdapter, {
			getDeviceStatuses: () => [{ deviceName: 'ahu-1' }],
			writeProperty,
		});
		const adapterManager = fakeAdapterManager({ bacnet: bacnetAdapter as any });

		await dispatchWrite(adapterManager, 'ahu-1', 'SpeedSetpoint', 42.5);

		expect(writeProperty).toHaveBeenCalledWith('ahu-1', 'SpeedSetpoint', 42.5);
	});

	it('classifies a thrown "not writable" error from a BACnet write as NODE_NOT_ALLOWED', async () => {
		const bacnetAdapter = fakeInstance(BACnetAdapter, {
			getDeviceStatuses: () => [{ deviceName: 'ahu-1' }],
			writeProperty: jest.fn().mockRejectedValue(new Error('Object is not writable: SpeedSetpoint')),
		});
		const adapterManager = fakeAdapterManager({ bacnet: bacnetAdapter as any });

		await expect(dispatchWrite(adapterManager, 'ahu-1', 'SpeedSetpoint', 1)).rejects.toMatchObject({
			code: CommandErrorCode.nodeNotAllowed,
		});
	});

	describe('devices.uuid resolution (preferred over raw/display names)', () => {
		it('resolves a devices.uuid to the exact owning endpoint + logical identifier, not by display name', async () => {
			// Simulates two DIFFERENT OPC-UA servers each configuring their own
			// "AHU-1" — a raw-name match alone could ambiguously hit either;
			// devices.uuid pins down the correct one unambiguously.
			MockedDeviceModel.getByUuid.mockResolvedValue({
				uuid: 'a1b2c3d4-0000-0000-0000-000000000001',
				endpoint_id: 42,
				name: 'AHU-1',
				protocol: 'opcua',
				enabled: true,
				identifier: 'ahu-1',
			} as any);
			MockedEndpointModel.getById.mockResolvedValue({
				id: 42,
				name: 'opcua_server_a_4840',
				protocol: 'opcua',
				enabled: true,
				poll_interval: 5000,
				connection: {},
			} as any);

			const writeNode = jest.fn().mockResolvedValue(undefined);
			const opcuaAdapter = fakeInstance(OPCUAAdapter, {
				getDeviceStatuses: () => [{ deviceName: 'opcua_server_a_4840' }],
				writeNode,
			});
			const adapterManager = fakeAdapterManager({ opcua: opcuaAdapter as any });

			await dispatchWrite(adapterManager, 'a1b2c3d4-0000-0000-0000-000000000001', 'SpeedSetpoint', 42);

			expect(MockedDeviceModel.getByUuid).toHaveBeenCalledWith('a1b2c3d4-0000-0000-0000-000000000001');
			expect(writeNode).toHaveBeenCalledWith('opcua_server_a_4840', 'SpeedSetpoint', 42, 'ahu-1');
		});

		it('falls back to raw-name resolution when the identifier is not a known devices.uuid', async () => {
			MockedDeviceModel.getByUuid.mockResolvedValue(null);

			const writeNode = jest.fn().mockResolvedValue(undefined);
			const opcuaAdapter = fakeInstance(OPCUAAdapter, {
				getDeviceStatuses: () => [{ deviceName: 'opcua_server_a_4840' }],
				writeNode,
			});
			const adapterManager = fakeAdapterManager({ opcua: opcuaAdapter as any });

			await dispatchWrite(adapterManager, 'opcua_server_a_4840', 'SpeedSetpoint', 42);

			expect(writeNode).toHaveBeenCalledWith('opcua_server_a_4840', 'SpeedSetpoint', 42, undefined);
		});

		it('rejects when a devices.uuid resolves but its endpoint no longer exists', async () => {
			MockedDeviceModel.getByUuid.mockResolvedValue({
				uuid: 'a1b2c3d4-0000-0000-0000-000000000001',
				endpoint_id: 999,
				name: 'AHU-1',
				protocol: 'opcua',
				enabled: true,
				identifier: 'ahu-1',
			} as any);
			MockedEndpointModel.getById.mockResolvedValue(null as any);
			const adapterManager = fakeAdapterManager({});

			await expect(dispatchWrite(adapterManager, 'a1b2c3d4-0000-0000-0000-000000000001', 'SpeedSetpoint', 42)).rejects.toMatchObject({
				code: CommandErrorCode.nodeNotAllowed,
			});
		});
	});
});
