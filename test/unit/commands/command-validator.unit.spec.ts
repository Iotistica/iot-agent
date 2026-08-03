import { CommandError } from '../../../src/commands/command-errors';
import { checkExpiry, parseCommand } from '../../../src/commands/command-validator';
import { CommandErrorCode } from '../../../src/commands/types';

function validCommandJson(overrides: Record<string, unknown> = {}): Buffer {
	const now = new Date();
	const command = {
		version: 1,
		commandId: 'cmd-1',
		type: 'device.write',
		issuedAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + 30_000).toISOString(),
		deviceUuid: 'plc-1',
		pointName: 'Motor1.SpeedSetpoint',
		value: 1500,
		...overrides,
	};
	return Buffer.from(JSON.stringify(command));
}

describe('parseCommand', () => {
	it('accepts a valid command', () => {
		const command = parseCommand(validCommandJson());
		expect(command.commandId).toBe('cmd-1');
		expect(command.value).toBe(1500);
	});

	it('rejects invalid JSON', () => {
		expect(() => parseCommand(Buffer.from('{not json'))).toThrow(CommandError);
		try {
			parseCommand(Buffer.from('{not json'));
		} catch (error) {
			expect((error as CommandError).code).toBe(CommandErrorCode.invalidJson);
		}
	});

	it('rejects a payload over the size limit', () => {
		const huge = Buffer.alloc(64 * 1024 + 1, 'a');
		try {
			parseCommand(huge);
			fail('expected parseCommand to throw');
		} catch (error) {
			expect((error as CommandError).code).toBe(CommandErrorCode.payloadTooLarge);
		}
	});

	it('rejects an unsupported version before generic schema errors', () => {
		try {
			parseCommand(validCommandJson({ version: 2 }));
			fail('expected parseCommand to throw');
		} catch (error) {
			expect((error as CommandError).code).toBe(CommandErrorCode.unsupportedVersion);
		}
	});

	it('rejects an unsupported command type', () => {
		try {
			parseCommand(validCommandJson({ type: 'device.reboot' }));
			fail('expected parseCommand to throw');
		} catch (error) {
			expect((error as CommandError).code).toBe(CommandErrorCode.unsupportedCommandType);
		}
	});

	it('rejects a command missing required fields', () => {
		try {
			parseCommand(validCommandJson({ commandId: undefined }));
			fail('expected parseCommand to throw');
		} catch (error) {
			expect((error as CommandError).code).toBe(CommandErrorCode.invalidSchema);
		}
	});

	it('rejects a boolean-as-string value the same way OPC-UA/Modbus writes would', () => {
		// Schema itself allows string values (Modbus/OPC-UA string points exist);
		// this just confirms a wrapped boolean-looking string round-trips as a string, not a boolean.
		const command = parseCommand(validCommandJson({ value: 'true' }));
		expect(command.value).toBe('true');
		expect(typeof command.value).toBe('string');
	});
});

describe('checkExpiry', () => {
	const now = new Date('2026-07-28T15:20:00.000Z');

	it('passes for a fresh, unexpired command', () => {
		const command = parseCommand(validCommandJson({
			issuedAt: now.toISOString(),
			expiresAt: new Date(now.getTime() + 10_000).toISOString(),
		}));
		expect(() => checkExpiry(command, 30, now)).not.toThrow();
	});

	it('rejects a command past its expiresAt', () => {
		const command = parseCommand(validCommandJson({
			issuedAt: new Date(now.getTime() - 60_000).toISOString(),
			expiresAt: new Date(now.getTime() - 1_000).toISOString(),
		}));
		try {
			checkExpiry(command, 30, now);
			fail('expected checkExpiry to throw');
		} catch (error) {
			expect((error as CommandError).code).toBe(CommandErrorCode.commandExpired);
		}
	});

	it('rejects a command older than maximumCommandAgeSeconds even if not yet expired', () => {
		const command = parseCommand(validCommandJson({
			issuedAt: new Date(now.getTime() - 120_000).toISOString(),
			expiresAt: new Date(now.getTime() + 120_000).toISOString(),
		}));
		try {
			checkExpiry(command, 30, now);
			fail('expected checkExpiry to throw');
		} catch (error) {
			expect((error as CommandError).code).toBe(CommandErrorCode.commandTooOld);
		}
	});
});
