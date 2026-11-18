/**
 * Health Arbiter - Centralized Health State Management
 *
 * Single source of truth for all subsystem health across the agent.
 * Prevents one subsystem from masking failures in another.
 *
 * Architecture:
 * - Each subsystem registers with health arbiter
 * - Arbiter periodically checks all subsystems
 * - Watchdog queries arbiter for overall health
 * - Cloud telemetry includes detailed health report
 *
 * Concurrency: per-subsystem single-flight ensures overlapping callers
 * share one check result and cannot double-increment consecutiveFailures.
 */

import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';

export type SubsystemCheckFn = () => boolean | Promise<boolean>;

export interface SubsystemOptions {
	/** If true, subsystem failure causes overall health failure */
	critical?: boolean;
	/** Human-readable description of subsystem */
	description?: string;
	/** Check interval in milliseconds (default: 30s) */
	checkIntervalMs?: number;
	/**
	 * Cooldown period (ms) before allowing recovery after failure.
	 * Prevents flapping subsystems from masking failures.
	 * Default: 30s for critical, 0 for non-critical
	 */
	recoveryCooldownMs?: number;
	/**
	 * Minimum consecutive failures before latching a critical subsystem.
	 * Default: 2. The immediate startup check counts as failure #1 — requiring 2+
	 * means at least one periodic check must confirm before latching.
	 */
	minFailuresBeforeLatch?: number;
	/**
	 * Consecutive successes required to recover from a latched state.
	 * Default: 0 (permanent latch — only restart recovers).
	 * Set to a positive number for subsystems that can recover from transient failures.
	 */
	recoverySuccessThreshold?: number;
}

interface SubsystemHealth {
	name: string;
	checkFn: SubsystemCheckFn;
	critical: boolean;
	description?: string;
	healthy: boolean;
	lastCheck: number;
	lastError?: string;
	consecutiveFailures: number;
	consecutiveSuccesses: number;
	checkIntervalMs: number;
	recoveryCooldownMs: number;
	minFailuresBeforeLatch: number;
	recoverySuccessThreshold: number;
	lastFailureTime: number;
	latched: boolean;
	inflight?: Promise<boolean>;
}

export interface HealthReport {
	overall: boolean;
	subsystems: Array<{
		name: string;
		healthy: boolean;
		critical: boolean;
		description?: string;
		lastCheck: number;
		lastError?: string;
		consecutiveFailures: number;
		latched: boolean;
	}>;
	unhealthySubsystems: string[];
	criticalFailures: string[];
}

export class HealthArbiter {
	private subsystems = new Map<string, SubsystemHealth>();
	private checkInterval: NodeJS.Timeout | null = null;
	private readonly DEFAULT_CHECK_INTERVAL_MS = 30000;
	private readonly DEFAULT_CRITICAL_COOLDOWN_MS = 30000;
	private fatalError: string | null = null;

	constructor(private logger?: AgentLogger) {}

	setLogger(logger: AgentLogger): void {
		this.logger = logger;
	}

	registerSubsystem(
		name: string,
		checkFn: SubsystemCheckFn,
		options: SubsystemOptions = {}
	): void {
		const {
			critical = false,
			description,
			checkIntervalMs = this.DEFAULT_CHECK_INTERVAL_MS,
			recoveryCooldownMs = critical ? this.DEFAULT_CRITICAL_COOLDOWN_MS : 0,
			minFailuresBeforeLatch = 2,
			recoverySuccessThreshold = 0,
		} = options;

		if (this.subsystems.has(name)) {
			this.logger?.warnSync('Subsystem already registered - replacing', {
				component: LogComponents.agent,
				operation: 'registerSubsystem',
				subsystem: name
			});
		}

		this.subsystems.set(name, {
			name,
			checkFn,
			critical,
			description,
			healthy: false,
			lastCheck: 0,
			consecutiveFailures: 0,
			consecutiveSuccesses: 0,
			checkIntervalMs,
			recoveryCooldownMs,
			minFailuresBeforeLatch,
			recoverySuccessThreshold,
			lastFailureTime: 0,
			latched: false,
		});

		this.logger?.debugSync('Subsystem registered', {
			component: LogComponents.agent,
			operation: 'registerSubsystem',
			subsystem: name,
			critical,
			recoveryCooldownMs,
			recoverySuccessThreshold,
			description
		});

		void this.checkSubsystem(name);
	}

