import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';
import type { AdapterManager } from '../plugins/index.js';
import { CommandError } from './command-errors.js';
import type { CommandDeduplicator } from './command-deduplicator.js';
import type { CommandResultPublisher } from './command-result-publisher.js';
import { checkExpiry, parseCommand } from './command-validator.js';
import { CommandErrorCode, type CommandResult, type CommandServiceConfig, type WriteCommand } from './types.js';
import { dispatchWrite } from './write-dispatcher.js';

/**
 * Validates, deduplicates, queues, and executes inbound device-write
 * commands. Writes are processed sequentially per agent (not per device) to
 * keep the first implementation simple to reason about and audit; this can
 * be split into per-device queues later if sequential throughput becomes a
 * bottleneck.
 */
export class CommandService {
	private queue: WriteCommand[] = [];
	private processing = false;

	constructor(
		private readonly logger: AgentLogger,
		private readonly getAdapterManager: () => AdapterManager | undefined,
		private readonly deduplicator: CommandDeduplicator,
		private readonly resultPublisher: CommandResultPublisher,
		private readonly config: CommandServiceConfig,
	) {}

	/** Entry point for the MQTT command consumer. Never throws — every failure resolves to a published result or a logged drop. */
	async handleMessage(payload: Buffer, retain: boolean): Promise<void> {
		const receivedAt = new Date();

		if (retain) {
			this.logger.warnSync('Rejected retained MQTT command', {
				component: LogComponents.commands,
			});
			return; // No commandId available yet — nothing to publish a result against.
		}

		let command: WriteCommand;
		try {
			command = parseCommand(payload);
		} catch (error) {
			const commandId = tryExtractCommandId(payload);
			this.logger.warnSync('Rejected malformed command', {
				component: LogComponents.commands,
				error: error instanceof Error ? error.message : String(error),
			});
			if (commandId) {
				await this.publishResult(commandId, 'rejected', receivedAt, undefined, undefined, undefined, error);
			}
			return;
		}

		const existing = this.deduplicator.get(command.commandId);
		if (existing) {
			if (existing.result) {
				this.logger.infoSync('Duplicate command — republishing stored result', {
					component: LogComponents.commands,
					commandId: command.commandId,
				});
				await this.resultPublisher.publish(existing.result);
			} else {
				this.logger.infoSync('Duplicate command received while original is still in flight — dropping', {
					component: LogComponents.commands,
					commandId: command.commandId,
				});
			}
			return;
		}

		try {
			checkExpiry(command, this.config.maximumCommandAgeSeconds, receivedAt);
		} catch (error) {
			this.deduplicator.markInProgress(command.commandId);
			await this.publishResult(command.commandId, 'expired', receivedAt, command.deviceUuid, command.pointName, command.value, error);
			return;
		}

		if (this.queue.length >= this.config.maximumQueueSize) {
			await this.publishResult(
				command.commandId,
				'rejected',
				receivedAt,
				command.deviceUuid,
				command.pointName,
				command.value,
				new CommandError(CommandErrorCode.queueFull, `Command queue is full (max ${this.config.maximumQueueSize})`),
			);
			return;
		}

		this.deduplicator.markInProgress(command.commandId);
		this.queue.push(command);
		void this.drainQueue();
	}

	private async drainQueue(): Promise<void> {
		if (this.processing) return;
		this.processing = true;
		try {
			while (this.queue.length > 0) {
				const command = this.queue.shift()!;
				await this.executeCommand(command);
			}
		} finally {
			this.processing = false;
		}
	}

	private async executeCommand(command: WriteCommand): Promise<void> {
		const receivedAt = new Date();

		try {
			// Re-check immediately before writing: the command may have expired
			// while sitting in the queue (e.g. during a long OPC-UA outage).
			checkExpiry(command, this.config.maximumCommandAgeSeconds);

			const adapterManager = this.getAdapterManager();
			if (!adapterManager) {
				throw new CommandError(CommandErrorCode.deviceNotConnected, 'No protocol adapters are running');
			}

			await withTimeout(
				dispatchWrite(adapterManager, command.deviceUuid, command.pointName, command.value),
				this.config.writeTimeoutMs,
				() => new CommandError(CommandErrorCode.writeTimeout, `Write timed out after ${this.config.writeTimeoutMs}ms — final device state is unknown`),
			);

			await this.publishResult(command.commandId, 'succeeded', receivedAt, command.deviceUuid, command.pointName, command.value);
		} catch (error) {
			const status = error instanceof CommandError && error.code === CommandErrorCode.commandExpired ? 'expired' : 'failed';
			await this.publishResult(command.commandId, status, receivedAt, command.deviceUuid, command.pointName, command.value, error);
		}
	}

	private async publishResult(
		commandId: string,
		status: CommandResult['status'],
		receivedAt: Date,
		deviceUuid?: string,
		pointName?: string,
		requestedValue?: number | boolean | string,
		error?: unknown,
	): Promise<void> {
		const result: CommandResult = {
			version: 1,
			commandId,
			type: 'device.write.result',
			status,
			deviceUuid,
			pointName,
			requestedValue,
			receivedAt: receivedAt.toISOString(),
			completedAt: new Date().toISOString(),
			...(error ? {
				error: {
					code: error instanceof CommandError ? error.code : CommandErrorCode.internalError,
					message: error instanceof Error ? error.message : String(error),
				},
			} : {}),
		};

		this.deduplicator.recordResult(commandId, result);
		await this.resultPublisher.publish(result);

		this.logger.infoSync(`Command ${status}`, {
			component: LogComponents.commands,
			commandId,
			deviceUuid,
			pointName,
			status,
			durationMs: new Date(result.completedAt).getTime() - receivedAt.getTime(),
			...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
		});
	}
}

/** Best-effort extraction of a commandId from an otherwise-invalid payload, so a result can still be published against it. */
function tryExtractCommandId(payload: Buffer): string | undefined {
	try {
		const parsed = JSON.parse(payload.toString('utf8'));
		if (parsed && typeof parsed === 'object' && typeof parsed.commandId === 'string') {
			return parsed.commandId;
		}
	} catch {
		// Not JSON at all — no commandId to recover.
	}
	return undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
	let timer: NodeJS.Timeout;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(onTimeout()), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer!);
	}
}
