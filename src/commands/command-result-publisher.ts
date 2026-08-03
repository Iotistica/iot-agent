import { CommandDestination } from './command-destination.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';
import type { CommandResult } from './types.js';

/**
 * Publishes exactly one terminal result per command, via whichever
 * destination is flagged use_for_commands (see CommandDestination). Never
 * retained — a result is only meaningful to whoever's waiting on it right
 * now, and a retained result would be replayed to every future subscriber.
 */
export class CommandResultPublisher {
	constructor(
		private readonly resultTopic: string,
		private readonly logger: AgentLogger,
		private readonly deviceUuid: string,
	) {}

	async publish(result: CommandResult): Promise<void> {
		try {
			const client = await CommandDestination.resolve(this.logger, this.deviceUuid);
			if (!client) {
				this.logger.warnSync('Failed to publish command result: no mqtt destination flagged use_for_commands', {
					component: LogComponents.commands,
					commandId: result.commandId,
				});
				return;
			}
			// destinationTopic bypasses the destination's outbound topicTemplate
			// substitution (buildPublishTopic) — that mechanism is for routing
			// regular telemetry, not fixed command-result topics.
			await client.publish(this.resultTopic, JSON.stringify(result), { qos: 1, destinationTopic: this.resultTopic });
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