	unregisterSubsystem(name: string): void {
		if (this.subsystems.delete(name)) {
			this.logger?.debugSync('Subsystem unregistered', {
				component: LogComponents.agent,
				operation: 'unregisterSubsystem',
				subsystem: name
			});
		}
	}

	private checkSubsystem(name: string): Promise<boolean> {
		const subsystem = this.subsystems.get(name);
		if (!subsystem) {
			this.logger?.warnSync('Attempted to check unknown subsystem', {
				component: LogComponents.agent,
				operation: 'checkSubsystem',
				subsystem: name
			});
			return Promise.resolve(false);
		}

		if (subsystem.latched && subsystem.recoverySuccessThreshold <= 0) {
			return Promise.resolve(false);
		}

		if (subsystem.inflight) return subsystem.inflight;

		const promise = this.executeCheck(subsystem);
		subsystem.inflight = promise;
		promise.finally(() => { subsystem.inflight = undefined; });
		return promise;
	}

	private async executeCheck(subsystem: SubsystemHealth): Promise<boolean> {
		try {
			const healthy = await subsystem.checkFn();
			const now = Date.now();

			if (healthy) {
				return this.handleSuccess(subsystem, now);
			}
			return this.handleFailure(subsystem, now, 'health_check_failed');
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			return this.handleFailure(subsystem, Date.now(), errorMsg);
		}
	}

	private handleSuccess(subsystem: SubsystemHealth, now: number): boolean {
		if (subsystem.latched) {
			return this.handleLatchedSuccess(subsystem, now);
		}

		if (subsystem.critical && subsystem.lastFailureTime > 0 && !subsystem.healthy) {
			const timeSinceFailure = now - subsystem.lastFailureTime;
			if (timeSinceFailure < subsystem.recoveryCooldownMs) {
				this.logger?.debugSync('Subsystem recovery suppressed - cooldown period active', {
					component: LogComponents.agent,
					operation: 'checkSubsystem',
					subsystem: subsystem.name,
					timeSinceFailureMs: timeSinceFailure,
					cooldownRemainingMs: subsystem.recoveryCooldownMs - timeSinceFailure,
				});
				subsystem.lastCheck = now;
				return false;
			}
		}

		const previousFailures = subsystem.consecutiveFailures;
		if (previousFailures > 0 && !subsystem.healthy) {
			this.logger?.infoSync('Subsystem recovered', {
				component: LogComponents.agent,
				operation: 'checkSubsystem',
				subsystem: subsystem.name,
				critical: subsystem.critical,
				previousFailures
			});
		}

		subsystem.consecutiveFailures = 0;
		subsystem.consecutiveSuccesses++;
		subsystem.healthy = true;
		subsystem.lastCheck = now;
		subsystem.lastError = undefined;
		return true;
	}

	private handleLatchedSuccess(subsystem: SubsystemHealth, now: number): boolean {
		const timeSinceFailure = now - subsystem.lastFailureTime;
		if (timeSinceFailure < subsystem.recoveryCooldownMs) {
			subsystem.lastCheck = now;
			return false;
		}

		subsystem.consecutiveSuccesses++;
		subsystem.lastCheck = now;

		if (subsystem.consecutiveSuccesses >= subsystem.recoverySuccessThreshold) {
			subsystem.latched = false;
			subsystem.healthy = true;
			subsystem.consecutiveFailures = 0;
			subsystem.lastError = undefined;
			this.logger?.infoSync('Subsystem recovered from latched state', {
				component: LogComponents.agent,
				operation: 'checkSubsystem',
				subsystem: subsystem.name,
				critical: subsystem.critical,
				consecutiveSuccesses: subsystem.consecutiveSuccesses,
			});
			return true;
		}

		this.logger?.debugSync('Subsystem latch recovery in progress', {
			component: LogComponents.agent,
			operation: 'checkSubsystem',
			subsystem: subsystem.name,
			consecutiveSuccesses: subsystem.consecutiveSuccesses,
			threshold: subsystem.recoverySuccessThreshold,
		});
		return false;
	}

