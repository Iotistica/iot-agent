import { PublishDestinationsModel } from '../db/models/publish-destinations.model.js';
import { createExternalMqttClientFromDestination, type ExternalMqttClient } from '../publish/plugins/mqtt.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';

/**
 * Resolves and caches the single MQTT client the device-write command
 * feature uses — built from whichever publish destination an admin has
 * flagged `use_for_commands` (PublishDestinationsModel.getCommandDestination()),
 * reusing the exact same config_json parsing (createExternalMqttClientFromDestination)
 * outbound publish destinations already use.
 *
 * Destinations were previously outbound-publish-only. This repurposes one
 * as the inbound command transport too, instead of the command feature
 * requiring cloud provisioning (CloudMqttClient only connects once
 * provisioned — see src/init/infra.ts) or inventing its own separate,
 * hardcoded connection. See GitHub issues #4/#5/#6.
 */
export class CommandDestination {
	private static cachedClient: ExternalMqttClient | null = null;
	private static cachedDestinationId: number | null = null;
	private static cachedConfigJson: string | null = null;

	/** Returns a connected client for the currently-flagged command destination, or null if none is configured/enabled/valid. */
	static async resolve(logger: AgentLogger, deviceUuid: string): Promise<ExternalMqttClient | null> {
		const destination = PublishDestinationsModel.getCommandDestination();
		if (!destination) {
			await this.reset();
			return null;
		}

		if (destination.type !== 'mqtt') {
			logger.warnSync(
				`Destination '${destination.name}' is flagged use_for_commands but is type '${destination.type}', not 'mqtt' — commands require an mqtt destination`,
				{ component: LogComponents.commands },
			);
			await this.reset();
			return null;
		}

		const configJson = JSON.stringify(destination.config_json ?? null);
		if (this.cachedClient && this.cachedDestinationId === destination.id && this.cachedConfigJson === configJson) {
			return this.cachedClient;
		}

		// First resolve, or the destination's config changed since the cached
		// client was built — tear down the stale connection before rebuilding.
		await this.reset();

		const client = createExternalMqttClientFromDestination(destination.config_json, deviceUuid, 'commands', logger);
		if (!client) {
			logger.warnSync(`Command destination '${destination.name}' has invalid/missing MQTT config`, {
				component: LogComponents.commands,
			});
			return null;
		}

		await client.connect();
		this.cachedClient = client;
		this.cachedDestinationId = destination.id ?? null;
		this.cachedConfigJson = configJson;
		return client;
	}

	/** Test-only: clears the cached client so a fresh one is resolved on next use. */
	static async resetForTests(): Promise<void> {
		await this.reset();
	}

	private static async reset(): Promise<void> {
		if (this.cachedClient) {
			await this.cachedClient.disconnect().catch(() => {});
		}
		this.cachedClient = null;
		this.cachedDestinationId = null;
		this.cachedConfigJson = null;
	}
}
