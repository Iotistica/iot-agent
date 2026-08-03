import type { AdapterManager } from '../plugins/index.js';
import { BACnetAdapter } from '../plugins/bacnet/adapter.js';
import { ModbusAdapter } from '../plugins/modbus/adapter.js';
import { OPCUAAdapter } from '../plugins/opcua/adapter.js';
import { DeviceModel } from '../db/models/device.model.js';
import { EndpointModel } from '../db/models/endpoint.model.js';
import { CommandError } from './command-errors.js';
import { CommandErrorCode } from './types.js';

interface WriteTarget {
	protocol: string;
	adapter: unknown;
	/** The owning endpoint/connection's own configured name — this is what adapter write methods key sessions/clients by. */
	endpointDeviceName: string;
	/** Raw device_uuid tag, when resolved via the devices table — scopes an OPC-UA write to exactly one logical device, never a same-named one elsewhere. */
	logicalIdentifier?: string;
}

/**
 * Resolves a device identifier to (a) the protocol adapter that owns it and
 * (b) enough detail for that adapter's write method to target the exact
 * device, unambiguously.
 *
 * Two paths, in order:
 * 1. PREFERRED — `deviceIdentifier` is the `devices` table's own `uuid`
 *    column (DB UNIQUE constraint; the same identifier already shown in the
 *    admin UI's Devices grid and used by PATCH/DELETE /v1/devices/:uuid).
 *    Looked up via DeviceModel.getByUuid(), unambiguous by construction even
 *    when two physically different devices share a display name (e.g.
 *    "AHU-1" configured identically on two different OPC-UA servers).
 * 2. FALLBACK — the raw configured endpoint/connection name, or (OPC-UA
 *    only) a friendly per-tag device name via the adapter's own
 *    ownsDeviceName()/getDeviceStatuses(). Best-effort: can collide across
 *    endpoints sharing a display name. Kept for convenience in simple
 *    single-device setups and backward compatibility. See GitHub issue #4.
 */
async function resolveWriteTarget(adapterManager: AdapterManager, deviceIdentifier: string): Promise<WriteTarget | undefined> {
	const deviceRow = await DeviceModel.getByUuid(deviceIdentifier);
	if (deviceRow) {
		const endpoint = await EndpointModel.getById(deviceRow.endpoint_id);
		if (!endpoint) return undefined;
		const adapter = adapterManager.getAllAdapters().get(deviceRow.protocol);
		if (!adapter) return undefined;
		return {
			protocol: deviceRow.protocol,
			adapter,
			endpointDeviceName: endpoint.name,
			logicalIdentifier: deviceRow.identifier ?? undefined,
		};
	}

	for (const [protocol, adapter] of adapterManager.getAllAdapters()) {
		const owns =
			(adapter.ownsDeviceName?.(deviceIdentifier) ?? false) ||
			adapter.getDeviceStatuses().some((status) => status.deviceName === deviceIdentifier);
		if (owns) {
			return { protocol, adapter, endpointDeviceName: deviceIdentifier };
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
 * (OPC-UA: `dataPoints[].writable`, BACnet: `objects[].writable`, both
 * checked inside the client's own write() — Modbus: checked here via the
 * register's `writable` flag since the existing HTTP write endpoint
 * intentionally doesn't gate on it) — this function does not duplicate that
 * logic, only dispatches to it and normalizes the resulting errors.
 */
export async function dispatchWrite(
	adapterManager: AdapterManager,
	deviceIdentifier: string,
	pointName: string,
	value: number | boolean | string,
): Promise<void> {
	const target = await resolveWriteTarget(adapterManager, deviceIdentifier);
	if (!target) {
		throw new CommandError(CommandErrorCode.nodeNotAllowed, `Device not found: ${deviceIdentifier}`);
	}
	const { protocol, adapter, endpointDeviceName, logicalIdentifier } = target;

	try {
		if (protocol === 'modbus' && adapter instanceof ModbusAdapter) {
			const register = adapter.getRegisterConfig(endpointDeviceName, pointName);
			if (!register) {
				throw new Error(`Register not found: ${pointName}`);
			}
			if (!register.writable) {
				throw new CommandError(CommandErrorCode.nodeNotAllowed, `Register is not writable via commands: ${pointName}`);
			}
			await adapter.writeRegister(endpointDeviceName, pointName, value);
			return;
		}

		if (protocol === 'opcua' && adapter instanceof OPCUAAdapter) {
			await adapter.writeNode(endpointDeviceName, pointName, value, logicalIdentifier);
			return;
		}

		if (protocol === 'bacnet' && adapter instanceof BACnetAdapter) {
			await adapter.writeProperty(endpointDeviceName, pointName, value);
			return;
		}

		throw new CommandError(CommandErrorCode.unsupportedCommandType, `Protocol '${protocol}' does not support command writes`);
	} catch (error) {
		if (error instanceof CommandError) {
			throw error;
		}
		throw classifyWriteError(error);
	}
}