	private handleFailure(subsystem: SubsystemHealth, now: number, errorMsg: string): boolean {
		subsystem.healthy = false;
		subsystem.lastCheck = now;
		subsystem.lastError = errorMsg;
		subsystem.consecutiveSuccesses = 0;
		subsystem.consecutiveFailures++;
		subsystem.lastFailureTime = now;

		if (subsystem.critical && !subsystem.latched &&
			subsystem.consecutiveFailures >= subsystem.minFailuresBeforeLatch) {
			subsystem.latched = true;
		}

		this.logger?.errorSync('Subsystem health check failed', undefined, {
			component: LogComponents.agent,
			operation: 'checkSubsystem',
			subsystem: subsystem.name,
			critical: subsystem.critical,
			consecutiveFailures: subsystem.consecutiveFailures,
			description: subsystem.description,
			latched: subsystem.latched
		});

		return false;
	}

	async isHealthy(): Promise<boolean> {
		if (this.fatalError) {
			this.logger?.debugSync('Overall health check failed - fatal error marked', {
				component: LogComponents.agent,
				operation: 'isHealthy',
				fatalError: this.fatalError
			});
			return false;
		}

		for (const name of this.subsystems.keys()) {
			await this.checkSubsystem(name);
		}

		for (const [name, subsystem] of this.subsystems) {
			if (subsystem.critical && !subsystem.healthy) {
				this.logger?.debugSync('Overall health check failed', {
					component: LogComponents.agent,
					operation: 'isHealthy',
					failedSubsystem: name,
					consecutiveFailures: subsystem.consecutiveFailures
				});
				return false;
			}
		}

		return true;
	}

	markFatal(reason: string): void {
		this.fatalError = reason;

		this.logger?.errorSync('Agent marked as fatally unhealthy - systemd will restart', undefined, {
			component: LogComponents.agent,
			operation: 'markFatal',
			reason,
			consequence: 'watchdog_withheld_systemd_restart'
		});
	}

	getHealthReport(): HealthReport {
		const subsystems = Array.from(this.subsystems.values()).map(s => ({
			name: s.name,
			healthy: s.healthy,
			critical: s.critical,
			description: s.description,
			lastCheck: s.lastCheck,
			lastError: s.lastError,
			consecutiveFailures: s.consecutiveFailures,
			latched: s.latched,
		}));

		const unhealthySubsystems = subsystems
			.filter(s => !s.healthy)
			.map(s => s.name);

		const criticalFailures = subsystems
			.filter(s => s.critical && !s.healthy)
			.map(s => s.name);

		const overall = criticalFailures.length === 0 && !this.fatalError;

		return {
			overall,
			subsystems,
			unhealthySubsystems,
			criticalFailures
		};
	}

	startPeriodicChecks(intervalMs: number = this.DEFAULT_CHECK_INTERVAL_MS): void {
		if (this.checkInterval) {
			this.logger?.warnSync('Periodic health checks already running', {
				component: LogComponents.agent,
				operation: 'startPeriodicChecks'
			});
			return;
		}

		this.logger?.debugSync('Starting periodic health checks', {
			component: LogComponents.agent,
			operation: 'startPeriodicChecks',
			intervalMs,
			registeredSubsystems: Array.from(this.subsystems.keys())
		});

		void this.isHealthy();

		this.checkInterval = setInterval(() => {
			void this.isHealthy();
		}, intervalMs);
	}

	stop(): void {
		this.stopPeriodicChecks();

		this.logger?.infoSync('Health arbiter stopped', {
			component: LogComponents.agent,
			operation: 'stop'
		});
	}

	stopPeriodicChecks(): void {
		if (this.checkInterval) {
			clearInterval(this.checkInterval);
			this.checkInterval = null;

			this.logger?.infoSync('Periodic health checks stopped', {
				component: LogComponents.agent,
				operation: 'stopPeriodicChecks'
			});
		}
	}
}
