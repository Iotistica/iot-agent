import type { AppStep, ContainerService } from './container-manager';
import type { RetryManager } from './retry-manager';
import type { HealthCheckManager } from './health-check-manager';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import { ensureSocketDestination, removeSocketDestination } from './socket-destination-lifecycle';

interface StepExecutorContext {
	retryManager: RetryManager;
	healthCheckManager: HealthCheckManager;
	logger?: AgentLogger;
	getServiceFromCurrentState: (
		appId: number,
		serviceId: number,
	) => ContainerService | undefined;
	markServiceAsError: (
		appId: number,
		serviceIdOrImage: number | string,
		errorType:
			| 'ImagePullBackOff'
			| 'ErrImagePull'
			| 'StartFailure'
			| 'CrashLoopBackOff',
		message: string,
	) => void;
	updateServiceState: (
		appId: number,
		serviceId: number,
		state: 'running' | 'stopped' | 'paused',
	) => void;
	markServiceAsRunning: (appId: number, serviceId: number) => void;
	addServiceToCurrentState: (
		appId: number,
		service: ContainerService,
		containerId: string,
	) => void;
	removeServiceFromCurrentState: (appId: number, serviceId: number) => void;
	downloadImage: (imageName: string) => Promise<void>;
	createNetwork: (appId: number, networkName: string) => Promise<void>;
	stopContainer: (containerId: string) => Promise<void>;
	pauseContainer: (containerId: string) => Promise<void>;
	unpauseContainer: (containerId: string) => Promise<void>;
	removeContainer: (containerId: string) => Promise<void>;
	startContainer: (service: ContainerService) => Promise<string>;
	attachLogsToContainer: (
		containerId: string,
		service: ContainerService,
	) => Promise<void>;
	startHealthMonitoring: (
		containerId: string,
		service: ContainerService,
	) => void;
	removeNetwork: (appId: number, networkName: string) => Promise<void>;
	createVolume: (appId: number, volumeName: string) => Promise<void>;
	removeVolume: (appId: number, volumeName: string) => Promise<void>;
	reloadPublishBindings?: () => void;
}

export function getStepKey(step: AppStep): string {
	switch (step.action) {
		case 'downloadImage':
			return `image:${step.imageName}`;
		case 'startContainer':
			return `service:${step.appId}:${step.service.serviceId}`;
		case 'stopContainer':
		case 'pauseContainer':
		case 'unpauseContainer':
		case 'startStoppedContainer':
		case 'removeContainer':
			return `service:${step.appId}:${step.serviceId}`;
		case 'createVolume':
			return `volume:${step.appId}:${step.volumeName}`;
		case 'removeVolume':
			return `volume:${step.appId}:${step.volumeName}`;
		case 'createNetwork':
			return `network:${step.appId}:${step.networkName}`;
		case 'removeNetwork':
			return `network:${step.appId}:${step.networkName}`;
		case 'noop':
			return 'noop';
		default: {
			const exhaustiveCheck: never = step;
			return `unknown:${(exhaustiveCheck as { action: string }).action}`;
		}
	}
}

const STABLE_UPTIME_MS = 5 * 60 * 1000;
const lastRestartAt = new Map<string, number>();
const lastConfigFingerprint = new Map<string, string>();

/** A changed deployment config (e.g. new security exceptions) deserves a fresh retry budget. */
function resetRetriesOnConfigChange(
	ctx: StepExecutorContext,
	stepKey: string,
	service: ContainerService,
): void {
	const fingerprint = JSON.stringify([service.imageName, service.config]);
	const previous = lastConfigFingerprint.get(stepKey);
	if (previous !== undefined && previous !== fingerprint) {
		ctx.retryManager.clearState(stepKey);
	}
	lastConfigFingerprint.set(stepKey, fingerprint);
}

/**
 * Bounded restart gate shared by create and restart paths. Throws while in backoff
 * or once the terminal (CrashLoopBackOff) state is reached.
 */
