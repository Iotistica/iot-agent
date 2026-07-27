import { initDatabase } from './database.js';
import { LogComponents } from '../logging/types.js';
import type { AgentInitContext } from './context.js';

export async function initCore(ctx: AgentInitContext): Promise<void> {
	await initDatabase(ctx);
	await initializeStateReconciler(ctx);
	setupConfigEventListeners(ctx);
}

export async function initializeStateReconciler(ctx: AgentInitContext): Promise<void> {
	const { StateManager: StateManager } = await import('../core/state.js');
	ctx.stateReconciler = new StateManager();
	await ctx.stateReconciler.init();
	ctx.configManager = ctx.stateReconciler.getConfigManager();
}

export function setupConfigEventListeners(ctx: AgentInitContext): void {
	ctx.stateReconciler?.on('features-changed', async (change: { old: any; new: any }) => {
		const logger = ctx.agentLogger;
		logger?.infoSync('Features configuration changed', {
			component: LogComponents.agent,
			changes: Object.keys(change.new).filter(key => change.old[key] !== change.new[key])
		});

		if (change.old.enableAnomalyDetection !== change.new.enableAnomalyDetection) {
			if (!ctx.anomalyService) {
				// No instance exists yet at all (only possible if this fires before the
				// `features` init phase has ever run) — bootstrap it fully.
				if (change.new.enableAnomalyDetection) {
					logger?.infoSync('Starting Anomaly Detection Service (dynamically enabled)', {
						component: LogComponents.agent
					});
					const { initAnomalyDetection, configureAnomalyFeed } = await import('./anomaly.js');
					await initAnomalyDetection(ctx);
					await configureAnomalyFeed(ctx);

					// Simulation init runs before target state is available (in features.ts).
					// Now that anomaly detection is up, re-run simulation init so it can
					// attach to the anomaly service correctly.
					if (ctx.anomalyService && !ctx.simulationOrchestrator) {
						const { initSimulationMode } = await import('./simulation.js');
						await initSimulationMode(ctx);
					}
				}
			} else {
				// initAnomalyDetection() always creates an instance, even when the feature
				// starts disabled — it just runs in catalog-only mode (setEnabled(false)).
				// So ctx.anomalyService is essentially never undefined past first boot, and
				// the old `!ctx.anomalyService` check above never fires here again — this
				// toggle used to silently no-op on every enable/disable after the first one.
				// Flip the runtime flag directly instead of tearing the instance down, so the
				// observed-metric catalog and any live buffers survive a disable/re-enable.
				logger?.infoSync(
					`${change.new.enableAnomalyDetection ? 'Enabling' : 'Disabling'} Anomaly Detection Service (dynamically toggled)`,
					{ component: LogComponents.agent }
				);
				ctx.anomalyService.setEnabled(change.new.enableAnomalyDetection);
			}
		}

		if (change.old.enableDevicePublish !== change.new.enableDevicePublish) {
			if (!change.new.enableDevicePublish) {
				logger?.infoSync('Stopping Device Publish Feature (dynamically disabled)', {
					component: LogComponents.agent
				});

				try {
					const devicePublish = ctx.featureInitializer?.getFeatures()?.devicePublish;
					if (devicePublish) {
						await devicePublish.stop();
						ctx.featureInitializer!.getFeatures().devicePublish = undefined;
					}
				} catch (error) {
					logger?.errorSync(
						'Failed to stop Device Publish Feature while disabling',
						error instanceof Error ? error : new Error(String(error)),
						{ component: LogComponents.agent }
					);
				}
			} else {
				logger?.infoSync('Starting Device Publish Feature (dynamically enabled)', {
					component: LogComponents.agent
				});

				try {
					await ctx.featureInitializer?.initDevicePublish();
				} catch (error) {
					logger?.errorSync(
						'Failed to start Device Publish Feature while enabling',
						error instanceof Error ? error : new Error(String(error)),
						{ component: LogComponents.agent }
					);
				}
			}
		}

		if (change.old.enableDeviceRemoteAccess !== change.new.enableDeviceRemoteAccess) {
			if (!change.new.enableDeviceRemoteAccess) {
				logger?.infoSync('Stopping Shell Handler (dynamically disabled)', {
					component: LogComponents.agent
				});

				try {
					const shellHandler = ctx.featureInitializer?.getFeatures()?.shellHandler;
					if (shellHandler) {
						await shellHandler.cleanup();
						ctx.featureInitializer!.getFeatures().shellHandler = undefined;
					}
				} catch (error) {
					logger?.errorSync(
						'Failed to stop Shell Handler while disabling',
						error instanceof Error ? error : new Error(String(error)),
						{ component: LogComponents.agent }
					);
				}
			} else {
				logger?.infoSync('Starting Shell Handler (dynamically enabled)', {
					component: LogComponents.agent
				});

				try {
					await ctx.featureInitializer?.initShellHandler();
				} catch (error) {
					logger?.errorSync(
						'Failed to start Shell Handler while enabling',
						error instanceof Error ? error : new Error(String(error)),
						{ component: LogComponents.agent }
					);
				}
			}
		}
	});

	ctx.stateReconciler?.on('anomaly-config-changed', (change: { old: any; new: any }) => {
		const logger = ctx.agentLogger;
		logger?.infoSync('Anomaly configuration changed from cloud', {
			component: LogComponents.agent
		});

		if (ctx.anomalyService && change.new) {
			logger?.infoSync('Reloading anomaly detection configuration', {
				component: LogComponents.agent,
				metricsCount: change.new.metrics?.filter((m: any) => m.enabled).length
			});
			ctx.anomalyService.updateConfig(change.new);
		}
	});
}
