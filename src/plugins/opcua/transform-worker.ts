import { parentPort } from 'node:worker_threads';
import type { TransformLookups, WorkerInMessage } from './transform-shared.js';
import { buildPoint } from './transform-shared.js';

let lookups: TransformLookups = {
	normalizationNames: {},
	displayNames: {},
	resolvedDisplayNames: {},
	stableDeviceIds: {},
};

parentPort!.on('message', (msg: WorkerInMessage) => {
	switch (msg.type) {
		case 'sync':
			lookups = msg.lookups;
			break;
		case 'transform': {
			const points = new Array(msg.entries.length);
			for (let i = 0; i < msg.entries.length; i++) {
				points[i] = buildPoint(msg.entries[i], lookups);
			}
			parentPort!.postMessage({ type: 'result', batchId: msg.batchId, points });
			break;
		}
		case 'stop':
			process.exit(0);
	}
});

parentPort!.postMessage({ type: 'ready' });
