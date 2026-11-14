import { PrivateEvidenceRegistry } from '../../../src/points/private-evidence-registry';
import { canonicalizeAddress, type MqttAddressInput } from '../../../src/points/canonical-address';
import type { EvidenceResult, ObservationRef, SourceBindingRef } from '../../../src/points/private-evidence-types';

function value<T>(result: EvidenceResult<T>): T {
	if (result.status !== 'ok') throw new Error(result.reason);
	return result.value;
}

describe('private evidence registry', () => {
	let registry: PrivateEvidenceRegistry;
	let adapter: object;
	let configuration: object;
	let binding: SourceBindingRef;
	const address = { protocol: 'mqtt' as const, topic: 'factory/line' };

	beforeEach(() => {
		registry = new PrivateEvidenceRegistry();
		adapter = {};
		configuration = {};
		binding = value(registry.register({
			adapter, configuration, protocol: 'mqtt', claimedProtocol: 'mqtt', claimedEndpointUuid: 'source-1',
		})).ref;
	});

	afterEach(() => registry.dispose());

	function observe(point: object = {}): ObservationRef {
		return value(registry.observe(binding, adapter, configuration, point, address));
	}

	it('only creates proposals and rejects missing, mismatched and conflicting bindings', () => {
		const empty = new PrivateEvidenceRegistry();
		expect(empty.inspect({})).toEqual({ status: 'unresolved', reason: 'stale-observation' });
		expect(empty.register({ adapter, configuration, protocol: 'mqtt', claimedProtocol: 'mqtt' }))
			.toEqual({ status: 'unresolved', reason: 'source-missing' });
		expect(empty.register({ adapter, configuration, protocol: 'mqtt', claimedProtocol: 'modbus', claimedEndpointUuid: 'source' }))
			.toEqual({ status: 'unresolved', reason: 'protocol-mismatch' });
		expect(empty.register({ adapter, configuration, protocol: 'mqtt', claimedProtocol: 'mqtt', claimedEndpointUuid: 'source' }))
			.toMatchObject({ status: 'ok', value: { status: 'proposed' } });
		expect(empty.register({ adapter, configuration: {}, protocol: 'mqtt', claimedProtocol: 'mqtt', claimedEndpointUuid: 'source' }))
			.toEqual({ status: 'unresolved', reason: 'binding-conflict' });
		expect(empty.register({ adapter: {}, configuration, protocol: 'mqtt', claimedProtocol: 'mqtt', claimedEndpointUuid: 'other' }))
			.toEqual({ status: 'unresolved', reason: 'binding-conflict' });
		empty.dispose();
	});

	it('rejects forged references and wrong adapter, configuration or protocol', () => {
		expect(registry.observe({}, adapter, configuration, {}, address)).toMatchObject({ reason: 'stale-binding' });
		expect(registry.observe(binding, {}, configuration, {}, address)).toMatchObject({ reason: 'stale-binding' });
		expect(registry.observe(binding, adapter, {}, {}, address)).toMatchObject({ reason: 'stale-binding' });
		expect(registry.observe(binding, adapter, configuration, {}, { protocol: 'opcua', nodeId: 'i=85' }))
			.toMatchObject({ reason: 'protocol-mismatch' });
	});

	it('copies bounded Modbus decoder evidence without retaining extra input fields', () => {
		const modbusConfiguration = {};
		const modbus = value(registry.register({
			adapter, configuration: modbusConfiguration, protocol: 'modbus', claimedProtocol: 'modbus',
			claimedEndpointUuid: 'modbus-source',
		})).ref;
		const decoder = { dataType: 'string' as const, byteOrder: 'CDAB' as const, encoding: 'utf8' as const, extra: 'ignored' };
		const observed = { protocol: 'modbus' as const, unitId: 1, functionCode: 3, address: 10, count: 2, decoder };
		const ref = value(registry.observe(modbus, adapter, modbusConfiguration, {}, observed));
		decoder.extra = 'changed';
		const decision = registry.inspect(ref);
		expect(decision).toMatchObject({
			observed: { protocol: 'modbus', unitId: 1, functionCode: 3, address: 10, count: 2,
				decoder: { dataType: 'string', byteOrder: 'CDAB', encoding: 'utf8' } },
		});
		if (decision.status !== 'candidate-observed' || decision.observed.protocol !== 'modbus') throw new Error('Missing evidence');
		expect(decision.observed.decoder).toEqual({ dataType: 'string', byteOrder: 'CDAB', encoding: 'utf8' });
		expect(Object.isFrozen(decision.observed.decoder)).toBe(true);
		expect(registry.observe(modbus, adapter, modbusConfiguration, {}, {
			...observed, decoder: { ...decoder, encoding: 'invalid' as 'utf8' },
		})).toMatchObject({ reason: 'invalid-input' });
	});

	it('treats a canonical result and verification flags as claims, never authority', () => {
		const input: MqttAddressInput = {
			protocol: 'mqtt', topic: address.topic, selector: { kind: 'whole' }, selectorSource: 'observed',
		};
		const result = canonicalizeAddress(input);
		const point = { metric: 'x', value: 1 };
		const claims = {
			canonicalInput: input, canonicalResult: result, verified: true,
		};
		const ref = value(registry.observe(binding, adapter, configuration, point, address, claims));
		expect(result.status).toBe('resolved');
		expect(registry.inspect(ref)).toMatchObject({
			status: 'candidate-observed', claimedEndpointUuid: 'source-1', phase: 'constructed',
		});
		expect(point).toEqual({ metric: 'x', value: 1 });
	});

	it('uses exact object identity and explicitly transfers correlation to a clone', () => {
		const point = { metric: 'a', value: 1 };
		const sameValues = { ...point };
		const ref = observe(point);
		expect(registry.correlation(sameValues)).toMatchObject({ reason: 'correlation-missing' });
		expect(registry.transfer(point, sameValues)).toEqual({ status: 'ok', value: ref });
		expect(registry.correlation(sameValues)).toEqual({ status: 'ok', value: ref });
		expect(registry.transfer(point, sameValues)).toMatchObject({ reason: 'correlation-conflict' });
		expect(registry.observe(binding, adapter, configuration, point, address)).toMatchObject({ reason: 'correlation-conflict' });
		expect(point).toEqual({ metric: 'a', value: 1 });
		expect(sameValues).toEqual(point);
	});

	it('rejects transfer from missing or stale correlation and a conflicting clone', () => {
		const point = {};
		const clone = {};
		expect(registry.transfer(point, clone)).toMatchObject({ reason: 'correlation-missing' });
		observe(point);
		observe(clone);
		expect(registry.transfer(point, clone)).toMatchObject({ reason: 'correlation-conflict' });
		value(registry.replaceTransport(binding));
		expect(registry.transfer(point, {})).toMatchObject({ reason: 'stale-observation' });
	});

	it('invalidates observations on configuration replacement, including ABA', () => {
		const point = {};
		const ref = observe(point);
		const replacement = {};
		value(registry.replaceConfiguration(binding, replacement));
		expect(registry.inspect(ref)).toMatchObject({ reason: 'stale-observation' });
		value(registry.replaceConfiguration(binding, configuration));
		expect(registry.inspect(ref)).toMatchObject({ reason: 'stale-observation' });
		expect(registry.observe(binding, adapter, replacement, {}, address)).toMatchObject({ reason: 'stale-binding' });
		const current = observe();
		expect(registry.inspect(current)).toMatchObject({ status: 'candidate-observed', configGeneration: 3 });
	});

	it('invalidates on transport replacement, binding replacement, and adapter disposal', () => {
		const first = observe();
		value(registry.replaceTransport(binding));
		expect(registry.inspect(first)).toMatchObject({ reason: 'stale-observation' });
		const second = observe();
		value(registry.invalidateBinding(binding));
		expect(registry.inspect(second)).toMatchObject({ reason: 'stale-observation' });
		binding = value(registry.register({
			adapter, configuration, protocol: 'mqtt', claimedProtocol: 'mqtt', claimedEndpointUuid: 'source-1',
		})).ref;
		const third = observe();
		registry.disposeAdapter(adapter);
		registry.disposeAdapter(adapter);
		expect(registry.inspect(third)).toMatchObject({ reason: 'stale-observation' });
		expect(registry.observe(binding, adapter, configuration, {}, address)).toMatchObject({ reason: 'stale-binding' });
	});

	it('does not infer dispatch and cleans up or drops correlations explicitly', () => {
		const point = {};
		const clone = {};
		const ref = observe(point);
		value(registry.transfer(point, clone));
		expect(registry.inspect(ref)).toMatchObject({ phase: 'constructed' });
		value(registry.markDispatched(clone));
		expect(registry.inspect(ref)).toMatchObject({ phase: 'adapter-dispatched' });
		registry.cleanup(point);
		expect(registry.correlation(point)).toMatchObject({ reason: 'correlation-missing' });
		registry.drop(ref);
		expect(registry.correlation(clone)).toMatchObject({ reason: 'stale-observation' });
		expect(registry.inspect(ref)).toMatchObject({ reason: 'stale-observation' });
	});

	it('bounds proposals, copies raw address facts and disposes idempotently', () => {
		const limited = new PrivateEvidenceRegistry(1);
		const ref = value(limited.register({
			adapter, configuration, protocol: 'mqtt', claimedProtocol: 'mqtt', claimedEndpointUuid: 'source',
		})).ref;
		expect(limited.register({ adapter: {}, configuration: {}, protocol: 'mqtt', claimedProtocol: 'mqtt', claimedEndpointUuid: 'other' }))
			.toMatchObject({ reason: 'capacity' });
		const facts = { ...address };
		const observation = value(limited.observe(ref, adapter, configuration, {}, facts));
		facts.topic = 'changed';
		expect(limited.inspect(observation)).toMatchObject({ observed: address });
		expect(limited.observe(ref, adapter, configuration, {}, { ...address, topic: 'x'.repeat(8193) }))
			.toMatchObject({ reason: 'invalid-input' });
		limited.dispose();
		limited.dispose();
		expect(limited.inspect(observation)).toEqual({ status: 'unresolved', reason: 'disposed' });
		expect(limited.register({ adapter, configuration, protocol: 'mqtt', claimedProtocol: 'mqtt', claimedEndpointUuid: 'source' }))
			.toMatchObject({ reason: 'disposed' });
	});

	it('copies, freezes and bounds typed MQTT selectors without retaining payloads', () => {
		const tokens: Array<{ kind: 'key'; key: string } | { kind: 'index'; index: number }> = [
			{ kind: 'key', key: '0' }, { kind: 'index', index: 0 },
		];
		const observation = value(registry.observe(binding, adapter, configuration, {}, {
			...address, selector: { kind: 'path', tokens }, origin: 'configured',
		}));
		tokens[0] = { kind: 'key', key: 'changed' };
		tokens.push({ kind: 'key', key: 'later' });
		const decision = registry.inspect(observation);
		expect(decision).toMatchObject({
			observed: { ...address, selector: { kind: 'path', tokens: [
				{ kind: 'key', key: '0' }, { kind: 'index', index: 0 },
			] }, origin: 'configured' },
		});
		if (decision.status !== 'candidate-observed' || decision.observed.protocol !== 'mqtt' ||
			decision.observed.selector?.kind !== 'path') throw new Error('missing MQTT selector');
		expect(Object.isFrozen(decision.observed.selector.tokens)).toBe(true);
		expect(Object.isFrozen(decision.observed.selector.tokens[0])).toBe(true);
		expect(registry.observe(binding, adapter, configuration, {}, {
			...address, selector: { kind: 'path', tokens: Array(33).fill({ kind: 'key', key: 'x' }) }, origin: 'configured',
		})).toMatchObject({ reason: 'invalid-input' });
		expect(registry.observe(binding, adapter, configuration, {}, {
			...address, selector: { kind: 'path', tokens: [{ kind: 'key', key: 'x'.repeat(8192) }] }, origin: 'automatic',
		})).toMatchObject({ reason: 'invalid-input' });
		expect(registry.observe(binding, adapter, configuration, {}, {
			...address, selector: { kind: 'path', tokens: [{ kind: 'index', index: -1 }] }, origin: 'configured',
		})).toMatchObject({ reason: 'invalid-input' });
	});

	it('bounds outstanding observations and reclaims capacity on drop without breaking clone correlation', () => {
		const limited = new PrivateEvidenceRegistry(1, 2);
		const ref = value(limited.register({
			adapter, configuration, protocol: 'mqtt', claimedProtocol: 'mqtt', claimedEndpointUuid: 'source',
		})).ref;
		const original = {};
		const clone = {};
		const first = value(limited.observe(ref, adapter, configuration, original, address));
		value(limited.transfer(original, clone));
		const second = value(limited.observe(ref, adapter, configuration, {}, address));
		expect(limited.observe(ref, adapter, configuration, {}, address)).toMatchObject({ reason: 'capacity' });
		expect(limited.correlation(clone)).toEqual({ status: 'ok', value: first });
		limited.drop(first);
		expect(limited.correlation(clone)).toMatchObject({ reason: 'stale-observation' });
		limited.cleanup(clone);
		const replacement = value(limited.observe(ref, adapter, configuration, clone, address));
		expect(limited.correlation(clone)).toEqual({ status: 'ok', value: replacement });
		expect(limited.inspect(second)).toMatchObject({ status: 'candidate-observed' });
		const active = Reflect.get(limited, 'observations');
		expect(active).toHaveProperty('size', 2);
		limited.dispose();
		expect(active).toHaveProperty('size', 0);
		expect(limited.inspect(replacement)).toEqual({ status: 'unresolved', reason: 'disposed' });
		expect(limited.observe(ref, adapter, configuration, {}, address)).toMatchObject({ reason: 'disposed' });
	});

	it('reclaims capacity on repeated configuration and transport changes, including ABA', () => {
		const limited = new PrivateEvidenceRegistry(1, 1);
		const ref = value(limited.register({
			adapter, configuration, protocol: 'mqtt', claimedProtocol: 'mqtt', claimedEndpointUuid: 'source',
		})).ref;
		let current = configuration;
		const replacement = {};
		for (let i = 0; i < 10; i++) {
			const previous = value(limited.observe(ref, adapter, current, {}, address));
			current = current === configuration ? replacement : configuration;
			value(limited.replaceConfiguration(ref, current));
			expect(limited.inspect(previous)).toMatchObject({ reason: 'stale-observation' });
			const next = value(limited.observe(ref, adapter, current, {}, address));
			value(limited.replaceTransport(ref));
			expect(limited.inspect(next)).toMatchObject({ reason: 'stale-observation' });
		}
		expect(limited.observe(ref, adapter, current, {}, address).status).toBe('ok');
		limited.dispose();
	});

	it.each(['invalidation', 'adapter disposal'] as const)(
		'reclaims capacity after binding %s without releasing another binding',
		(action) => {
			const limited = new PrivateEvidenceRegistry(2, 2);
			const first = value(limited.register({
				adapter, configuration, protocol: 'mqtt', claimedProtocol: 'mqtt', claimedEndpointUuid: 'first',
			})).ref;
			const otherAdapter = {};
			const otherConfiguration = {};
			const second = value(limited.register({
				adapter: otherAdapter, configuration: otherConfiguration, protocol: 'mqtt',
				claimedProtocol: 'mqtt', claimedEndpointUuid: 'second',
			})).ref;
			const stale = value(limited.observe(first, adapter, configuration, {}, address));
			const preserved = value(limited.observe(second, otherAdapter, otherConfiguration, {}, address));
			if (action === 'invalidation') value(limited.invalidateBinding(first));
			else limited.disposeAdapter(adapter);
			expect(limited.inspect(stale)).toMatchObject({ reason: 'stale-observation' });
			expect(limited.inspect(preserved)).toMatchObject({ status: 'candidate-observed' });
			expect(limited.observe(second, otherAdapter, otherConfiguration, {}, address).status).toBe('ok');
			limited.dispose();
		},
	);

	it('validates the outstanding observation limit', () => {
		expect(() => new PrivateEvidenceRegistry(1, 0)).toThrow(RangeError);
		expect(() => new PrivateEvidenceRegistry(1, 8193)).toThrow(RangeError);
		expect(() => new PrivateEvidenceRegistry(1, Infinity)).toThrow(RangeError);
	});

	it('reclaims stale entries when a weakly held adapter is no longer available', () => {
		const limited = new PrivateEvidenceRegistry(2, 1);
		const first = value(limited.register({
			adapter, configuration, protocol: 'mqtt', claimedProtocol: 'mqtt', claimedEndpointUuid: 'first',
		})).ref;
		const otherAdapter = {};
		const otherConfiguration = {};
		const second = value(limited.register({
			adapter: otherAdapter, configuration: otherConfiguration, protocol: 'mqtt',
			claimedProtocol: 'mqtt', claimedEndpointUuid: 'second',
		})).ref;
		const stale = value(limited.observe(first, adapter, configuration, {}, address));
		const deref = WeakRef.prototype.deref;
		const spy = jest.spyOn(WeakRef.prototype, 'deref').mockImplementation(function (this: WeakRef<object>) {
			const target = deref.call(this);
			return target === adapter ? undefined : target;
		});
		try {
			expect(limited.observe(second, otherAdapter, otherConfiguration, {}, address).status).toBe('ok');
			expect(limited.inspect(stale)).toMatchObject({ reason: 'stale-observation' });
		} finally {
			spy.mockRestore();
			limited.dispose();
		}
	});

	it('loads and runs without importing the catalog, SQLite or UUID generation', () => {
		const catalog = jest.fn(() => { throw new Error('catalog must not be loaded'); });
		const sqlite = jest.fn(() => { throw new Error('SQLite must not be loaded'); });
		const crypto = jest.fn(() => { throw new Error('UUID generation must not be loaded'); });
		jest.doMock('../../../src/points/point-identity-catalog', catalog);
		jest.doMock('../../../src/db/sqlite', sqlite);
		jest.doMock('node:crypto', crypto);
		jest.isolateModules(() => {
			const { PrivateEvidenceRegistry: Registry } = jest.requireActual<{ PrivateEvidenceRegistry: typeof PrivateEvidenceRegistry }>(
				'../../../src/points/private-evidence-registry',
			);
			const isolated = new Registry();
			const proposed = value(isolated.register({
				adapter, configuration, protocol: 'mqtt', claimedProtocol: 'mqtt', claimedEndpointUuid: 'isolated',
			}));
			value(isolated.observe(proposed.ref, adapter, configuration, {}, address));
			isolated.dispose();
		});
		expect(catalog).not.toHaveBeenCalled();
		expect(sqlite).not.toHaveBeenCalled();
		expect(crypto).not.toHaveBeenCalled();
		jest.dontMock('../../../src/points/point-identity-catalog');
		jest.dontMock('../../../src/db/sqlite');
		jest.dontMock('node:crypto');
	});
});
