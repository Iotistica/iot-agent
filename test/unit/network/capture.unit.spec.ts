import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { CaptureEngine, CaptureInterfaceError } from '../../../src/network/capture';
import type { AgentLogger } from '../../../src/logging/agent-logger';

jest.mock('../../../src/system/interfaces', () => ({
	getNetworkInterfaces: jest.fn().mockResolvedValue([{ name: 'eth0' }]),
}));

function createLogger(): AgentLogger {
	return {
		debugSync: jest.fn(),
		infoSync: jest.fn(),
		warnSync: jest.fn(),
		errorSync: jest.fn(),
	} as unknown as AgentLogger;
}

function createChildProcess() {
	const proc = new EventEmitter() as EventEmitter & {
		stdout: PassThrough;
		stderr: PassThrough;
		exitCode: number | null;
		signalCode: NodeJS.Signals | null;
		kill: jest.Mock<boolean, [NodeJS.Signals]>;
	};
	proc.stdout = new PassThrough();
	proc.stderr = new PassThrough();
	proc.exitCode = null;
	proc.signalCode = null;
	proc.kill = jest.fn((signal: NodeJS.Signals) => {
		if (signal === 'SIGINT' || signal === 'SIGKILL') {
			setImmediate(() => {
				proc.exitCode = 0;
				proc.emit('close', 0, null);
			});
		}
		return true;
	});
	return proc;
}

function createPcapHeader(): Buffer {
	const header = Buffer.alloc(24);
	header.writeUInt32LE(0xa1b2c3d4, 0);
	header.writeUInt16LE(2, 4);
	header.writeUInt16LE(4, 6);
	header.writeUInt32LE(65535, 16);
	header.writeUInt32LE(101, 20);
	return header;
}

function createPcapRecords(start: number, count: number): Buffer {
	const records: Buffer[] = [];
	for (let index = 0; index < count; index++) {
		const payload = Buffer.alloc(20);
		payload[0] = 0x45;
		payload[8] = 64;
		payload[9] = 1;
		payload.set([192, 0, 2, 1], 12);
		payload.set([198, 51, 100, 1], 16);

		const record = Buffer.alloc(16);
		record.writeUInt32LE(start + index, 0);
		record.writeUInt32LE(0, 4);
		record.writeUInt32LE(payload.length, 8);
		record.writeUInt32LE(payload.length, 12);
		records.push(record, payload);
	}
	return Buffer.concat(records);
}

