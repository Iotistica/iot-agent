import { HealthArbiter } from '../../../src/health/arbiter';

function defer<T = boolean>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

describe('HealthArbiter', () => {
	let arbiter: HealthArbiter;

	beforeEach(() => {
		arbiter = new HealthArbiter();
	});

	afterEach(() => {
		arbiter.stop();
	});

	describe('single-flight deduplication', () => {
		it('shares one check result when multiple callers overlap', async () => {
			let callCount = 0;
			const gate = defer();

			arbiter.registerSubsystem('slow', async () => {
				callCount++;
				await gate.promise;
				return true;
			}, { critical: true });

			// Register's fire-and-forget check is in-flight (blocked on gate).
			// Both isHealthy() calls share that single in-flight check.
			const a = arbiter.isHealthy();
			const b = arbiter.isHealthy();

			gate.resolve(true);
			const [resultA, resultB] = await Promise.all([a, b]);

			expect(callCount).toBe(1);
			expect(resultA).toBe(true);
			expect(resultB).toBe(true);
		});

		it('does not double-increment consecutiveFailures on concurrent failure', async () => {
			const gate = defer();

			arbiter.registerSubsystem('flaky', async () => {
				await gate.promise;
				return false;
			}, { critical: true, minFailuresBeforeLatch: 5 });

			const a = arbiter.isHealthy();
			const b = arbiter.isHealthy();
			gate.resolve(false);
			await Promise.all([a, b]);

			const report = arbiter.getHealthReport();
			const sub = report.subsystems.find(s => s.name === 'flaky')!;
			expect(sub.consecutiveFailures).toBe(1);
		});

		it('allows a new check after the in-flight one completes', async () => {
			let callCount = 0;

			arbiter.registerSubsystem('counter', async () => {
				callCount++;
				return true;
			}, { critical: false });

			// Let register's fire-and-forget check complete
			await new Promise(r => setImmediate(r));
			callCount = 0;

			await arbiter.isHealthy();
			await arbiter.isHealthy();

			expect(callCount).toBe(2);
		});
	});

	describe('failure counting and latching', () => {
		it('latches after minFailuresBeforeLatch consecutive failures', async () => {
			arbiter.registerSubsystem('unstable', () => false, {
				critical: true,
				minFailuresBeforeLatch: 3,
			});

			await arbiter.isHealthy();
			await arbiter.isHealthy();
			const report1 = arbiter.getHealthReport();
			expect(report1.subsystems[0].latched).toBe(false);

			await arbiter.isHealthy();
			const report2 = arbiter.getHealthReport();
			expect(report2.subsystems[0].latched).toBe(true);
			expect(report2.subsystems[0].consecutiveFailures).toBe(3);
		});

		it('resets failure count on success', async () => {
			let healthy = false;
			arbiter.registerSubsystem('intermittent', () => healthy, {
				critical: true,
				minFailuresBeforeLatch: 5,
				recoveryCooldownMs: 0,
			});

			await arbiter.isHealthy();
			await arbiter.isHealthy();

			healthy = true;
			await arbiter.isHealthy();

			const report = arbiter.getHealthReport();
			expect(report.subsystems[0].consecutiveFailures).toBe(0);
			expect(report.subsystems[0].healthy).toBe(true);
		});

		it('counts thrown errors as failures', async () => {
			arbiter.registerSubsystem('throws', () => { throw new Error('boom'); }, {
				critical: true,
				minFailuresBeforeLatch: 5,
			});

			await arbiter.isHealthy();
			await arbiter.isHealthy();

			const report = arbiter.getHealthReport();
			const sub = report.subsystems.find(s => s.name === 'throws')!;
			expect(sub.consecutiveFailures).toBe(2);
			expect(sub.lastError).toBe('boom');
		});
	});

	describe('recoverable latching', () => {
		it('recovers from latch after consecutive successes meet threshold', async () => {
			let healthy = false;
			arbiter.registerSubsystem('recoverable', () => healthy, {
				critical: true,
				minFailuresBeforeLatch: 2,
				recoverySuccessThreshold: 3,
				recoveryCooldownMs: 0,
			});

			await arbiter.isHealthy();
			await arbiter.isHealthy();

			const latchedReport = arbiter.getHealthReport();
			expect(latchedReport.subsystems[0].latched).toBe(true);
			expect(await arbiter.isHealthy()).toBe(false);

			healthy = true;
			await arbiter.isHealthy();
			await arbiter.isHealthy();
			expect(arbiter.getHealthReport().subsystems[0].latched).toBe(true);

			await arbiter.isHealthy();
			const recoveredReport = arbiter.getHealthReport();
			expect(recoveredReport.subsystems[0].latched).toBe(false);
			expect(recoveredReport.subsystems[0].healthy).toBe(true);
			expect(await arbiter.isHealthy()).toBe(true);
		});

		it('resets recovery progress on failure during recovery', async () => {
			let healthy = false;
			arbiter.registerSubsystem('unstable-recovery', () => healthy, {
				critical: true,
				minFailuresBeforeLatch: 2,
				recoverySuccessThreshold: 3,
				recoveryCooldownMs: 0,
			});

			await arbiter.isHealthy();
			await arbiter.isHealthy();
			expect(arbiter.getHealthReport().subsystems[0].latched).toBe(true);

			healthy = true;
			await arbiter.isHealthy();
			await arbiter.isHealthy();

			healthy = false;
			await arbiter.isHealthy();

			healthy = true;
			await arbiter.isHealthy();
			await arbiter.isHealthy();
			expect(arbiter.getHealthReport().subsystems[0].latched).toBe(true);

			await arbiter.isHealthy();
			expect(arbiter.getHealthReport().subsystems[0].latched).toBe(false);
		});

		it('permanent latch when recoverySuccessThreshold is 0', async () => {
			let healthy = false;
			arbiter.registerSubsystem('permanent', () => healthy, {
				critical: true,
				minFailuresBeforeLatch: 2,
				recoverySuccessThreshold: 0,
			});

			await arbiter.isHealthy();
			await arbiter.isHealthy();
			expect(arbiter.getHealthReport().subsystems[0].latched).toBe(true);

			healthy = true;
			await arbiter.isHealthy();
			await arbiter.isHealthy();
			await arbiter.isHealthy();

			expect(arbiter.getHealthReport().subsystems[0].latched).toBe(true);
			expect(await arbiter.isHealthy()).toBe(false);
		});
	});

	describe('cooldown', () => {
		it('suppresses recovery during cooldown period', async () => {
			jest.useFakeTimers();
			try {
				let healthy = false;
				arbiter.registerSubsystem('cooldown-test', () => healthy, {
					critical: true,
					minFailuresBeforeLatch: 10,
					recoveryCooldownMs: 5000,
				});

				await arbiter.isHealthy();

				healthy = true;
				const result = await arbiter.isHealthy();
				expect(result).toBe(false);

				jest.advanceTimersByTime(5000);
				const recovered = await arbiter.isHealthy();
				expect(recovered).toBe(true);
			} finally {
				jest.useRealTimers();
			}
		});

		it('suppresses recoverable-latch recovery during cooldown', async () => {
			jest.useFakeTimers();
			try {
				let healthy = false;
				arbiter.registerSubsystem('cooldown-latch', () => healthy, {
					critical: true,
					minFailuresBeforeLatch: 2,
					recoverySuccessThreshold: 1,
					recoveryCooldownMs: 5000,
				});

				await arbiter.isHealthy();
				await arbiter.isHealthy();
				expect(arbiter.getHealthReport().subsystems[0].latched).toBe(true);

				healthy = true;
				await arbiter.isHealthy();
				expect(arbiter.getHealthReport().subsystems[0].latched).toBe(true);

				jest.advanceTimersByTime(5000);
				await arbiter.isHealthy();
				expect(arbiter.getHealthReport().subsystems[0].latched).toBe(false);
			} finally {
				jest.useRealTimers();
			}
		});
	});

	describe('markFatal', () => {
		it('overrides all subsystem health', async () => {
			arbiter.registerSubsystem('healthy-sub', () => true, { critical: true });
			await arbiter.isHealthy();
			expect(await arbiter.isHealthy()).toBe(true);

			arbiter.markFatal('unhandled rejection');
			expect(await arbiter.isHealthy()).toBe(false);

			const report = arbiter.getHealthReport();
			expect(report.overall).toBe(false);
		});
	});

	describe('overall health', () => {
		it('returns true when all critical subsystems are healthy', async () => {
			arbiter.registerSubsystem('a', () => true, { critical: true });
			arbiter.registerSubsystem('b', () => true, { critical: true });
			arbiter.registerSubsystem('c', () => false, { critical: false });

			expect(await arbiter.isHealthy()).toBe(true);
		});

		it('returns false when any critical subsystem is unhealthy', async () => {
			arbiter.registerSubsystem('good', () => true, { critical: true });
			arbiter.registerSubsystem('bad', () => false, { critical: true });

			expect(await arbiter.isHealthy()).toBe(false);
		});

		it('independent subsystems do not interfere with each other', async () => {
			arbiter.registerSubsystem('alpha', () => true, { critical: true });
			arbiter.registerSubsystem('beta', () => false, { critical: false });

			await arbiter.isHealthy();

			const report = arbiter.getHealthReport();
			expect(report.subsystems.find(s => s.name === 'alpha')!.healthy).toBe(true);
			expect(report.subsystems.find(s => s.name === 'beta')!.healthy).toBe(false);
			expect(report.overall).toBe(true);
		});
	});

	describe('health report', () => {
		it('includes latched status in report', async () => {
			arbiter.registerSubsystem('x', () => false, {
				critical: true,
				minFailuresBeforeLatch: 1,
			});

			await arbiter.isHealthy();

			const report = arbiter.getHealthReport();
			expect(report.subsystems[0].latched).toBe(true);
			expect(report.criticalFailures).toContain('x');
		});

		it('reports fatal error in overall even when subsystems are healthy', async () => {
			arbiter.registerSubsystem('ok', () => true, { critical: true });
			arbiter.markFatal('oom');

			const report = arbiter.getHealthReport();
			expect(report.overall).toBe(false);
		});
	});

	describe('watchdog integration scenario', () => {
		it('simulates the observed 6500-point failure and recovery', async () => {
			let apiHealthy = false;
			arbiter.registerSubsystem('agent-api', () => apiHealthy, {
				critical: true,
				minFailuresBeforeLatch: 3,
				recoverySuccessThreshold: 3,
				recoveryCooldownMs: 0,
			});

			await arbiter.isHealthy();
			await arbiter.isHealthy();
			expect(arbiter.getHealthReport().subsystems[0].latched).toBe(false);

			await arbiter.isHealthy();
			expect(arbiter.getHealthReport().subsystems[0].latched).toBe(true);
			expect(await arbiter.isHealthy()).toBe(false);

			apiHealthy = true;
			await arbiter.isHealthy();
			await arbiter.isHealthy();
			await arbiter.isHealthy();

			expect(arbiter.getHealthReport().subsystems[0].latched).toBe(false);
			expect(await arbiter.isHealthy()).toBe(true);
		});

		it('concurrent timeouts under old config would have latched at 2, now need 3', async () => {
			const gate = defer();
			let callCount = 0;

			arbiter.registerSubsystem('agent-api', async () => {
				callCount++;
				await gate.promise;
				return false;
			}, {
				critical: true,
				minFailuresBeforeLatch: 3,
				recoverySuccessThreshold: 3,
			});

			// Register's fire-and-forget check is in-flight (blocked on gate).
			// All concurrent isHealthy() calls share that single in-flight check.
			const a = arbiter.isHealthy();
			const b = arbiter.isHealthy();
			const c = arbiter.isHealthy();
			gate.resolve(false);
			await Promise.all([a, b, c]);

			// Only one check function invocation despite 4 callers (register + 3 isHealthy).
			expect(callCount).toBe(1);
			const report = arbiter.getHealthReport();
			expect(report.subsystems[0].latched).toBe(false);
			expect(report.subsystems[0].consecutiveFailures).toBe(1);
		});
	});

	describe('unregister', () => {
		it('removes subsystem from health checks', async () => {
			arbiter.registerSubsystem('temp', () => false, { critical: true });
			arbiter.unregisterSubsystem('temp');

			expect(await arbiter.isHealthy()).toBe(true);
			expect(arbiter.getHealthReport().subsystems).toHaveLength(0);
		});
	});
});
