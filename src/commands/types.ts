import { z } from 'zod';

/**
 * Generic device-write command, delivered over MQTT.
 *
 * Deliberately protocol-agnostic: `deviceUuid` is resolved against whichever
 * adapter (OPC-UA, Modbus, ...) currently owns that device, so producers don't
 * need to know which protocol backs a given device. Prefer the `devices`
 * table's own unique `uuid` (shown — with a copy button — in the admin UI's
 * Devices grid, used by PATCH/DELETE /v1/devices/:uuid) — unambiguous even
 * when two physically different devices share a display name (e.g. "AHU-1"
 * configured identically on two different OPC-UA servers). A raw configured
 * endpoint name, or (OPC-UA only) a friendly per-tag device name, also works
 * as a best-effort fallback — see write-dispatcher.ts's resolveWriteTarget().
 * `pointName` matches whatever name a user would actually see for that point —
 * not just discovery's internal sanitized identifier — so producers never
 * need to learn a lowercasing/underscore convention: OPC-UA accepts the data
 * point's `name`, raw `nodeId`, or unmodified `browseName`; BACnet accepts the
 * sanitized `name` or the device's own raw `objectName` (e.g. "AHU-1.SF-Run");
 * Modbus register `name` (user-configured directly, no separate raw form).
 */
export const WriteCommandSchema = z.object({
	version: z.literal(1),
	commandId: z.string().min(1).max(128),
	type: z.literal('device.write'),
	issuedAt: z.string().datetime({ offset: true }),
	expiresAt: z.string().datetime({ offset: true }),
	deviceUuid: z.string().min(1).max(256),
	pointName: z.string().min(1).max(256),
	value: z.union([z.number(), z.boolean(), z.string().max(4096)]),
});

export type WriteCommand = z.infer<typeof WriteCommandSchema>;

export type CommandResultStatus = 'succeeded' | 'failed' | 'rejected' | 'duplicate' | 'expired';

export const CommandErrorCode = {
	invalidJson: 'INVALID_JSON',
	invalidSchema: 'INVALID_SCHEMA',
	unsupportedVersion: 'UNSUPPORTED_VERSION',
	unsupportedCommandType: 'UNSUPPORTED_COMMAND_TYPE',
	commandExpired: 'COMMAND_EXPIRED',
	commandTooOld: 'COMMAND_TOO_OLD',
	duplicateCommand: 'DUPLICATE_COMMAND',
	nodeNotAllowed: 'NODE_NOT_ALLOWED',
	deviceNotConnected: 'DEVICE_NOT_CONNECTED',
	writeRejected: 'WRITE_REJECTED',
	writeTimeout: 'WRITE_TIMEOUT',
	retainedCommandRejected: 'RETAINED_COMMAND_REJECTED',
	payloadTooLarge: 'PAYLOAD_TOO_LARGE',
	queueFull: 'COMMAND_QUEUE_FULL',
	internalError: 'INTERNAL_ERROR',
} as const;

export type CommandErrorCode = typeof CommandErrorCode[keyof typeof CommandErrorCode];

export interface CommandResult {
	version: 1;
	commandId: string;
	type: 'device.write.result';
	status: CommandResultStatus;
	deviceUuid?: string;
	pointName?: string;
	requestedValue?: number | boolean | string;
	error?: {
		code: CommandErrorCode;
		message: string;
	};
	receivedAt: string;
	completedAt: string;
}

export interface CommandServiceConfig {
	enabled: boolean;
	maximumCommandAgeSeconds: number;
	maximumQueueSize: number;
	writeTimeoutMs: number;
	dedupTtlMs: number;
}
