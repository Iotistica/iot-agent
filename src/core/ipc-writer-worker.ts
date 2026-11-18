import { parentPort, workerData } from 'node:worker_threads';
import { SocketServer } from './socket-server.js';
import type { DeviceDataPoint, SocketOutput } from '../plugins/types.js';

interface WorkerMessage {
	type: 'data' | 'control' | 'stop';
	points?: DeviceDataPoint[];
	payload?: Record<string, unknown>;
	topic?: string;
}

const config: SocketOutput = workerData.config;

const logger = {
	debug: (msg: string, ...args: unknown[]) => parentPort?.postMessage({ type: 'log', level: 'debug', msg, args }),
	info: (msg: string, ...args: unknown[]) => parentPort?.postMessage({ type: 'log', level: 'info', msg, args }),
	warn: (msg: string, ...args: unknown[]) => parentPort?.postMessage({ type: 'log', level: 'warn', msg, args }),
	error: (msg: string, ...args: unknown[]) => parentPort?.postMessage({ type: 'log', level: 'error', msg, args }),
};

const server = new SocketServer(config, logger);

server.start().then(() => {
	parentPort?.postMessage({ type: 'ready' });
}).catch((err) => {
	parentPort?.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
});

parentPort?.on('message', (msg: WorkerMessage) => {
	switch (msg.type) {
		case 'data':
			if (msg.points) {
				server.sendData(msg.points, msg.topic);
			}
			break;
		case 'control':
			if (msg.payload) {
				server.sendControl(msg.payload, msg.topic);
			}
			break;
		case 'stop':
			server.stop().then(() => {
				parentPort?.postMessage({ type: 'stopped' });
				process.exit(0);
			}).catch(() => {
				process.exit(1);
			});
			break;
	}
});
