import { CommandDestination } from './command-destination.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';
import type { CommandService } from './command-service.js';

/**
 * Subscribes to the agent's own command topic (on whichever publish
 * destination an admin has flagged `use_for_commands` — see
 * CommandDestination) and forwards raw messages to CommandService.
 * Deliberately thin — all parsing, validation, dedup, and execution live in
 * CommandService so this class never touches a protocol write directly.
 */
export class MqttCommandConsumer {
	constructor(
		private readonly commandTopic: string,
		private readonly commandService: CommandService,
		private readonly logger: AgentLogger,
		private readonly deviceUuid: string,
	) {}

	async start(): Promise<void> {
		const client = await CommandDestination.resolve(this.logger, this.deviceUuid);
		if (!client) {
			this.logger.warnSync('No mqtt destination flagged use_for_commands — command consumer not started', {
				component: LogComponents.commands,
			});
			return;
		}

		await client.subscribe(this.commandTopic, 1, (_topic, payload, retain) => {
			void this.commandService.handleMessage(payload, retain);
		});

		this.logger.infoSync('MQTT command consumer started', {
			component: LogComponents.commands,
			commandTopic: this.commandTopic,
		});
	}

	async stop(): Promise<void> {
		const client = await CommandDestination.resolve(this.logger, this.deviceUuid);
		await client?.unsubscribe(this.commandTopic);
	}
}
