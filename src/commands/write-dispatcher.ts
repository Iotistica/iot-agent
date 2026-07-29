import type { AdapterManager } from '../plugins/index.js';
import { ModbusAdapter } from '../plugins/modbus/adapter.js';
import { OPCUAAdapter } from '../plugins/opcua/adapter.js';
import { CommandError } from './command-errors.js';
import { CommandErrorCode } from './types.js';

/**
 * Resolves a device name to the protocol adapter that currently owns it, by
 * checking each running adapter's device statuses. Devices are provisioned
 * against exactly one protocol, so the first match is authoritative.
 */
function findOwningAdapter(adapterManager: AdapterManager, deviceName: string): { protocol: string; adapter: unknown } | undefined {
	for (const [protocol, adapter] of adapterManager.getAllAdapters()) {
		if (adapter.getDeviceStatuses().some((status) => status.deviceName === deviceName)) {
			return { protocol, adapter };
		}
	}
	return undefined;
}

/** Classifies a thrown Error's message into a stable command error code without changing the adapters that throw it. */
function classifyWriteError(error: unknown): CommandError {
	const message = error instanceof Error ? error.message : String(error);
	const lower = message.toLowerCase();

	if (lower.includes('not found')) {
		return new CommandError(CommandErrorCode.nodeNotAllowed, message);
	}
	if (lower.includes('not writable')) {
		return new CommandError(CommandErrorCode.nodeNotAllowed, message);
	}
	if (lower.includes('not connected')) {
		return new CommandError(CommandErrorCode.deviceNotConnected, message);
	}
	return new CommandError(CommandErrorCode.writeRejected, message);
}

/**
 * Executes a validated write command against whichever adapter owns the
 * device. Each adapter already enforces its own writable-point allowlist
 * (OPC-UA: `dataPoints[].writable`, Modbus: checked here via the register's
 * `writable` flag since the existing HTTP write endpoint intentionally
 * doesn't gate on it) — this function does not duplicate that logic, only
 * dispatches to it and normalizes the resulting errors.
 */
export async function dispatchWrite(
	adapterManager: AdapterManager,
	deviceName: string,
	pointName: string,
	value: number | boolean | string,
): Promise<void> {
	const owner = findOwningAdapter(adapterManager, deviceName);
	if (!owner) {
		throw new CommandError(CommandErrorCode.nodeNotAllowed, `Device not found: ${deviceName}`);
	}

	try {
		if (owner.protocol === 'modbus' && owner.adapter instanceof ModbusAdapter) {
			const register = owner.adapter.getRegisterConfig(deviceName, pointName);
			if (!register) {
				throw new Error(`Register not found: ${pointName}`);
			}
			if (!register.writable) {
				throw new CommandError(CommandErrorCode.nodeNotAllowed, `Register is not writable via commands: ${pointName}`);
			}
			await owner.adapter.writeRegister(deviceName, pointName, value);
			return;
		}

		if (owner.protocol === 'opcua' && owner.adapter instanceof OPCUAAdapter) {
			await owner.adapter.writeNode(deviceName, pointName, value);
			return;
		}

		throw new CommandError(CommandErrorCode.unsupportedCommandType, `Protocol '${owner.protocol}' does not support command writes`);
	} catch (error) {
		if (error instanceof CommandError) {
			throw error;
		}
		throw classifyWriteError(error);
	}
}
