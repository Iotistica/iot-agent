/**
 * Systemd watchdog helpers for readiness and keepalive notifications.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';

const execFileAsync = promisify(execFile);

/** Send a systemd notification using the blocking helper so systemd can attribute it. */
async function sendNotification(message: string, logger?: AgentLogger): Promise<void> {
	if (!process.env.NOTIFY_SOCKET) {
		return;
	}

	try {
		await execFileAsync('systemd-notify', ['--pid=parent', message], { timeout: 5000 });
		logger?.debugSync(`Sent notification: ${message}`, {
			component: LogComponents.agent,
			operation: 'sendNotification',
			method: 'systemd-notify'
		});
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));
		if (logger) {
			logger.errorSync(`Systemd notification failed: ${message}`, failure, {
				component: LogComponents.agent,
				operation: 'sendNotification',
			});
		} else {
			console.error(`[watchdog] Systemd notification failed: ${message}`, failure);
		}
		throw failure;
	}
}

export interface HealthCheckResult {
	healthy: boolean;
	reason: 'ok' | 'initializing' | 'health_check_failed';
}

/** Health check used to gate watchdog pings. */
export type HealthCheckFn = () => boolean | HealthCheckResult | Promise<boolean | HealthCheckResult>;

function normalizeHealthResult(raw: boolean | HealthCheckResult): HealthCheckResult {
	if (typeof raw === 'boolean') {
		return { healthy: raw, reason: raw ? 'ok' : 'health_check_failed' };
	}
	return raw;
}

/**
 * Starts systemd watchdog notifications.
 * Returns async cleanup for shutdown.
 */