function assertRestartAllowed(
	ctx: StepExecutorContext,
	stepKey: string,
	appId: number,
	serviceId: number,
): void {
	if (ctx.retryManager.shouldRetry(stepKey)) {
		return;
	}
	const state = ctx.retryManager.getState(stepKey);
	if (ctx.retryManager.isTerminal(stepKey)) {
		ctx.markServiceAsError(
			appId,
			serviceId,
			'CrashLoopBackOff',
			`Giving up after ${state?.count ?? 0} failed start attempts: ${state?.lastError ?? 'unknown error'}`,
		);
		throw new Error(`Max start retries exceeded for service ${serviceId}`);
	}
	throw new Error(
		`Service ${serviceId} start is in backoff until ${state?.nextRetry?.toISOString() ?? 'later'}`,
	);
}

function recordStartFailure(
	ctx: StepExecutorContext,
	stepKey: string,
	appId: number,
	serviceId: number,
	error: any,
): void {
	const message = error?.message ?? String(error);
	ctx.retryManager.recordFailure(stepKey, message, error?.retryable === false ? false : undefined);
	const terminal = ctx.retryManager.isTerminal(stepKey);
	ctx.markServiceAsError(appId, serviceId, terminal ? 'CrashLoopBackOff' : 'StartFailure', message);
}

