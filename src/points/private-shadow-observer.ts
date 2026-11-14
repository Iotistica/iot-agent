import { performance } from 'node:perf_hooks';
import type { PrivateEvidenceRegistry } from './private-evidence-registry.js';
import type { EvidenceResult, ObservationRef, ShadowMetadata } from './private-evidence-types.js';

export interface ShadowObserverLimits {
	maxQueue: number;
	maxMetadataBytes: number;
	maxBatch: number;
	maxLifetimeMs: number;
}

export interface ShadowObserverCounters {
	accepted: number;
	dropped: number;
	expired: number;
	stale: number;
	errors: number;
	processed: number;
}

export type ShadowCallback = (metadata: Readonly<ShadowMetadata>) => void | Promise<void>;

const defaults: ShadowObserverLimits = {
	maxQueue: 256, maxMetadataBytes: 512, maxBatch: 16, maxLifetimeMs: 5000,
};
const ceilings: ShadowObserverLimits = {
	maxQueue: 1024, maxMetadataBytes: 8192, maxBatch: 64, maxLifetimeMs: 60000,
};
const counterLimit = 0x7fffffff;

export class PrivateShadowObserver {
	private readonly limits: ShadowObserverLimits;
	private readonly counters: ShadowObserverCounters = {
		accepted: 0, dropped: 0, expired: 0, stale: 0, errors: 0, processed: 0,
	};
	private queue: Array<{ ref: ObservationRef; expires: number }> = [];
	private queued = new Set<ObservationRef>();
	private callback?: ShadowCallback;
	private scheduled?: NodeJS.Immediate;
	private expiryTimer?: NodeJS.Timeout;
	private inFlight?: Promise<void>;
	private disposed = false;
	private disposal?: Promise<void>;

	constructor(private readonly registry: PrivateEvidenceRegistry, limits: Partial<ShadowObserverLimits> = {}) {
		this.limits = { ...defaults, ...limits };
		for (const key of Object.keys(defaults) as Array<keyof ShadowObserverLimits>) {
			const value = this.limits[key];
			if (!Number.isSafeInteger(value) || value < 1 || value > ceilings[key]) {
				throw new RangeError(`Invalid shadow observer limit: ${key}`);
			}
		}
	}

	activate(callback: ShadowCallback): EvidenceResult<void> {
		if (this.disposed) return { status: 'unresolved', reason: 'disposed' };
		if (typeof callback !== 'function') return { status: 'unresolved', reason: 'invalid-input' };
		if (this.callback || this.inFlight) return { status: 'unresolved', reason: 'binding-conflict' };
		this.callback = callback;
		return { status: 'ok', value: undefined };
	}

	submit(ref: ObservationRef): EvidenceResult<void> {
		if (this.disposed) return { status: 'unresolved', reason: 'disposed' };
		if (!this.callback) return { status: 'unresolved', reason: 'disabled' };
		const decision = this.registry.inspect(ref);
		if (decision.status === 'unresolved') {
			this.increment('stale');
			return { status: 'unresolved', reason: decision.reason };
		}
		if (this.queued.has(ref)) return { status: 'unresolved', reason: 'correlation-conflict' };
		if (this.metadataSize(decision) > this.limits.maxMetadataBytes) {
			this.registry.drop(ref);
			this.increment('dropped');
			return { status: 'unresolved', reason: 'metadata-too-large' };
		}
		if (this.queue.length >= this.limits.maxQueue) {
			this.registry.drop(ref);
			this.increment('dropped');
			return { status: 'unresolved', reason: 'queue-full' };
		}
		this.queue.push({ ref, expires: performance.now() + this.limits.maxLifetimeMs });
		this.queued.add(ref);
		this.increment('accepted');
		this.scheduleExpiry();
		this.scheduleDrain();
		return { status: 'ok', value: undefined };
	}

	private metadata(decision: Extract<ReturnType<PrivateEvidenceRegistry['inspect']>, { status: 'candidate-observed' }>): ShadowMetadata {
		return Object.freeze({
			status: 'candidate-observed', protocol: decision.protocol,
			sequence: decision.sequence, phase: decision.phase,
		});
	}

	private metadataSize(decision: Extract<ReturnType<PrivateEvidenceRegistry['inspect']>, { status: 'candidate-observed' }>): number {
		return Buffer.byteLength(JSON.stringify({
			metadata: this.metadata(decision), observed: decision.observed, claimedEndpointUuid: decision.claimedEndpointUuid,
		}), 'utf8');
	}

	private increment(key: keyof ShadowObserverCounters): void {
		this.counters[key] = Math.min(counterLimit, this.counters[key] + 1);
	}

	getCounters(): Readonly<ShadowObserverCounters> {
		return Object.freeze({ ...this.counters });
	}

	private scheduleDrain(): void {
		if (!this.callback || this.disposed || this.scheduled || this.inFlight || !this.queue.length) return;
		this.scheduled = setImmediate(() => {
			this.scheduled = undefined;
			const work = Promise.resolve().then(() => this.drain());
			this.inFlight = work;
			void work.then(() => {
				this.inFlight = undefined;
				this.scheduleDrain();
			}, () => {
				this.increment('errors');
				this.inFlight = undefined;
				this.scheduleDrain();
			});
		});
	}

	private async drain(): Promise<void> {
		for (let count = 0; count < this.limits.maxBatch && this.callback && !this.disposed; count++) {
			const item = this.queue.shift();
			if (!item) break;
			if (performance.now() >= item.expires) {
				this.queued.delete(item.ref);
				this.registry.drop(item.ref);
				this.increment('expired');
				continue;
			}
			const decision = this.registry.inspect(item.ref);
			if (decision.status !== 'candidate-observed') {
				this.queued.delete(item.ref);
				this.registry.drop(item.ref);
				this.increment('stale');
				continue;
			}
			const metadata = this.metadata(decision);
			if (this.metadataSize(decision) > this.limits.maxMetadataBytes) {
				this.queued.delete(item.ref);
				this.registry.drop(item.ref);
				this.increment('dropped');
				continue;
			}
			try {
				await this.callback(metadata);
				this.increment('processed');
			} catch {
				this.increment('errors');
			} finally {
				this.queued.delete(item.ref);
				this.registry.drop(item.ref);
			}
		}
		this.scheduleExpiry();
	}

	private scheduleExpiry(): void {
		if (this.expiryTimer) clearTimeout(this.expiryTimer);
		this.expiryTimer = undefined;
		if (!this.callback || this.disposed || !this.queue.length) return;
		const delay = Math.max(1, Math.ceil(this.queue[0].expires - performance.now()));
		this.expiryTimer = setTimeout(() => {
			this.expiryTimer = undefined;
			const now = performance.now();
			while (this.queue.length && this.queue[0].expires <= now) {
				const item = this.queue.shift()!;
				this.queued.delete(item.ref);
				this.registry.drop(item.ref);
				this.increment('expired');
			}
			this.scheduleExpiry();
		}, delay);
		this.expiryTimer.unref();
	}

	deactivate(): void {
		this.callback = undefined;
		if (this.scheduled) clearImmediate(this.scheduled);
		if (this.expiryTimer) clearTimeout(this.expiryTimer);
		this.scheduled = undefined;
		this.expiryTimer = undefined;
		for (const item of this.queue) {
			this.registry.drop(item.ref);
			this.increment('dropped');
		}
		this.queue = [];
		this.queued.clear();
	}

	dispose(): Promise<void> {
		if (this.disposal) return this.disposal;
		this.disposed = true;
		this.deactivate();
		this.disposal = this.inFlight ?? Promise.resolve();
		return this.disposal;
	}
}
