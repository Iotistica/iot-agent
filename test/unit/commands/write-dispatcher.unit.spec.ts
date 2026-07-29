import { ModbusAdapter } from '../../../src/plugins/modbus/adapter';
import { OPCUAAdapter } from '../../../src/plugins/opcua/adapter';
import type { AdapterManager } from '../../../src/plugins/index';
import { CommandError } from '../../../src/commands/command-errors';
import { CommandErrorCode } from '../../../src/commands/types';
import { dispatchWrite } from '../../../src/commands/write-dispatcher';

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

		expect(writeNode).toHaveBeenCalledWith('ahu-1', 'SpeedSetpoint', 42);
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

	it('rejects a protocol with no write support (e.g. bacnet, not yet implemented)', async () => {
		const bacnetAdapter = fakeInstance(class Fake {}, {
			getDeviceStatuses: () => [{ deviceName: 'ahu-1' }],
		});
		const adapterManager = fakeAdapterManager({ bacnet: bacnetAdapter as any });

		await expect(dispatchWrite(adapterManager, 'ahu-1', 'x', 1)).rejects.toMatchObject({
			code: CommandErrorCode.unsupportedCommandType,
		});
	});
});
