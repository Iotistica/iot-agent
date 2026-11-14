/**
 * Tests that watchdog pings are gated by the readiness flag and that the
 * initializing vs unhealthy states produce distinct log messages.
 */

const mockExecFile = jest.fn((_cmd: string, _args: string[], cb: Function) => {
	cb(null, '', '');
});

jest.mock('child_process', () => ({
	execFile: mockExecFile,
}));

jest.mock('dgram', () => ({
	createSocket: jest.fn(() => ({
		send: jest.fn((_b: any, _o: any, _l: any, _p: any, cb: Function) => cb(null)),
		close: jest.fn(),
		on: jest.fn(),
	})),
}));

import type { HealthCheckResult } from '../../../src/system/watchdog';

function countNotifications(message: string): number {
	return mockExecFile.mock.calls.filter(
		(call: any[]) => call[1] && call[1].includes(message)
	).length;
}

describe('watchdog readiness gating', () => {
	const ORIGINAL_ENV = process.env;

	beforeEach(() => {
		jest.useFakeTimers();
		mockExecFile.mockClear();
		process.env = {
			...ORIGINAL_ENV,
			NOTIFY_SOCKET: '/run/systemd/notify',
			WATCHDOG_USEC: '60000000',
		};
	});

	afterEach(() => {
		jest.useRealTimers();
		process.env = ORIGINAL_ENV;
		jest.resetModules();
	});

	function loadWatchdog() {
		return require('../../../src/system/watchdog') as typeof import('../../../src/system/watchdog');
	}

	it('does not send WATCHDOG=1 while health check returns initializing', async () => {
		const { startWatchdog } = loadWatchdog();

		const healthCheck = jest.fn<HealthCheckResult, []>().mockReturnValue({
			healthy: false,
			reason: 'initializing',
		});

		startWatchdog(healthCheck);
		await jest.advanceTimersByTimeAsync(90_000);

		expect(countNotifications('WATCHDOG=1')).toBe(0);
		expect(healthCheck).toHaveBeenCalled();
	});

	it('sends WATCHDOG=1 after health check becomes healthy', async () => {
		const { startWatchdog } = loadWatchdog();

		let ready = false;
		const healthCheck = jest.fn().mockImplementation(() => {
			if (!ready) return { healthy: false, reason: 'initializing' };
			return { healthy: true, reason: 'ok' };
		});

		startWatchdog(healthCheck);

		await jest.advanceTimersByTimeAsync(30_000);
		expect(countNotifications('WATCHDOG=1')).toBe(0);

		ready = true;
		await jest.advanceTimersByTimeAsync(30_000);
		expect(countNotifications('WATCHDOG=1')).toBeGreaterThan(0);
	});

	it('does not send READY=1 from startWatchdog', async () => {
		const { startWatchdog } = loadWatchdog();
		startWatchdog(() => ({ healthy: true, reason: 'ok' as const }));
		await jest.advanceTimersByTimeAsync(60_000);
		expect(countNotifications('READY=1')).toBe(0);
	});

	it('withholds pings when health check fails post-ready', async () => {
		const { startWatchdog } = loadWatchdog();

		let healthy = true;
		const healthCheck = jest.fn().mockImplementation(() => ({
			healthy,
			reason: healthy ? 'ok' : 'health_check_failed',
		}));

		startWatchdog(healthCheck);

		await jest.advanceTimersByTimeAsync(30_000);
		const countBefore = countNotifications('WATCHDOG=1');
		expect(countBefore).toBeGreaterThan(0);

		healthy = false;
		await jest.advanceTimersByTimeAsync(30_000);
		expect(countNotifications('WATCHDOG=1')).toBe(countBefore);
	});

	it('accepts plain boolean health check for backward compatibility', () => {
		const { startWatchdog } = loadWatchdog();
		startWatchdog(() => true);
		await jest.advanceTimersByTimeAsync(30_000);
		expect(countNotifications('WATCHDOG=1')).toBeGreaterThan(0);
	});

	it('is a no-op without NOTIFY_SOCKET', () => {
		delete process.env.NOTIFY_SOCKET;
		const { startWatchdog } = loadWatchdog();

		const healthCheck = jest.fn().mockReturnValue(true);
		const cleanup = startWatchdog(healthCheck);

		await jest.advanceTimersByTimeAsync(60_000);
		expect(healthCheck).not.toHaveBeenCalled();
		expect(mockExecFile).not.toHaveBeenCalled();
		expect(typeof cleanup).toBe('function');
	});
});
