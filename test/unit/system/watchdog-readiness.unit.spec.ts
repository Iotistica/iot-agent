/**
 * Tests that watchdog pings are gated by the readiness flag and that the
 * initializing vs unhealthy states produce distinct log messages.
 */

const mockExecFile = jest.fn((_cmd: string, _args: string[], _options: object, cb: Function) => {
	cb(null, '', '');
});

jest.mock('child_process', () => ({
	execFile: mockExecFile,
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
		jest.clearAllTimers();
		jest.useRealTimers();
		jest.restoreAllMocks();
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

	it('sends heartbeats after initialization exceeds the watchdog timeout', async () => {
		const { startWatchdog, notifyReady } = loadWatchdog();
		let ready = false;
		startWatchdog(() => ready ? { healthy: true, reason: 'ok' } : { healthy: false, reason: 'initializing' });

		await jest.advanceTimersByTimeAsync(90_000);
		expect(countNotifications('WATCHDOG=1')).toBe(0);
		ready = true;
		await notifyReady();
		expect(countNotifications('READY=1')).toBe(1);
		await jest.advanceTimersByTimeAsync(60_000);
		expect(countNotifications('WATCHDOG=1')).toBe(2);
	});

	it('resumes heartbeats when health recovers after multiple skipped intervals', async () => {
		const { startWatchdog } = loadWatchdog();
		let healthy = false;
		startWatchdog(() => healthy);
		await jest.advanceTimersByTimeAsync(90_000);
		healthy = true;
		await jest.advanceTimersByTimeAsync(30_000);
		expect(countNotifications('WATCHDOG=1')).toBe(1);
	});

	it('checks health and sends a heartbeat after a delayed timer', async () => {
		const { startWatchdog } = loadWatchdog();
		startWatchdog(() => true);
		jest.setSystemTime(Date.now() + 90_000);
		await jest.advanceTimersByTimeAsync(30_000);
		expect(countNotifications('WATCHDOG=1')).toBe(1);
		expect(mockExecFile).toHaveBeenCalledWith(
			'systemd-notify', ['--pid=parent', 'WATCHDOG=1'], { timeout: 5000 }, expect.any(Function),
		);
	});

	it('reports a notification failure and retries the next heartbeat', async () => {
		const { startWatchdog } = loadWatchdog();
		const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
		mockExecFile.mockImplementationOnce((_cmd, _args, _options, cb) => cb(new Error('notification failed')));
		startWatchdog(() => true);
		await jest.advanceTimersByTimeAsync(30_000);
		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('notification failed'), expect.any(Error));
		await jest.advanceTimersByTimeAsync(30_000);
		expect(countNotifications('WATCHDOG=1')).toBe(2);
		consoleError.mockRestore();
	});

	it('withholds a ping when the health check throws and retries later', async () => {
		const { startWatchdog } = loadWatchdog();
		const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
		const healthCheck = jest.fn().mockRejectedValueOnce(new Error('health unavailable')).mockResolvedValue(true);
		startWatchdog(healthCheck);
		await jest.advanceTimersByTimeAsync(30_000);
		expect(countNotifications('WATCHDOG=1')).toBe(0);
		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Health check'), expect.any(Error));
		await jest.advanceTimersByTimeAsync(30_000);
		expect(countNotifications('WATCHDOG=1')).toBe(1);
		consoleError.mockRestore();
	});

	it('does not report READY as sent when systemd-notify fails', async () => {
		const { notifyReady } = loadWatchdog();
		const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
		const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
		mockExecFile.mockImplementationOnce((_cmd, _args, _options, cb) => cb(new Error('notification failed')));
		await expect(notifyReady()).rejects.toThrow('notification failed');
		expect(consoleLog).not.toHaveBeenCalledWith('[watchdog] READY=1 sent');
		expect(consoleError).toHaveBeenCalled();
		consoleError.mockRestore();
		consoleLog.mockRestore();
	});

	it('stops cleanly without sending a late ping when health is still pending', async () => {
		const { startWatchdog } = loadWatchdog();
		let resolveHealth!: (healthy: boolean) => void;
		const stop = startWatchdog(() => new Promise(resolve => { resolveHealth = resolve; }));
		await jest.advanceTimersByTimeAsync(30_000);
		await stop();
		resolveHealth(true);
		await jest.advanceTimersByTimeAsync(60_000);
		await stop();
		expect(countNotifications('WATCHDOG=1')).toBe(0);
		expect(countNotifications('STOPPING=1')).toBe(1);
	});

	it('waits for an in-flight heartbeat before sending STOPPING', async () => {
		const { startWatchdog } = loadWatchdog();
		let finishNotification!: Function;
		mockExecFile.mockImplementationOnce((_cmd, _args, _options, cb) => { finishNotification = cb; });
		const stop = startWatchdog(() => true);
		await jest.advanceTimersByTimeAsync(30_000);
		const stopping = stop();
		expect(countNotifications('STOPPING=1')).toBe(0);
		finishNotification(null, '', '');
		await stopping;
		expect(mockExecFile.mock.calls.map(call => call[1][1])).toEqual(['WATCHDOG=1', 'STOPPING=1']);
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
		await jest.advanceTimersByTimeAsync(90_000);
		expect(countNotifications('WATCHDOG=1')).toBe(countBefore);
	});

	it('accepts plain boolean health check for backward compatibility', async () => {
		const { startWatchdog } = loadWatchdog();
		startWatchdog(() => true);
		await jest.advanceTimersByTimeAsync(30_000);
		expect(countNotifications('WATCHDOG=1')).toBeGreaterThan(0);
	});

	it('is a no-op without NOTIFY_SOCKET', async () => {
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
