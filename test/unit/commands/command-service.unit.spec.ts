jest.mock('../../../src/commands/write-dispatcher');

import { CommandService } from '../../../src/commands/command-service';
import { CommandDeduplicator } from '../../../src/commands/command-deduplicator';
import { CommandResultPublisher } from '../../../src/commands/command-result-publisher';
import { CommandError } from '../../../src/commands/command-errors';
import { CommandErrorCode, type CommandServiceConfig } from '../../../src/commands/types';
import { dispatchWrite } from '../../../src/commands/write-dispatcher';

const mockDispatchWrite = dispatchWrite as jest.MockedFunction<typeof dispatchWrite>;

function makeLogger() {
	return {
		infoSync: jest.fn(),
		warnSync: jest.fn(),
		errorSync: jest.fn(),
		debugSync: jest.fn(),
	} as any;
}

function makeConfig(overrides: Partial<CommandServiceConfig> = {}): CommandServiceConfig {
	return {
		enabled: true,
		maximumCommandAgeSeconds: 30,
		maximumQueueSize: 5,
		writeTimeoutMs: 200,
		dedupTtlMs: 60_000,
		...overrides,
	};
}

function validCommandBuffer(overrides: Record<string, unknown> = {}): Buffer {
	const now = new Date();
	return Buffer.from(JSON.stringify({
		version: 1,
		commandId: 'cmd-1',
		type: 'device.write',
		issuedAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + 30_000).toISOString(),
		deviceName: 'plc-1',
		pointName: 'speed',
		value: 100,
		...overrides,
	}));
}

