import { z } from 'zod';

/**
 * Generic device-write command, delivered over MQTT.
 *
 * Deliberately protocol-agnostic: `deviceName` is looked up against whichever
 * adapter (OPC-UA, Modbus, ...) currently owns that device, so producers don't
 * need to know which protocol backs a given device. `pointName` maps to the
 * same per-protocol point identifier already used by each adapter's existing
 * write path (OPC-UA data point `name`/`nodeId`, Modbus register `name`).
 */
export const WriteCommandSchema = z.object({
	version: z.literal(1),
	commandId: z.string().min(1).max(128),
	type: z.literal('device.write'),
	issuedAt: z.string().datetime({ offset: true }),
	expiresAt: z.string().datetime({ offset: true }),
	deviceName: z.string().min(1).max(256),
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
	deviceName?: string;
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
