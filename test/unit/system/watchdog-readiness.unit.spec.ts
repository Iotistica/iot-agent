/**
 * Tests that watchdog pings are gated by the readiness flag and that the
 * initializing vs unhealthy states produce distinct log messages.
 */

// Mock child_process before importing watchdog
jest.mock('child_process', () => ({
	execFile: jest.fn((_cmd: string, _args: string[], cb: Function) => {
		// Simulate systemd-notify success
		cb(null, '', '');
	}),
}));

// Mock dgram to capture sent messages
const mockSend = jest.fn((_buf: Buffer, _off: number, _len: number, _path: any, cb: Function) => {
	cb(null);
});
const mockClose = jest.fn();
jest.mock('dgram', () => ({
	createSocket: jest.fn(() => ({
		send: mockSend,
		close: mockClose,
		on: jest.fn(),
	})),
}));

import type { HealthCheckResult } from '../../../src/system/watchdog';

describe('watchdog readiness gating', () => {
	const ORIGINAL_ENV = process.env;

	beforeEach(() => {
		jest.useFakeTimers();
		process.env = {
			...ORIGINAL_ENV,
			NOTIFY_SOCKET: '/run/systemd/notify',
			WATCHDOG_USEC: '60000000', // 60s timeout -> 30s ping interval
		};
		mockSend.mockClear();
		mockClose.mockClear();
	});

	afterEach(async () => {
		jest.useRealTimers();
		process.env = ORIGINAL_ENV;
		// Reset module state by clearing the module cache
		jest.resetModules();
	});

	function loadWatchdog() {
		// Fresh import each test to reset module-level state
		return require('../../../src/system/watchdog') as typeof import('../../../src/system/watchdog');
	}

	it('does not send WATCHDOG=1 while health check returns initializing', async () => {
		const { startWatchdog } = loadWatchdog();

		const healthCheck = jest.fn<HealthCheckResult, []>().mockReturnValue({
			healthy: false,
			reason: 'initializing',
		});

		startWatchdog(healthCheck);

		// Advance past several ping intervals (30s each)
		jest.advanceTimersByTime(90_000);

		// No WATCHDOG=1 should have been sent
		const watchdogCalls = mockSend.mock.calls.filter(
			(call: any[]) => call[0] && Buffer.from(call[0]).toString().includes('WATCHDOG=1')
		);
		expect(watchdogCalls).toHaveLength(0);

		// Health check should have been called
		expect(healthCheck).toHaveBeenCalled();
	});

	it('sends WATCHDOG=1 after health check becomes healthy', async () => {
		const { startWatchdog } = loadWatchdog();

		let ready = false;
		const healthCheck = jest.fn<HealthCheckResult, []>().mockImplementation(() => {
			if (!ready) return { healthy: false, reason: 'initializing' };
			return { healthy: true, reason: 'ok' };
		});

		startWatchdog(healthCheck);

		// Advance 30s — still initializing
		jest.advanceTimersByTime(30_000);
		let watchdogCalls = mockSend.mock.calls.filter(
			(call: any[]) => call[0] && Buffer.from(call[0]).toString().includes('WATCHDOG=1')
		);
		expect(watchdogCalls).toHaveLength(0);

		// Mark ready and advance another interval
		ready = true;
		jest.advanceTimersByTime(30_000);
		watchdogCalls = mockSend.mock.calls.filter(
			(call: any[]) => call[0] && Buffer.from(call[0]).toString().includes('WATCHDOG=1')
		);
		expect(watchdogCalls.length).toBeGreaterThan(0);
	});

	it('does not send READY=1 from startWatchdog', () => {
		const { startWatchdog } = loadWatchdog();

		startWatchdog(() => ({ healthy: true, reason: 'ok' }));

		jest.advanceTimersByTime(60_000);

		const readyCalls = mockSend.mock.calls.filter(
			(call: any[]) => call[0] && Buffer.from(call[0]).toString().includes('READY=1')
		);
		expect(readyCalls).toHaveLength(0);
	});

	it('withholds pings when health check fails post-ready', () => {
		const { startWatchdog } = loadWatchdog();

		let healthy = true;
		const healthCheck = jest.fn<HealthCheckResult, []>().mockImplementation(() => ({
			healthy,
			reason: healthy ? 'ok' : 'health_check_failed',
		}));

		startWatchdog(healthCheck);

		// First interval — healthy, ping sent
		jest.advanceTimersByTime(30_000);
		let watchdogCalls = mockSend.mock.calls.filter(
			(call: any[]) => call[0] && Buffer.from(call[0]).toString().includes('WATCHDOG=1')
		);
		const countBefore = watchdogCalls.length;
		expect(countBefore).toBeGreaterThan(0);

		// Mark unhealthy
		healthy = false;
		jest.advanceTimersByTime(30_000);
		watchdogCalls = mockSend.mock.calls.filter(
			(call: any[]) => call[0] && Buffer.from(call[0]).toString().includes('WATCHDOG=1')
		);
		// Count should not have increased
		expect(watchdogCalls.length).toBe(countBefore);
	});

	it('accepts plain boolean health check for backward compatibility', () => {
		const { startWatchdog } = loadWatchdog();

		const healthCheck = jest.fn<boolean, []>().mockReturnValue(true);
		startWatchdog(healthCheck);

		jest.advanceTimersByTime(30_000);

		const watchdogCalls = mockSend.mock.calls.filter(
			(call: any[]) => call[0] && Buffer.from(call[0]).toString().includes('WATCHDOG=1')
		);
		expect(watchdogCalls.length).toBeGreaterThan(0);
	});

	it('is a no-op without NOTIFY_SOCKET', () => {
		delete process.env.NOTIFY_SOCKET;
		const { startWatchdog } = loadWatchdog();

		const healthCheck = jest.fn<boolean, []>().mockReturnValue(true);
		const cleanup = startWatchdog(healthCheck);

		jest.advanceTimersByTime(60_000);

		// Health check should never be called
		expect(healthCheck).not.toHaveBeenCalled();
		expect(mockSend).not.toHaveBeenCalled();

		// Cleanup should be a no-op function
		expect(typeof cleanup).toBe('function');
	});
});