describe('CaptureEngine', () => {
	it('rejects an unavailable interface before spawning tcpdump', async () => {
		const engine = new CaptureEngine(createLogger());
		(engine as any)._available = true;
		const spawnProcess = jest.spyOn(engine as any, 'spawnCaptureProcess');

		await expect(engine.start({ iface: '__missing_capture_interface__' }))
			.rejects.toBeInstanceOf(CaptureInterfaceError);

		expect(spawnProcess).not.toHaveBeenCalled();
	});

	it('passes a discovered interface to tcpdump', async () => {
		const engine = new CaptureEngine(createLogger());
		(engine as any)._available = true;
		jest.spyOn(engine as any, 'resolveLocalIps').mockResolvedValue(undefined);
		const proc = createChildProcess();
		const spawnProcess = jest.spyOn(engine as any, 'spawnCaptureProcess').mockImplementation((args: string[]) => {
			expect(args.slice(0, 2)).toEqual(['-i', 'eth0']);
			setImmediate(() => proc.emit('spawn'));
			return proc;
		});

		await engine.start({ iface: 'eth0' });
		await engine.stop();

		expect(spawnProcess).toHaveBeenCalledTimes(1);
	});

	it('reports running only after spawn and waits for process close on stop', async () => {
		const engine = new CaptureEngine(createLogger());
		(engine as any)._available = true;
		jest.spyOn(engine as any, 'resolveLocalIps').mockResolvedValue(undefined);
		const proc = createChildProcess();
		jest.spyOn(engine as any, 'spawnCaptureProcess').mockImplementation(() => {
			setImmediate(() => proc.emit('spawn'));
			return proc;
		});

		const startPromise = engine.start({ iface: 'any' });
		expect(engine.getStatus().running).toBe(false);
		await expect(startPromise).resolves.toMatchObject({ running: true, iface: 'any' });

		await expect(engine.stop()).resolves.toMatchObject({ running: false, iface: 'any' });
		expect(proc.kill).toHaveBeenCalledWith('SIGINT');
	});

	it('switches interfaces without clearing packet history or the active BPF filter', async () => {
		const engine = new CaptureEngine(createLogger());
		const previousPacket = { id: 7 };
		(engine as any).state = 'running';
		(engine as any).captureIface = 'old0';
		(engine as any).captureFilter = 'tcp port 1883';
		(engine as any).packets = [previousPacket];
		jest.spyOn(engine as any, 'validateInterface').mockResolvedValue('eth0');
		jest.spyOn(engine as any, 'stopCapture').mockImplementation(async () => {
			(engine as any).state = 'idle';
			return engine.getStatus();
		});
		const startCapture = jest.spyOn(engine as any, 'startCapture').mockImplementation(async (options, preservePackets) => {
			(engine as any).captureIface = options.iface;
			(engine as any).state = 'running';
			expect(preservePackets).toBe(true);
			return engine.getStatus();
		});

		const status = await engine.switchInterface({ iface: 'eth0' });

		expect(status).toMatchObject({ running: true, iface: 'eth0', filter: 'tcp port 1883' });
		expect(startCapture).toHaveBeenCalledWith(
			expect.objectContaining({ iface: 'eth0', filter: 'tcp port 1883' }),
			true,
		);
		expect((engine as any).packets).toEqual([previousPacket]);
	});

	it('restarts the previous interface when a switch fails', async () => {
		const engine = new CaptureEngine(createLogger());
		(engine as any).state = 'running';
		(engine as any).captureIface = 'old0';
		(engine as any).captureFilter = 'tcp port 1883';
		const previousPacket = { id: 3 };
		(engine as any).packets = [previousPacket];
		jest.spyOn(engine as any, 'validateInterface').mockResolvedValue('eth0');
		jest.spyOn(engine as any, 'stopCapture').mockImplementation(async () => {
			(engine as any).state = 'idle';
			return engine.getStatus();
		});
		const startCapture = jest.spyOn(engine as any, 'startCapture')
			.mockImplementationOnce(async (options) => {
				(engine as any).captureIface = options.iface;
				throw new Error('interface disappeared');
			})
			.mockImplementationOnce(async (options) => {
				(engine as any).captureIface = options.iface;
				(engine as any).state = 'running';
				return engine.getStatus();
			});

		await expect(engine.switchInterface({ iface: 'eth0' })).rejects.toThrow('interface disappeared');

		expect(startCapture).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ iface: 'old0', filter: 'tcp port 1883' }),
			true,
		);
		expect(engine.getStatus()).toMatchObject({ running: true, iface: 'old0' });
		expect((engine as any).packets).toEqual([previousPacket]);
	});

	it('serializes rapid start, stop, and restart requests', async () => {
		const engine = new CaptureEngine(createLogger());
		(engine as any)._available = true;
		jest.spyOn(engine as any, 'resolveLocalIps').mockResolvedValue(undefined);
		const processes = [createChildProcess(), createChildProcess()];
		const spawnProcess = jest.spyOn(engine as any, 'spawnCaptureProcess').mockImplementation(() => {
			const proc = processes.shift()!;
			setImmediate(() => proc.emit('spawn'));
			return proc;
		});

		const starting = engine.start({ iface: 'any' });
		const stopping = engine.stop();
		const restarting = engine.start({ iface: 'eth0' });

		await Promise.all([starting, stopping, restarting]);

		expect(spawnProcess).toHaveBeenCalledTimes(2);
		expect(engine.getStatus()).toMatchObject({ running: true, iface: 'eth0' });
	});

	it('counts evictions separately and keeps the 10,000-packet retention cap', () => {
		const engine = new CaptureEngine(createLogger());
		const ingest = engine as any;

		ingest.onData(Buffer.concat([createPcapHeader(), createPcapRecords(1, 9999)]));
		expect(engine.getStatus().counters).toMatchObject({ seen: 9999, stored: 9999, evicted: 0, dropped: null });

		ingest.onData(createPcapRecords(10_000, 3));
		expect(engine.getStatus().counters).toMatchObject({ seen: 10_002, stored: 10_000, evicted: 2, dropped: null });
		expect(ingest.packets[0].id).toBe(3);

		engine.clear();
		expect(engine.getStatus().counters).toMatchObject({ seen: 0, stored: 0, evicted: 0, dropped: null });
	});

	it('reports kernel drops only when tcpdump provides a valid summary', async () => {
		const engine = new CaptureEngine(createLogger());
		(engine as any)._available = true;
		jest.spyOn(engine as any, 'resolveLocalIps').mockResolvedValue(undefined);
		const proc = createChildProcess();
		jest.spyOn(engine as any, 'spawnCaptureProcess').mockImplementation(() => {
			setImmediate(() => proc.emit('spawn'));
			return proc;
		});

		await engine.start({ iface: 'any' });
		expect(engine.getStatus().counters.dropped).toBeNull();
		proc.stderr.write('3 packets dropped by kernel\n');
		await engine.stop();
		expect(engine.getStatus().counters.dropped).toBe(3);

		await engine.start({ iface: 'any' });
		engine.clear();
		proc.stderr.write('5 packets dropped by kernel\n');
		await engine.stop();
		expect(engine.getStatus().counters).toMatchObject({ seen: 0, stored: 0, evicted: 0, dropped: null });

		await engine.start({ iface: 'any' });
		await engine.stop();
		expect(engine.getStatus().counters.dropped).toBeNull();
	});

	it('preserves packet counters and aggregates kernel drops across interface switches', async () => {
		const engine = new CaptureEngine(createLogger());
		(engine as any)._available = true;
		jest.spyOn(engine as any, 'resolveLocalIps').mockResolvedValue(undefined);
		const processes = [createChildProcess(), createChildProcess()];
		jest.spyOn(engine as any, 'spawnCaptureProcess').mockImplementation(() => {
			const proc = processes.shift()!;
			setImmediate(() => proc.emit('spawn'));
			return proc;
		});

		await engine.start({ iface: 'any' });
		(engine as any).counters = { seen: 12, stored: 2, evicted: 10, dropped: null, inbound: 5, outbound: 4, bytes: 1200 };
		const firstProcess = (engine as any).proc as ReturnType<typeof createChildProcess>;
		firstProcess.stderr.write('2 packets dropped by kernel\n');

		const switched = await engine.switchInterface({ iface: 'eth0' });
		expect(switched).toMatchObject({ running: true, iface: 'eth0' });
		expect(switched.counters).toMatchObject({ seen: 12, stored: 2, evicted: 10, dropped: null });

		const secondProcess = (engine as any).proc as ReturnType<typeof createChildProcess>;
		secondProcess.stderr.write('3 packets dropped by kernel\n');
		await engine.stop();
		expect(engine.getStatus().counters).toMatchObject({ seen: 12, stored: 2, evicted: 10, dropped: 5 });
	});
});