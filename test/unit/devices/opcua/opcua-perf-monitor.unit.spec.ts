import { OpcuaPerfMonitor } from '../../../../src/plugins/opcua/perf-monitor';

function createLogger() {
	const messages: string[] = [];
	return {
		messages,
		debug: jest.fn(),
		info: jest.fn((msg: string) => messages.push(msg)),
		warn: jest.fn(),
		error: jest.fn(),
	};
}

describe('OpcuaPerfMonitor', () => {
	let monitor: OpcuaPerfMonitor;
	let logger: ReturnType<typeof createLogger>;

	beforeEach(() => {
		jest.useFakeTimers();
		logger = createLogger();
		monitor = new OpcuaPerfMonitor(logger);
	});

	afterEach(() => {
		monitor.stop();
		jest.useRealTimers();
	});

	it('reports accurate received and emitted counts per endpoint', () => {
		monitor.start();
		monitor.recordReceived('PLC1', 100);
		monitor.recordReceived('PLC1', 50);
		monitor.recordEmitted('PLC1', 140);
		monitor.recordReceived('PLC2', 200);
		monitor.recordEmitted('PLC2', 200);

		jest.advanceTimersByTime(30_000);

		const plc1Line = logger.messages.find(m => m.includes('endpoint=PLC1'));
		expect(plc1Line).toBeDefined();
		expect(plc1Line).toContain('received=5/s');
		expect(plc1Line).toContain('emitted=5/s');

		const plc2Line = logger.messages.find(m => m.includes('endpoint=PLC2'));
		expect(plc2Line).toBeDefined();
		expect(plc2Line).toContain('received=7/s');
		expect(plc2Line).toContain('emitted=7/s');
	});

	it('reports correct batch duration statistics', () => {
		monitor.start();
		for (const d of [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100]) {
			monitor.recordBatchDuration('PLC1', d);
		}

		jest.advanceTimersByTime(30_000);

		const line = logger.messages.find(m => m.includes('endpoint=PLC1'));
		expect(line).toBeDefined();
		expect(line).toContain('batches=20');
		expect(line).toContain('p95=95ms');
		expect(line).toContain('max=100ms');
	});

	it('reports event-loop utilization delta', () => {
		monitor.start();

		jest.advanceTimersByTime(30_000);

		const elLine = logger.messages.find(m => m.includes('[perf] event-loop'));
		expect(elLine).toBeDefined();
		expect(elLine).toMatch(/utilization=\d+%/);
		expect(elLine).toMatch(/delay_p95=\d+ms/);
		expect(elLine).toMatch(/delay_p99=\d+ms/);
		expect(elLine).toMatch(/delay_max=\d+ms/);
	});

	it('resets counters between reporting intervals', () => {
		monitor.start();
		monitor.recordReceived('PLC1', 300);
		monitor.recordEmitted('PLC1', 300);
		monitor.recordBatchDuration('PLC1', 10);

		jest.advanceTimersByTime(30_000);
		logger.messages.length = 0;

		jest.advanceTimersByTime(30_000);

		const plc1Line = logger.messages.find(m => m.includes('endpoint=PLC1'));
		expect(plc1Line).toBeUndefined();

		const elLine = logger.messages.find(m => m.includes('[perf] event-loop'));
		expect(elLine).toBeDefined();
	});

	it('does not create duplicate reporting timers on repeated start()', () => {
		monitor.start();
		monitor.start();
		monitor.start();

		monitor.recordReceived('PLC1', 30);
		monitor.recordEmitted('PLC1', 30);
		monitor.recordBatchDuration('PLC1', 5);

		jest.advanceTimersByTime(30_000);

		const endpointLines = logger.messages.filter(m => m.includes('endpoint=PLC1'));
		expect(endpointLines).toHaveLength(1);
	});

	it('cleans up on stop and produces no further reports', () => {
		monitor.start();
		monitor.recordReceived('PLC1', 100);
		monitor.stop();

		logger.messages.length = 0;
		jest.advanceTimersByTime(60_000);

		expect(logger.messages).toHaveLength(0);
	});

	it('skips endpoints with zero activity', () => {
		monitor.start();
		monitor.recordReceived('PLC1', 10);
		monitor.recordEmitted('PLC1', 10);
		monitor.recordBatchDuration('PLC1', 1);
		// PLC2 registered but no activity

		jest.advanceTimersByTime(30_000);

		const plc2Line = logger.messages.find(m => m.includes('endpoint=PLC2'));
		expect(plc2Line).toBeUndefined();
	});
});
