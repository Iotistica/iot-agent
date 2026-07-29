import { CloudMqttClient, createJsonPayload } from '../mqtt/manager.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';
import type { CommandResult } from './types.js';

/**
 * Publishes exactly one terminal result per command. Never retained — a
 * result is only meaningful to whoever's waiting on it right now, and a
 * retained result would be replayed to every future subscriber.
 */
export class CommandResultPublisher {
	constructor(
		private readonly resultTopic: string,
		private readonly logger: AgentLogger,
	) {}

	async publish(result: CommandResult): Promise<void> {
		try {
			const mqttManager = CloudMqttClient.getInstance();
			await mqttManager.publish(this.resultTopic, createJsonPayload(result), { qos: 1, retain: false });
		} catch (error) {
			// A failed acknowledgement must not trigger a retry of the write itself —
			// the write already happened (or was already rejected); only the
			// notification failed to reach whoever is listening.
			this.logger.errorSync('Failed to publish command result', error instanceof Error ? error : new Error(String(error)), {
				component: LogComponents.commands,
				commandId: result.commandId,
				status: result.status,
			});
		}
	}
}