export function startWatchdog(healthCheck?: HealthCheckFn, logger?: AgentLogger): () => Promise<void> {
	const socketPath = process.env.NOTIFY_SOCKET;
  
	if (!socketPath) {
		logger?.debugSync('NOTIFY_SOCKET not set - systemd watchdog disabled', {
			component: LogComponents.agent,
			operation: 'startWatchdog'
		});
		return async () => {};
	}

	// Capture systemd context for restart diagnostics.
	const systemdUnit = process.env.SYSTEMD_UNIT || 'unknown';
	const invocationId = process.env.INVOCATION_ID || 'unknown';
  
	logger?.infoSync('Starting systemd watchdog', {
		component: LogComponents.agent,
		socket: socketPath,
		method: 'systemd-notify',
		systemdUnit,
		invocationId
	});

	// Read watchdog interval from systemd in microseconds.
	const watchdogUsec = Number(process.env.WATCHDOG_USEC ?? 0);
  
	// Validate WATCHDOG_USEC.
	if (!Number.isFinite(watchdogUsec) || watchdogUsec <= 0) {
		logger?.warnSync('WATCHDOG_USEC invalid or not set - using default interval', {
			component: LogComponents.agent,
			operation: 'startWatchdog',
			watchdogUsec: process.env.WATCHDOG_USEC,
			defaultIntervalMs: 10000
		});
	} else if (watchdogUsec < 1_000_000) {
		// Too aggressive (<1s) can cause restart storms.
		logger?.warnSync('WATCHDOG_USEC too aggressive - risk of restart storms', {
			component: LogComponents.agent,
			operation: 'startWatchdog',
			watchdogUsec,
			watchdogTimeoutMs: watchdogUsec / 1000,
			minRecommendedMs: 1000,
			recommendation: 'Increase WatchdogSec to at least 2s in systemd unit'
		});
	}
  
	const intervalMs = watchdogUsec > 0 && Number.isFinite(watchdogUsec)
		? Math.max(1, Math.floor(watchdogUsec / 2000))
		: 10000;

	logger?.infoSync('Watchdog interval configured', {
		component: LogComponents.agent,
		operation: 'startWatchdog',
		intervalMs,
		watchdogTimeoutMs: watchdogUsec / 1000,
		source: watchdogUsec > 0 ? 'WATCHDOG_USEC' : 'default',
		systemdUnit,
		invocationId
	});

	// Do not send READY=1 here.
	// Application readiness is handled by notifyReady().
  
	const watchdogStartedAt = Date.now();
	let lastWatchdogTick = watchdogStartedAt;
	let lastInitLogAt = 0;
	let consecutiveSkippedPings = 0;
	let stopped = false;
	let tickInProgress = false;
	let notificationInFlight: Promise<void> | undefined;

	const watchdogInterval = setInterval(async () => {
		const now = Date.now();
		const drift = now - lastWatchdogTick;
		lastWatchdogTick = now;
		const maxDrift = intervalMs * 2; // Tolerance: 2x expected interval

		if (drift > maxDrift) {
			logger?.warnSync('Watchdog timer delayed', {
				component: LogComponents.agent,
				operation: 'watchdog',
				reason: 'timing_drift',
				driftMs: drift,
				expectedIntervalMs: intervalMs,
				maxDriftMs: maxDrift,
				systemdUnit,
				invocationId
			});
			if (!logger) console.warn(`[watchdog] Watchdog timer delayed by ${drift}ms`);
		}
		if (tickInProgress || stopped) return;
		tickInProgress = true;
		try {
			const rawResult = healthCheck ? await healthCheck() : true;
			if (stopped) return;
			const { healthy, reason } = normalizeHealthResult(rawResult);

			if (healthy) {
				notificationInFlight = sendNotification('WATCHDOG=1', logger);
				await notificationInFlight;
				notificationInFlight = undefined;

				// Reset skip counter on successful ping.
				if (consecutiveSkippedPings > 0) {
					logger?.infoSync('Watchdog ping resumed after skips', {
						component: LogComponents.agent,
						operation: 'watchdog',
						previousSkips: consecutiveSkippedPings
					});
					consecutiveSkippedPings = 0;
				}
			} else if (reason === 'initializing') {
				consecutiveSkippedPings++;
				const elapsedMs = now - watchdogStartedAt;
				// Throttle initializing messages to once every 30s
				if (now - lastInitLogAt >= 30000) {
					lastInitLogAt = now;
					logger?.warnSync('Watchdog ping suppressed - agent still initializing', {
						component: LogComponents.agent,
						operation: 'watchdog',
						action: 'suppressed',
						reason: 'initializing',
						elapsedSinceStartMs: elapsedMs,
						consecutiveSkips: consecutiveSkippedPings,
						systemdUnit,
						invocationId,
					});
					console.warn(`[watchdog] Agent still initializing (${Math.round(elapsedMs / 1000)}s elapsed) - watchdog pings suppressed`);
				}
			} else {
				// Post-ready health check failure — withhold ping; systemd restarts after timeout.
				consecutiveSkippedPings++;
				logger?.errorSync('Watchdog ping skipped - unhealthy state', undefined, {
					component: LogComponents.agent,
					operation: 'watchdog',
					action: 'skipped',
					reason: 'health_check_failed',
					consecutiveSkips: consecutiveSkippedPings,
					systemdUnit,
					invocationId,
					consequence: 'systemd_will_restart'
				});
				if (!logger) console.error('[watchdog] Watchdog ping skipped - unhealthy state');
			}
		} catch (error) {
			consecutiveSkippedPings++;
			if (logger) {
				logger.errorSync('Watchdog health check or notification failed', error instanceof Error ? error : undefined, {
					component: LogComponents.agent,
					operation: 'watchdog',
				});
			} else {
				console.error('[watchdog] Health check or notification failed', error);
			}
		} finally {
			notificationInFlight = undefined;
			tickInProgress = false;
		}
	}, intervalMs);

	// Cleanup function.
	return async () => {
		if (stopped) return;
		stopped = true;
		clearInterval(watchdogInterval);
		if (notificationInFlight) {
			try {
				await notificationInFlight;
			} catch {
				// The failed notification was already reported by sendNotification().
			}
		}
		try {
			await sendNotification('STOPPING=1', logger);
		} catch {
			// Shutdown must continue after a reported notification failure.
		}
    
		logger?.infoSync('Watchdog stopped', {
			component: LogComponents.agent,
			operation: 'stopWatchdog',
			totalSkippedPings: consecutiveSkippedPings,
			systemdUnit: process.env.SYSTEMD_UNIT || 'unknown',
			invocationId: process.env.INVOCATION_ID || 'unknown'
		});
	};
}

/** Notify systemd that the application is ready. */
export async function notifyReady(logger?: AgentLogger): Promise<void> {
	const socketPath = process.env.NOTIFY_SOCKET;
	if (!socketPath) {
		return;
	}

	console.log(`[watchdog] Sending READY=1 to NOTIFY_SOCKET=${socketPath}`);
	await sendNotification('READY=1', logger);

	console.log('[watchdog] READY=1 sent');
	logger?.infoSync('Systemd READY notification sent', {
		component: LogComponents.agent,
		operation: 'notifyReady'
	});
}

/** Notify systemd with a status message. */
export function notifySystemd(status: string, logger?: AgentLogger): void {
	if (!process.env.NOTIFY_SOCKET) {
		return;
	}

	void sendNotification(status, logger).catch(() => {
		// sendNotification() reports the failure.
	});
}
