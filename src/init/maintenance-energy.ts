import { LogComponents } from '../logging/types.js';
import { DatabaseModel } from '../db/models/index.js';
import { loadMaintenanceEnergy } from '../pro/loader.js';
import { CloudMqttClient } from '../mqtt/manager.js';
import { agentTopic } from '../mqtt/topics.js';
import { PublishDestinationsModel } from '../db/models/publish-destinations.model.js';
import { createExternalMqttClientFromDestination } from '../publish/plugins/mqtt.js';
import type { AgentInitContext } from './context.js';

/**
 * Preventive maintenance / energy recommendations — Pro-only, same gating
 * pattern as initAnomalyDetection() in ./anomaly.ts. Simpler than that init
 * in one respect: rule config lives in Community's own local
 * maintenance_rules/energy_rules tables (not cloud target-state), and
 * recommendations are standing per-asset records, not an incident stream —
 * so there's no correlator equivalent to wire up. Phase 3 publishing DOES
 * reuse the exact same options-bag pattern anomaly uses though (buildTopic,
 * getAlertDestination, createAlertMqttClient) — see MaintenanceEnergyService
 * in iot-agent-pro for the consumer side.
 *
 * No cloud feature-flag gate exists for this yet (unlike
 * features.enableAnomalyDetection) — the service simply starts whenever
 * @iotistica/agent-pro is installed. Add one later if a reason to
 * enable/disable it independently of the Pro license shows up.
 */
export async function initMaintenanceEnergy(ctx: AgentInitContext): Promise<void> {
	if (ctx.maintenanceEnergyService) {
		ctx.agentLogger?.debugSync('Cleaning up existing Maintenance/Energy Service before reinitializing', {
			component: LogComponents.agent,
		});
		ctx.maintenanceEnergyService.stop();
		ctx.maintenanceEnergyService = undefined;
	}

	try {
		const pro = await loadMaintenanceEnergy();
		if (!pro) {
			ctx.agentLogger?.debugSync('Preventive maintenance / energy recommendations skipped — requires Iotistica Pro', {
				component: LogComponents.agent,
			});
			return;
		}

		const dbInstance = DatabaseModel.getConnection();
		const { MaintenanceEnergyService } = pro;
		ctx.maintenanceEnergyService = new MaintenanceEnergyService(dbInstance, {
			logger: ctx.agentLogger,
			mqttManager: CloudMqttClient.getInstance(),
			deviceUuid: ctx.agentInfo!.uuid,
			buildTopic: (deviceUuid: string, ...segments: string[]) => agentTopic(deviceUuid, ...segments),
			getAlertDestination: (id: number) => PublishDestinationsModel.getById(id) ?? null,
			createAlertMqttClient: (config: Record<string, unknown> | null | undefined, deviceId?: string, name?: string, logger?: any) =>
				createExternalMqttClientFromDestination(config, deviceId, name, logger),
		});
		ctx.maintenanceEnergyService.start();

		ctx.agentLogger?.infoSync('Preventive maintenance / energy recommendations initialized', {
			component: LogComponents.agent,
		});
	} catch (error) {
		ctx.agentLogger?.errorSync(
			'Failed to initialize Maintenance/Energy Service',
			error as Error,
			{ component: LogComponents.agent }
		);
		ctx.maintenanceEnergyService = undefined;
	}
}

/**
 * Late-injection: featureContext (and the DevicePublish/PublishManager chain
 * it constructs) is seeded from ctx.maintenanceEnergyService *before*
 * initMaintenanceEnergy() has run — same ordering quirk configureAnomalyFeed()
 * exists to fix for anomalyService. Propagates the now-real service instance
 * into the already-constructed publish pipeline so AnomalyFeed's forwarding
 * call (see feed.ts's dispatchToMaintenanceEnergy) actually has something to
 * call once device data starts flowing.
 */
export function configureMaintenanceEnergyFeed(ctx: AgentInitContext): void {
	if (!ctx.maintenanceEnergyService) return;
	ctx.featureInitializer?.setMaintenanceEnergyService?.(ctx.maintenanceEnergyService);
}
