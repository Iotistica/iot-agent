import { CommandError } from './command-errors.js';
import { CommandErrorCode, WriteCommandSchema, type WriteCommand } from './types.js';

const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Parses and schema-validates a raw MQTT command payload.
 * Throws CommandError with a stable code for every rejection reason.
 */
export function parseCommand(payload: Buffer): WriteCommand {
	if (payload.length > MAX_PAYLOAD_BYTES) {
		throw new CommandError(CommandErrorCode.payloadTooLarge, `Command payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
	}

	let raw: unknown;
	try {
		raw = JSON.parse(payload.toString('utf8'));
	} catch (error) {
		throw new CommandError(CommandErrorCode.invalidJson, `Command payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (raw && typeof raw === 'object' && 'version' in raw && (raw as { version?: unknown }).version !== 1) {
		throw new CommandError(CommandErrorCode.unsupportedVersion, `Unsupported command version: ${(raw as { version?: unknown }).version}`);
	}

	if (raw && typeof raw === 'object' && 'type' in raw && (raw as { type?: unknown }).type !== 'device.write') {
		throw new CommandError(CommandErrorCode.unsupportedCommandType, `Unsupported command type: ${(raw as { type?: unknown }).type}`);
	}

	const result = WriteCommandSchema.safeParse(raw);
	if (!result.success) {
		throw new CommandError(CommandErrorCode.invalidSchema, `Command failed schema validation: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
	}

	return result.data;
}

/**
 * Re-checked twice: once on receipt (here) and again immediately before the
 * write executes, since a command can sit in the queue long enough to expire
 * between the two checks.
 */
export function checkExpiry(command: WriteCommand, maximumCommandAgeSeconds: number, now: Date = new Date()): void {
	const issuedAt = new Date(command.issuedAt);
	const expiresAt = new Date(command.expiresAt);

	if (now.getTime() > expiresAt.getTime()) {
		throw new CommandError(CommandErrorCode.commandExpired, `Command expired at ${command.expiresAt}`);
	}

	const ageSeconds = (now.getTime() - issuedAt.getTime()) / 1000;
	if (ageSeconds > maximumCommandAgeSeconds) {
		throw new CommandError(CommandErrorCode.commandTooOld, `Command issued ${ageSeconds.toFixed(1)}s ago exceeds maximum age of ${maximumCommandAgeSeconds}s`);
	}
}
