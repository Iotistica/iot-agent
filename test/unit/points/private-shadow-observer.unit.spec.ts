import { EventEmitter } from 'node:events';
import { PrivateEvidenceRegistry } from '../../../src/points/private-evidence-registry';
import { PrivateShadowObserver } from '../../../src/points/private-shadow-observer';
import type { EvidenceResult, ObservationRef, SourceBindingRef } from '../../../src/points/private-evidence-types';

function value<T>(result: EvidenceResult<T>): T {
	if (result.status !== 'ok') throw new Error(result.reason);
	return result.value;
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe('private shadow observer', () => {
	let registry: PrivateEvidenceRegistry;
	let observer: PrivateShadowObserver;
	let adapter: object;
	let configuration: object;
	let binding: SourceBindingRef;

	beforeEach(() => {
		registry = new PrivateEvidenceRegistry();
		adapter = {};
		configuration = {};
		binding = value(registry.register({
			adapter, configuration, protocol: 'mqtt', claimedProtocol: 'mqtt', claimedEndpointUuid: 'source',
		})).ref;
		observer = new PrivateShadowObserver(registry);
	});

	afterEach(async () => {
		await observer.dispose();
		registry.dispose();
		jest.useRealTimers();
	});

	function observe(point: object = {}): ObservationRef {
		return value(registry.observe(binding, adapter, configuration, point, { protocol: 'mqtt', topic: 'topic' }));
	}

	it('is disabled by default and does not change legacy event objects', async () => {
		const point = { metric: 'x', value: 1, timestamp: 't' };
		const event = [point];
		const emitter = new EventEmitter();
		const listener = jest.fn();
		emitter.on('data', listener);
		expect(observer.submit(observe(point))).toMatchObject({ reason: 'disabled' });
		emitter.emit('data', event);
		await tick();
		expect(listener).toHaveBeenCalledWith([{ metric: 'x', value: 1, timestamp: 't' }]);
		expect(listener.mock.calls[0][0]).toBe(event);
		expect(observer.getCounters()).toMatchObject({ accepted: 0, processed: 0 });
	});

	it('processes immutable minimal metadata, not point values or source claims', async () => {
		const callback = jest.fn();
		value(observer.activate(callback));
		const point = { metric: 'secret', value: 999 };
		const ref = observe(point);
		value(observer.submit(ref));
		await tick();
		await tick();
		expect(callback).toHaveBeenCalledTimes(1);
		const metadata = callback.mock.calls[0][0];
		expect(metadata).toEqual({ status: 'candidate-observed', protocol: 'mqtt', sequence: 1, phase: 'constructed' });
		expect(Object.isFrozen(metadata)).toBe(true);
		expect(point).toEqual({ metric: 'secret', value: 999 });
		expect(registry.inspect(ref)).toMatchObject({ reason: 'stale-observation' });
	});

	it('bounds queue, drops only excess shadow evidence and rejects duplicate submissions', async () => {
		observer = new PrivateShadowObserver(registry, { maxQueue: 1 });
		const callback = jest.fn();
		value(observer.activate(callback));
		const first = observe();
		const second = observe();
		value(observer.submit(first));
		expect(observer.submit(first)).toMatchObject({ reason: 'correlation-conflict' });
		expect(observer.submit(second)).toMatchObject({ reason: 'queue-full' });
		expect(registry.inspect(second)).toMatchObject({ reason: 'stale-observation' });
		await tick();
		await tick();
		expect(callback).toHaveBeenCalledTimes(1);
		expect(observer.getCounters()).toMatchObject({ accepted: 1, dropped: 1, processed: 1 });
	});

	it.each([
		['throw', () => { throw new Error('test'); }],
		['reject', () => Promise.reject(new Error('test'))],
	])('isolates callback %s and records the error', async (_label, callback) => {
		value(observer.activate(callback));
		const ref = observe();
		value(observer.submit(ref));
		await tick();
		await tick();
		expect(observer.getCounters()).toMatchObject({ errors: 1, processed: 0 });
		expect(registry.inspect(ref)).toMatchObject({ reason: 'stale-observation' });
	});

	it('rejects oversized metadata instead of truncating it', () => {
		observer = new PrivateShadowObserver(registry, { maxMetadataBytes: 1 });
		value(observer.activate(jest.fn()));
		const ref = observe();
		expect(observer.submit(ref)).toMatchObject({ reason: 'metadata-too-large' });
		expect(registry.inspect(ref)).toMatchObject({ reason: 'stale-observation' });
		expect(observer.getCounters().dropped).toBe(1);
	});

	it('bounds retained address facts as well as callback metadata', () => {
		value(observer.activate(jest.fn()));
		const ref = value(registry.observe(binding, adapter, configuration, {}, {
			protocol: 'mqtt', topic: 'x'.repeat(600),
		}));
		expect(observer.submit(ref)).toMatchObject({ reason: 'metadata-too-large' });
		expect(registry.inspect(ref)).toMatchObject({ reason: 'stale-observation' });
	});

	it('rechecks freshness when processing queued observations', async () => {
		const callback = jest.fn();
		value(observer.activate(callback));
		const ref = observe();
		value(observer.submit(ref));
		value(registry.replaceTransport(binding));
		await tick();
		await tick();
		expect(callback).not.toHaveBeenCalled();
		expect(observer.getCounters().stale).toBe(1);
	});

	it('expires queued observations even if a callback never settles until released', async () => {
		let release!: () => void;
		const pending = new Promise<void>(resolve => { release = resolve; });
		observer = new PrivateShadowObserver(registry, { maxLifetimeMs: 20 });
		const callback = jest.fn(() => pending);
		value(observer.activate(callback));
		value(observer.submit(observe()));
		await tick();
		const queued = observe();
		value(observer.submit(queued));
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		expect(observer.getCounters().expired).toBe(1);
		expect(registry.inspect(queued)).toMatchObject({ reason: 'stale-observation' });
		release();
		await tick();
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('drops scheduled work on disposal and cannot be reactivated', async () => {
		const callback = jest.fn();
		value(observer.activate(callback));
		const ref = observe();
		value(observer.submit(ref));
		const first = observer.dispose();
		expect(observer.dispose()).toBe(first);
		await first;
		await tick();
		expect(callback).not.toHaveBeenCalled();
		expect(registry.inspect(ref)).toMatchObject({ reason: 'stale-observation' });
		expect(observer.submit(observe())).toMatchObject({ reason: 'disposed' });
		expect(observer.activate(callback)).toMatchObject({ reason: 'disposed' });
	});

	it('waits for an in-flight callback before disposal completes and cancels queued work', async () => {
		let release!: () => void;
		const pending = new Promise<void>(resolve => { release = resolve; });
		const callback = jest.fn(() => pending);
		value(observer.activate(callback));
		value(observer.submit(observe()));
		await tick();
		const queued = observe();
		value(observer.submit(queued));
		let disposed = false;
		const completion = observer.dispose().then(() => { disposed = true; });
		await tick();
		expect(disposed).toBe(false);
		expect(registry.inspect(queued)).toMatchObject({ reason: 'stale-observation' });
		release();
		await completion;
		await tick();
		expect(callback).toHaveBeenCalledTimes(1);
		expect(disposed).toBe(true);
	});

	it.each(['resolve', 'reject'] as const)(
		'prevents reactivation until the previous callback can %s',
		async (outcome) => {
			let settle!: () => void;
			const pending = new Promise<void>((resolve, reject) => {
				settle = outcome === 'resolve' ? resolve : () => reject(new Error('old callback'));
			});
			const previous = jest.fn(() => pending);
			const next = jest.fn();
			value(observer.activate(previous));
			value(observer.submit(observe()));
			await tick();
			observer.deactivate();
			expect(observer.activate(next)).toMatchObject({ status: 'unresolved', reason: 'binding-conflict' });
			const newRef = observe();
			expect(observer.submit(newRef)).toMatchObject({ reason: 'disabled' });
			settle();
			await tick();
			value(observer.activate(next));
			value(observer.submit(newRef));
			await tick();
			await tick();
			expect(previous).toHaveBeenCalledTimes(1);
			expect(next).toHaveBeenCalledTimes(1);
			if (outcome === 'reject') expect(observer.getCounters().errors).toBe(1);
		},
	);

	it('cancels its scheduled immediate and expiry timer on disposal', async () => {
		jest.useFakeTimers();
		const callback = jest.fn();
		value(observer.activate(callback));
		value(observer.submit(observe()));
		expect(jest.getTimerCount()).toBe(2);
		await observer.dispose();
		expect(jest.getTimerCount()).toBe(0);
		jest.runAllTimers();
		expect(callback).not.toHaveBeenCalled();
	});

	it('rejects invalid limits rather than silently permitting unbounded work', () => {
		expect(() => new PrivateShadowObserver(registry, { maxQueue: 1025 })).toThrow(RangeError);
		expect(() => new PrivateShadowObserver(registry, { maxBatch: 0 })).toThrow(RangeError);
		expect(() => new PrivateShadowObserver(registry, { maxLifetimeMs: Infinity })).toThrow(RangeError);
	});
});
