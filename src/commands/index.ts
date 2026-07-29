import { getAdapterManager as getAdapterManagerFromActions } from '../api/actions.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';
import { agentTopic } from '../mqtt/topics.js';
import { CommandDeduplicator } from './command-deduplicator.js';
import { CommandResultPublisher } from './command-result-publisher.js';
import { CommandService } from './command-service.js';
import { MqttCommandConsumer } from './mqtt-command-consumer.js';
import type { CommandServiceConfig } from './types.js';

export { CommandService } from './command-service.js';
export { CommandDeduplicator } from './command-deduplicator.js';
export { CommandResultPublisher } from './command-result-publisher.js';
export { MqttCommandConsumer } from './mqtt-command-consumer.js';
export { CommandError } from './command-errors.js';
export * from './types.js';

function readConfigFromEnv(): CommandServiceConfig {
	return {
		enabled: process.env.COMMANDS_ENABLED === 'true',
		maximumCommandAgeSeconds: Number(process.env.COMMANDS_MAX_AGE_SECONDS ?? 30),
		maximumQueueSize: Number(process.env.COMMANDS_QUEUE_SIZE ?? 1000),
		writeTimeoutMs: Number(process.env.COMMANDS_WRITE_TIMEOUT_MS ?? 5000),
		dedupTtlMs: Number(process.env.COMMANDS_DEDUP_TTL_SECONDS ?? 300) * 1000,
	};
}

export interface CommandFeature {
	start(): Promise<void>;
	stop(): Promise<void>;
}

/**
 * Builds the MQTT device-write command feature. Disabled by default
 * (COMMANDS_ENABLED unset or not "true") — when disabled, start() is a no-op
 * that never subscribes to MQTT or touches any protocol adapter.
 */
export function createCommandFeature(logger: AgentLogger, deviceUuid: string): CommandFeature {
	const config = readConfigFromEnv();

	if (!config.enabled) {
		return {
			async start() {
				logger.debugSync('Command feature disabled (COMMANDS_ENABLED not set)', {
					component: LogComponents.commands,
				});
			},
			async stop() {},
		};
	}

	const commandTopic = agentTopic(deviceUuid, 'cmd', 'write');
	const resultTopic = agentTopic(deviceUuid, 'cmd', 'result');

	const deduplicator = new CommandDeduplicator(config.dedupTtlMs);
	const resultPublisher = new CommandResultPublisher(resultTopic, logger);

	// Resolved lazily (per-call) since AdapterManager isn't constructed until
	// the device-features init phase, which can run after this feature starts.
	const commandService = new CommandService(logger, getAdapterManagerFromActions, deduplicator, resultPublisher, config);
	const consumer = new MqttCommandConsumer(commandTopic, commandService, logger);

	return {
		start: () => consumer.start(),
		stop: () => consumer.stop(),
	};
}