export async function executeStep(
	step: AppStep,
	ctx: StepExecutorContext,
): Promise<void> {
	const stepKey = getStepKey(step);

	switch (step.action) {
		case 'downloadImage': {
			if (!ctx.retryManager.shouldRetry(stepKey)) {
				ctx.logger?.warnSync('Skipping image - max retries exceeded', {
					component: LogComponents.containerManager,
					operation: 'executeStep',
					imageName: step.imageName,
				});
				ctx.markServiceAsError(
					step.appId,
					step.imageName,
					'ImagePullBackOff',
					'Max retries exceeded',
				);
				throw new Error(`Max retries exceeded for ${step.imageName}`);
			}

			try {
				await ctx.downloadImage(step.imageName);
				ctx.retryManager.recordSuccess(stepKey);
			} catch (error: any) {
				ctx.logger?.errorSync(
					'Failed to pull image',
					error instanceof Error ? error : new Error(String(error)),
					{
						component: LogComponents.containerManager,
						operation: 'executeStep',
						imageName: step.imageName,
					},
				);
				ctx.retryManager.recordFailure(stepKey, error.message);
				ctx.markServiceAsError(
					step.appId,
					step.imageName,
					'ImagePullBackOff',
					error.message,
				);
				throw error;
			}
			break;
		}

		case 'createNetwork':
			await ctx.createNetwork(step.appId, step.networkName);
			break;

		case 'stopContainer':
			await ctx.stopContainer(step.containerId);
			ctx.updateServiceState(step.appId, step.serviceId, 'stopped');
			ctx.healthCheckManager.stopMonitoring(step.containerId);
			break;

		case 'pauseContainer':
			await ctx.pauseContainer(step.containerId);
			ctx.updateServiceState(step.appId, step.serviceId, 'paused');
			ctx.logger?.infoSync('Container paused', {
				component: LogComponents.containerManager,
				operation: 'executeStep',
				containerId: step.containerId,
				appId: step.appId,
				serviceId: step.serviceId,
			});
			break;

		case 'unpauseContainer':
			await ctx.unpauseContainer(step.containerId);
			ctx.updateServiceState(step.appId, step.serviceId, 'running');
			ctx.logger?.infoSync('Container unpaused', {
				component: LogComponents.containerManager,
				operation: 'executeStep',
				containerId: step.containerId,
				appId: step.appId,
				serviceId: step.serviceId,
			});
			break;

		case 'startStoppedContainer': {
			ctx.logger?.infoSync('Restarting stopped container (remove + recreate)', {
				component: LogComponents.containerManager,
				operation: 'executeStep',
				containerId: step.containerId,
				appId: step.appId,
				serviceId: step.serviceId,
			});

			const restartKey = getStepKey(step);
			const now = Date.now();
			if (now - (lastRestartAt.get(restartKey) ?? now) >= STABLE_UPTIME_MS) {
				ctx.retryManager.clearState(restartKey);
			}
			assertRestartAllowed(ctx, restartKey, step.appId, step.serviceId);
			lastRestartAt.set(restartKey, now);
			// Count every restart of an exited container; a stable run resets the counter above.
			ctx.retryManager.recordFailure(restartKey, 'Container exited; restarting', true);

			try {
				const service = ctx.getServiceFromCurrentState(step.appId, step.serviceId);
				if (!service) {
					throw new Error(`Service ${step.serviceId} not found in current state`);
				}

				ctx.healthCheckManager.stopMonitoring(step.containerId);
				await ctx.removeContainer(step.containerId);
				ctx.removeServiceFromCurrentState(step.appId, step.serviceId);

				const newContainerId = await ctx.startContainer(service);
				ctx.addServiceToCurrentState(step.appId, service, newContainerId);
				ctx.markServiceAsRunning(step.appId, step.serviceId);
				await ctx.attachLogsToContainer(newContainerId, service);
				ctx.startHealthMonitoring(newContainerId, service);

				if (service.config.enableSocketDestination) {
					try {
						ensureSocketDestination(service, ctx.logger);
						ctx.reloadPublishBindings?.();
					} catch (destErr: any) {
						ctx.logger?.warnSync('Failed to ensure socket destination', {
							component: LogComponents.containerManager,
							operation: 'executeStep',
							serviceName: service.serviceName,
							error: destErr instanceof Error ? destErr.message : String(destErr),
						});
					}
				}

				ctx.logger?.infoSync('Stopped container restarted successfully', {
					component: LogComponents.containerManager,
					operation: 'executeStep',
					oldContainerId: step.containerId.substring(0, 12),
					newContainerId: newContainerId.substring(0, 12),
					serviceId: step.serviceId,
				});
			} catch (error: any) {
				ctx.logger?.errorSync(
					'Failed to restart stopped container',
					error instanceof Error ? error : new Error(String(error)),
					{
						component: LogComponents.containerManager,
						operation: 'executeStep',
						containerId: step.containerId,
						serviceId: step.serviceId,
					},
				);
				recordStartFailure(ctx, restartKey, step.appId, step.serviceId, error);
				throw error;
			}
			break;
		}

		case 'removeContainer': {
			const svc = ctx.getServiceFromCurrentState(step.appId, step.serviceId);
			await ctx.removeContainer(step.containerId);
			ctx.removeServiceFromCurrentState(step.appId, step.serviceId);
			ctx.healthCheckManager.stopMonitoring(step.containerId);

			if (svc?.config.enableSocketDestination) {
				try {
					removeSocketDestination(svc, ctx.logger);
					ctx.reloadPublishBindings?.();
				} catch (destErr: any) {
					ctx.logger?.warnSync('Failed to disable socket destination', {
						component: LogComponents.containerManager,
						operation: 'executeStep',
						serviceId: step.serviceId,
						error: destErr instanceof Error ? destErr.message : String(destErr),
					});
				}
			}
			break;
		}

		case 'startContainer': {
			resetRetriesOnConfigChange(ctx, stepKey, step.service);
			assertRestartAllowed(ctx, stepKey, step.appId, step.service.serviceId);
			try {
				const containerId = await ctx.startContainer(step.service);
				ctx.retryManager.recordSuccess(stepKey);
				ctx.addServiceToCurrentState(step.appId, step.service, containerId);
				ctx.markServiceAsRunning(step.appId, step.service.serviceId);
				await ctx.attachLogsToContainer(containerId, step.service);
				ctx.startHealthMonitoring(containerId, step.service);

				if (step.service.config.enableSocketDestination) {
					try {
						ensureSocketDestination(step.service, ctx.logger);
						ctx.reloadPublishBindings?.();
					} catch (destErr: any) {
						ctx.logger?.warnSync('Failed to ensure socket destination', {
							component: LogComponents.containerManager,
							operation: 'executeStep',
							serviceName: step.service.serviceName,
							error: destErr instanceof Error ? destErr.message : String(destErr),
						});
					}
				}
			} catch (error: any) {
				ctx.logger?.errorSync(
					'Failed to start container',
					error instanceof Error ? error : new Error(String(error)),
					{
						component: LogComponents.containerManager,
						operation: 'executeStep',
						serviceName: step.service.serviceName,
					},
				);
				recordStartFailure(ctx, stepKey, step.appId, step.service.serviceId, error);
				throw error;
			}
			break;
		}

		case 'removeNetwork':
			await ctx.removeNetwork(step.appId, step.networkName);
			break;

		case 'createVolume':
			await ctx.createVolume(step.appId, step.volumeName);
			break;

		case 'removeVolume':
			await ctx.removeVolume(step.appId, step.volumeName);
			break;

		case 'noop':
			break;
	}
}