describe('CommandService', () => {
	let publisher: { publish: jest.Mock };
	let logger: ReturnType<typeof makeLogger>;
	let service: CommandService;

	beforeEach(() => {
		mockDispatchWrite.mockReset();
		publisher = { publish: jest.fn().mockResolvedValue(undefined) };
		logger = makeLogger();
		const dedup = new CommandDeduplicator(60_000);
		service = new CommandService(
			logger,
			() => ({} as any),
			dedup,
			publisher as unknown as CommandResultPublisher,
			makeConfig(),
		);
	});

	it('rejects retained messages without publishing a result (no commandId trusted from a retained message)', async () => {
		await service.handleMessage(validCommandBuffer(), true);
		expect(publisher.publish).not.toHaveBeenCalled();
		expect(mockDispatchWrite).not.toHaveBeenCalled();
	});

	it('publishes a rejected result when JSON is valid but fails schema validation, recovering the commandId', async () => {
		// Valid JSON, but missing required fields (deviceName/pointName/value) — parseCommand
		// throws INVALID_SCHEMA, and unlike a JSON syntax error, the commandId is still recoverable.
		const schemaInvalid = Buffer.from(JSON.stringify({ version: 1, commandId: 'cmd-x', type: 'device.write' }));
		await service.handleMessage(schemaInvalid, false);
		expect(publisher.publish).toHaveBeenCalledWith(expect.objectContaining({ commandId: 'cmd-x', status: 'rejected' }));
	});

	it('drops a syntactically invalid JSON payload silently — no commandId can ever be recovered from it', async () => {
		const malformed = Buffer.from('{"commandId":"cmd-x", not json');
		await service.handleMessage(malformed, false);
		expect(publisher.publish).not.toHaveBeenCalled();
	});

	it('executes a valid command exactly once and publishes a succeeded result', async () => {
		mockDispatchWrite.mockResolvedValue(undefined);

		await service.handleMessage(validCommandBuffer(), false);
		// drainQueue runs fire-and-forget; wait a tick for it to settle.
		await new Promise((resolve) => setImmediate(resolve));

		expect(mockDispatchWrite).toHaveBeenCalledTimes(1);
		expect(mockDispatchWrite).toHaveBeenCalledWith(expect.anything(), 'plc-1', 'speed', 100);
		expect(publisher.publish).toHaveBeenCalledWith(expect.objectContaining({ commandId: 'cmd-1', status: 'succeeded' }));
	});

	it('does not execute a duplicate commandId a second time', async () => {
		mockDispatchWrite.mockResolvedValue(undefined);

		await service.handleMessage(validCommandBuffer(), false);
		await new Promise((resolve) => setImmediate(resolve));
		await service.handleMessage(validCommandBuffer(), false); // same commandId again

		expect(mockDispatchWrite).toHaveBeenCalledTimes(1);
		// Second delivery republishes the stored result rather than executing again.
		expect(publisher.publish).toHaveBeenCalledWith(expect.objectContaining({ commandId: 'cmd-1', status: 'succeeded' }));
	});

	it('publishes a failed result when dispatchWrite rejects, and records the error code', async () => {
		mockDispatchWrite.mockRejectedValue(new CommandError(CommandErrorCode.nodeNotAllowed, 'Node is not writable'));

		await service.handleMessage(validCommandBuffer({ commandId: 'cmd-2' }), false);
		await new Promise((resolve) => setImmediate(resolve));

		expect(publisher.publish).toHaveBeenCalledWith(expect.objectContaining({
			commandId: 'cmd-2',
			status: 'failed',
			error: expect.objectContaining({ code: CommandErrorCode.nodeNotAllowed }),
		}));
	});

	it('publishes an expired result for a command already past expiresAt, without ever dispatching a write', async () => {
		const now = new Date();
		const expired = validCommandBuffer({
			commandId: 'cmd-3',
			issuedAt: new Date(now.getTime() - 60_000).toISOString(),
			expiresAt: new Date(now.getTime() - 1_000).toISOString(),
		});

		await service.handleMessage(expired, false);

		expect(mockDispatchWrite).not.toHaveBeenCalled();
		expect(publisher.publish).toHaveBeenCalledWith(expect.objectContaining({ commandId: 'cmd-3', status: 'expired' }));
	});

	it('rejects a command once the queue is full', async () => {
		// Never resolves, so the queue backs up behind the first command.
		mockDispatchWrite.mockImplementation(() => new Promise(() => {}));

		const config = makeConfig({ maximumQueueSize: 1 });
		const dedup = new CommandDeduplicator(60_000);
		const fullQueuePublisher = { publish: jest.fn().mockResolvedValue(undefined) };
		const fullQueueService = new CommandService(logger, () => ({} as any), dedup, fullQueuePublisher as any, config);

		await fullQueueService.handleMessage(validCommandBuffer({ commandId: 'cmd-a' }), false); // starts processing, queue empty
		await fullQueueService.handleMessage(validCommandBuffer({ commandId: 'cmd-b' }), false); // fills the 1-slot queue
		await fullQueueService.handleMessage(validCommandBuffer({ commandId: 'cmd-c' }), false); // queue full -> rejected

		expect(fullQueuePublisher.publish).toHaveBeenCalledWith(expect.objectContaining({
			commandId: 'cmd-c',
			status: 'rejected',
			error: expect.objectContaining({ code: CommandErrorCode.queueFull }),
		}));
	});

	it('publishes a failed result with WRITE_TIMEOUT when the write exceeds writeTimeoutMs', async () => {
		mockDispatchWrite.mockImplementation(() => new Promise((resolve) => {
			// Long enough to always lose the race against writeTimeoutMs (200ms), but
			// unref'd so this dangling timer can't keep the Jest worker process alive.
			setTimeout(resolve, 5000).unref?.();
		}));

		await service.handleMessage(validCommandBuffer({ commandId: 'cmd-timeout' }), false);
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(publisher.publish).toHaveBeenCalledWith(expect.objectContaining({
			commandId: 'cmd-timeout',
			status: 'failed',
			error: expect.objectContaining({ code: CommandErrorCode.writeTimeout }),
		}));
	}, 10000);
});
