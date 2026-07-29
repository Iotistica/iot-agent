import { CloudMqttClient } from '../mqtt/manager.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';
import type { CommandService } from './command-service.js';

/**
 * Subscribes to the agent's own command topic and forwards raw messages to
 * CommandService. Deliberately thin — all parsing, validation, dedup, and
 * execution live in CommandService so this class never touches a protocol
 * write directly.
 */
export class MqttCommandConsumer {
	constructor(
		private readonly commandTopic: string,
		private readonly commandService: CommandService,
		private readonly logger: AgentLogger,
	) {}

	async start(): Promise<void> {
		const mqttManager = CloudMqttClient.getInstance();
		await mqttManager.subscribe(this.commandTopic, { qos: 1 }, (_topic, payload, retain) => {
			void this.commandService.handleMessage(payload, retain);
		});

		this.logger.infoSync('MQTT command consumer started', {
			component: LogComponents.commands,
			commandTopic: this.commandTopic,
		});
	}

	async stop(): Promise<void> {
		const mqttManager = CloudMqttClient.getInstance();
		await mqttManager.unsubscribe(this.commandTopic);
	}
}
