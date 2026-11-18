import { Worker } from 'node:worker_threads';
import path from 'node:path';
import type { DeviceDataPoint, Logger } from '../types.js';
import type { PrimitiveEntry, TransformLookups, TransformResponse } from './transform-shared.js';

interface PendingBatch {
	batchId: number;
	entries: PrimitiveEntry[];
	callback: (points: DeviceDataPoint[]) => void;
}

interface WorkerSlot {
	worker: Worker;
	busy: boolean;
}

export class TransformPool {
	private workers: WorkerSlot[] = [];
	private nextWorker = 0;
	private batchIdCounter = 0;
	private pending = new Map<number, PendingBatch>();
	private lookups: TransformLookups = {
		normalizationNames: {},
		displayNames: {},
		resolvedDisplayNames: {},
		stableDeviceIds: {},
	};
	private started = false;
	private stopping = false;

	constructor(
		private readonly poolSize: number,
		private readonly logger: Logger,
	) {}

	async start(): Promise<void> {
		if (this.started) return;
		const workerPath = path.join(__dirname, 'transform-worker.js');
		const readyPromises: Promise<void>[] = [];

		for (let i = 0; i < this.poolSize; i++) {
			const worker = new Worker(workerPath);
			const slot: WorkerSlot = { worker, busy: false };

			worker.on('message', (msg: TransformResponse) => {
				if (msg.type === 'result') {
					this.handleResult(msg.batchId, msg.points);
				}
			});

			worker.on('error', (err) => {
				this.logger.error(`Transform worker ${i} error: ${err.message}`);
				this.restartWorker(i);
			});

			worker.on('exit', (code) => {
				if (!this.stopping && code !== 0) {
					this.logger.warn(`Transform worker ${i} exited with code ${code}, restarting`);
					this.restartWorker(i);
				}
			});

			readyPromises.push(new Promise<void>((resolve) => {
				const onReady = (msg: { type: string }) => {
					if (msg.type === 'ready') {
						worker.removeListener('message', onReady);
						resolve();
					}
				};
				worker.on('message', onReady);
			}));

			this.workers.push(slot);
		}

		await Promise.all(readyPromises);
		this.started = true;
		this.logger.info(`Transform pool started with ${this.poolSize} workers`);
	}

	syncLookups(lookups: TransformLookups): void {
		this.lookups = lookups;
		for (const slot of this.workers) {
			slot.worker.postMessage({ type: 'sync', lookups });
		}
	}

	dispatch(entries: PrimitiveEntry[], callback: (points: DeviceDataPoint[]) => void): void {
		if (!this.started || entries.length === 0) {
			callback([]);
			return;
		}

		const batchId = this.batchIdCounter++;
		this.pending.set(batchId, { batchId, entries, callback });

		const slot = this.workers[this.nextWorker];
		this.nextWorker = (this.nextWorker + 1) % this.workers.length;
		slot.busy = true;
		slot.worker.postMessage({ type: 'transform', batchId, entries });
	}

	async stop(): Promise<void> {
		this.stopping = true;
		const exits = this.workers.map((slot) =>
			new Promise<void>((resolve) => {
				slot.worker.once('exit', () => resolve());
				slot.worker.postMessage({ type: 'stop' });
				setTimeout(() => {
					slot.worker.terminate().then(() => resolve()).catch(() => resolve());
				}, 3000);
			}),
		);
		await Promise.all(exits);
		this.workers = [];
		this.pending.clear();
		this.started = false;
		this.stopping = false;
	}

	private handleResult(batchId: number, points: DeviceDataPoint[]): void {
		const batch = this.pending.get(batchId);
		if (!batch) return;
		this.pending.delete(batchId);

		const workerIdx = this.workers.findIndex((s) => s.busy);
		if (workerIdx >= 0) this.workers[workerIdx].busy = false;

		batch.callback(points);
	}

	private restartWorker(index: number): void {
		if (this.stopping) return;
		const workerPath = path.join(__dirname, 'transform-worker.js');
		const worker = new Worker(workerPath);
		const slot: WorkerSlot = { worker, busy: false };

		worker.on('message', (msg: TransformResponse | { type: string }) => {
			if (msg.type === 'ready') {
				worker.postMessage({ type: 'sync', lookups: this.lookups });
				this.logger.info(`Transform worker ${index} restarted`);
			} else if (msg.type === 'result') {
				this.handleResult((msg as TransformResponse).batchId, (msg as TransformResponse).points);
			}
		});

		worker.on('error', (err) => {
			this.logger.error(`Transform worker ${index} error after restart: ${err.message}`);
			setTimeout(() => this.restartWorker(index), 1000);
		});

		worker.on('exit', (code) => {
			if (!this.stopping && code !== 0) {
				this.logger.warn(`Transform worker ${index} exited again (code ${code}), restarting in 1s`);
				setTimeout(() => this.restartWorker(index), 1000);
			}
		});

		this.workers[index] = slot;
	}
}
