import type { AddressProtocol } from './canonical-address.js';
import type {
	EvidenceReason, EvidenceResult, ObservedAddress, ObservationClaims, ObservationRef,
	ShadowDecision, SourceBindingProposal, SourceBindingRef,
} from './private-evidence-types.js';

interface Binding {
	ref: SourceBindingRef;
	adapter: WeakRef<object>;
	configuration: WeakRef<object>;
	protocol: AddressProtocol;
	claimedEndpointUuid: string;
	configGeneration: number;
	transportGeneration: number;
	active: boolean;
	observations: Set<ObservationRef>;
}

interface Observation {
	binding: Binding;
	configGeneration: number;
	transportGeneration: number;
	sequence: number;
	observed: ObservedAddress;
	phase: 'constructed' | 'adapter-dispatched';
	active: boolean;
}

const protocols = new Set<string>(['opcua', 'mqtt', 'modbus', 'bacnet']);
const maxAddressBytes = 8192;

function unresolved<T>(reason: EvidenceReason): EvidenceResult<T> {
	return { status: 'unresolved', reason };
}

function isObject(value: unknown): value is object {
	return typeof value === 'object' && value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return isObject(value) && !Array.isArray(value);
}

function copyObserved(observed: ObservedAddress): ObservedAddress | undefined {
	if (!isObject(observed)) return undefined;
	switch (observed.protocol) {
		case 'opcua':
			if (typeof observed.nodeId !== 'string' || Buffer.byteLength(observed.nodeId, 'utf8') > maxAddressBytes) return undefined;
			return Object.freeze({ protocol: 'opcua', nodeId: observed.nodeId });
		case 'mqtt': {
			if (typeof observed.topic !== 'string' || Buffer.byteLength(observed.topic, 'utf8') > maxAddressBytes) return undefined;
			if (observed.selector === undefined && observed.origin === undefined) {
				return Object.freeze({ protocol: 'mqtt', topic: observed.topic });
			}
			if (!isObject(observed.selector) ||
				!['configured', 'automatic', 'fallback'].includes(observed.origin ?? '')) return undefined;
			if (observed.selector.kind === 'whole') {
				const copy = { protocol: 'mqtt' as const, topic: observed.topic,
					selector: Object.freeze({ kind: 'whole' as const }), origin: observed.origin };
				return Buffer.byteLength(JSON.stringify(copy), 'utf8') <= maxAddressBytes ? Object.freeze(copy) : undefined;
			}
			if (observed.selector.kind !== 'path' || !Array.isArray(observed.selector.tokens) ||
				observed.selector.tokens.length === 0 || observed.selector.tokens.length > 32) return undefined;
			const tokens: Array<Readonly<{ kind: 'key'; key: string } | { kind: 'index'; index: number }>> = [];
			let bytes = Buffer.byteLength(observed.topic, 'utf8');
			for (const token of observed.selector.tokens) {
				if (!isRecord(token)) return undefined;
				if (token.kind === 'key' && typeof token.key === 'string') {
					bytes += Buffer.byteLength(token.key, 'utf8');
					if (bytes > maxAddressBytes) return undefined;
					tokens.push(Object.freeze({ kind: 'key', key: token.key }));
				} else if (token.kind === 'index' && typeof token.index === 'number' && Number.isSafeInteger(token.index) &&
					token.index >= 0 && token.index <= 4294967294) {
					tokens.push(Object.freeze({ kind: 'index', index: token.index }));
				} else return undefined;
			}
			const copy = { protocol: 'mqtt' as const, topic: observed.topic,
				selector: Object.freeze({ kind: 'path' as const, tokens: Object.freeze(tokens) }), origin: observed.origin };
			return Buffer.byteLength(JSON.stringify(copy), 'utf8') <= maxAddressBytes ? Object.freeze(copy) : undefined;
		}
		case 'modbus': {
			if (![observed.unitId, observed.functionCode, observed.address, observed.count].every(Number.isSafeInteger)) return undefined;
			const decoder = observed.decoder;
			if (decoder !== undefined) {
				if (!isRecord(decoder) || typeof decoder.dataType !== 'string') return undefined;
				if (decoder.dataType === 'boolean') {
					return Object.freeze({ protocol: 'modbus', unitId: observed.unitId, functionCode: observed.functionCode,
						address: observed.address, count: observed.count, decoder: Object.freeze({ dataType: 'boolean' }) });
				}
				if (!['ABCD', 'CDAB', 'BADC', 'DCBA'].includes(decoder.byteOrder)) return undefined;
				if (decoder.dataType === 'string') {
					if (!['ascii', 'utf8', 'utf-8', 'latin1', 'binary'].includes(decoder.encoding)) return undefined;
				} else if (!['int16', 'uint16', 'int32', 'uint32', 'float32'].includes(decoder.dataType)) return undefined;
				if (decoder.dataType === 'string') {
					return Object.freeze({ protocol: 'modbus', unitId: observed.unitId, functionCode: observed.functionCode,
						address: observed.address, count: observed.count,
						decoder: Object.freeze({ dataType: decoder.dataType, byteOrder: decoder.byteOrder, encoding: decoder.encoding }) });
				}
				return Object.freeze({ protocol: 'modbus', unitId: observed.unitId, functionCode: observed.functionCode,
					address: observed.address, count: observed.count,
					decoder: Object.freeze({ dataType: decoder.dataType, byteOrder: decoder.byteOrder }) });
			}
			return Object.freeze({
				protocol: 'modbus', unitId: observed.unitId, functionCode: observed.functionCode,
				address: observed.address, count: observed.count,
			});
		}
		case 'bacnet':
			if (![observed.objectType, observed.objectInstance, observed.propertyId].every(Number.isSafeInteger)) return undefined;
			return Object.freeze({
				protocol: 'bacnet', objectType: observed.objectType,
				objectInstance: observed.objectInstance, propertyId: observed.propertyId,
			});
		default: return undefined;
	}
}

/**
 * Tracks proposed bindings only. It cannot observe unreported lifecycle changes
 * and does not establish source ownership or production evidence freshness.
 */
export class PrivateEvidenceRegistry {
	private bindings = new WeakMap<SourceBindingRef, Binding>();
	private readonly observations = new Map<ObservationRef, Observation>();
	private correlations = new WeakMap<object, ObservationRef>();
	private byAdapter = new WeakMap<object, Set<Binding>>();
	private byConfiguration = new WeakMap<object, Binding>();
	private readonly bySource = new Map<string, Binding>();
	private sequence = 0;
	private disposed = false;

	constructor(private readonly maxBindings = 1024, private readonly maxObservations = 1024) {
		if (!Number.isSafeInteger(maxBindings) || maxBindings < 1) throw new RangeError('Invalid binding limit');
		if (!Number.isSafeInteger(maxObservations) || maxObservations < 1 || maxObservations > 8192) {
			throw new RangeError('Invalid observation limit');
		}
	}

	register(proposal: SourceBindingProposal): EvidenceResult<{ ref: SourceBindingRef; status: 'proposed' }> {
		if (this.disposed) return unresolved('disposed');
		if (!isObject(proposal) || !isObject(proposal.adapter) || !isObject(proposal.configuration) ||
			typeof proposal.protocol !== 'string' || !protocols.has(proposal.protocol)) return unresolved('invalid-input');
		if (proposal.protocol !== proposal.claimedProtocol) return unresolved('protocol-mismatch');
		if (typeof proposal.claimedEndpointUuid !== 'string' || !proposal.claimedEndpointUuid.trim() ||
			Buffer.byteLength(proposal.claimedEndpointUuid, 'utf8') > 1024) return unresolved('source-missing');
		if (this.bySource.has(proposal.claimedEndpointUuid) || this.byConfiguration.has(proposal.configuration)) {
			return unresolved('binding-conflict');
		}
		if (this.bySource.size >= this.maxBindings) return unresolved('capacity');
		const ref = Object.freeze({});
		const binding: Binding = {
			ref, adapter: new WeakRef(proposal.adapter), configuration: new WeakRef(proposal.configuration),
			protocol: proposal.protocol, claimedEndpointUuid: proposal.claimedEndpointUuid,
			configGeneration: 1, transportGeneration: 1, active: true, observations: new Set(),
		};
		this.bindings.set(ref, binding);
		this.bySource.set(binding.claimedEndpointUuid, binding);
		this.byConfiguration.set(proposal.configuration, binding);
		let members = this.byAdapter.get(proposal.adapter);
		if (!members) {
			members = new Set();
			this.byAdapter.set(proposal.adapter, members);
		}
		members.add(binding);
		return { status: 'ok', value: { ref, status: 'proposed' } };
	}

	private binding(ref: SourceBindingRef): Binding | undefined {
		if (this.disposed || !isObject(ref)) return undefined;
		const binding = this.bindings.get(ref);
		return binding?.active && binding.adapter.deref() && binding.configuration.deref() ? binding : undefined;
	}

	replaceConfiguration(ref: SourceBindingRef, configuration: object): EvidenceResult<void> {
		if (this.disposed) return unresolved('disposed');
		const binding = this.binding(ref);
		if (!binding) return unresolved('stale-binding');
		if (!isObject(configuration)) return unresolved('invalid-input');
		const existing = this.byConfiguration.get(configuration);
		if (existing && existing !== binding) return unresolved('binding-conflict');
		if (binding.configGeneration >= Number.MAX_SAFE_INTEGER) {
			this.removeBinding(binding);
			return unresolved('capacity');
		}
		const old = binding.configuration.deref();
		if (old) this.byConfiguration.delete(old);
		this.dropBindingObservations(binding);
		binding.configuration = new WeakRef(configuration);
		this.byConfiguration.set(configuration, binding);
		binding.configGeneration++;
		return { status: 'ok', value: undefined };
	}

	replaceTransport(ref: SourceBindingRef): EvidenceResult<void> {
		if (this.disposed) return unresolved('disposed');
		const binding = this.binding(ref);
		if (!binding) return unresolved('stale-binding');
		if (binding.transportGeneration >= Number.MAX_SAFE_INTEGER) {
			this.removeBinding(binding);
			return unresolved('capacity');
		}
		this.dropBindingObservations(binding);
		binding.transportGeneration++;
		return { status: 'ok', value: undefined };
	}

	invalidateBinding(ref: SourceBindingRef): EvidenceResult<void> {
		if (this.disposed) return unresolved('disposed');
		const binding = isObject(ref) ? this.bindings.get(ref) : undefined;
		if (!binding?.active) return unresolved('stale-binding');
		this.removeBinding(binding);
		return { status: 'ok', value: undefined };
	}

	private removeBinding(binding: Binding): void {
		binding.active = false;
		this.dropBindingObservations(binding);
		this.bySource.delete(binding.claimedEndpointUuid);
		const configuration = binding.configuration.deref();
		if (configuration) this.byConfiguration.delete(configuration);
		const adapter = binding.adapter.deref();
		if (adapter) this.byAdapter.get(adapter)?.delete(binding);
		this.bindings.delete(binding.ref);
	}

	private dropBindingObservations(binding: Binding): void {
		for (const ref of binding.observations) this.drop(ref);
	}

	disposeAdapter(adapter: object): void {
		if (this.disposed || !isObject(adapter)) return;
		const members = this.byAdapter.get(adapter);
		if (!members) return;
		for (const binding of members) this.removeBinding(binding);
		this.byAdapter.delete(adapter);
	}

	observe(
		ref: SourceBindingRef, adapter: object, configuration: object, point: object,
		observed: ObservedAddress, _claims?: ObservationClaims,
	): EvidenceResult<ObservationRef> {
		if (this.disposed) return unresolved('disposed');
		const binding = this.binding(ref);
		if (!binding) return unresolved('stale-binding');
		if (binding.adapter.deref() !== adapter || binding.configuration.deref() !== configuration) {
			return unresolved('stale-binding');
		}
		if (!isObject(point) || !isObject(observed)) return unresolved('invalid-input');
		if (binding.protocol !== observed.protocol) return unresolved('protocol-mismatch');
		const copy = copyObserved(observed);
		if (!copy) return unresolved('invalid-input');
		if (this.correlations.has(point)) return unresolved('correlation-conflict');
		if (this.sequence >= Number.MAX_SAFE_INTEGER) return unresolved('capacity');
		if (this.observations.size >= this.maxObservations) {
			for (const [candidate] of this.observations) {
				if (!this.observation(candidate)) this.drop(candidate);
			}
			if (this.observations.size >= this.maxObservations) return unresolved('capacity');
		}
		const observationRef = Object.freeze({});
		this.observations.set(observationRef, {
			binding, configGeneration: binding.configGeneration, transportGeneration: binding.transportGeneration,
			sequence: ++this.sequence, observed: copy, phase: 'constructed', active: true,
		});
		binding.observations.add(observationRef);
		this.correlations.set(point, observationRef);
		return { status: 'ok', value: observationRef };
	}

	private observation(ref: ObservationRef): Observation | undefined {
		if (this.disposed || !isObject(ref)) return undefined;
		const observation = this.observations.get(ref);
		if (!observation?.active || !this.binding(observation.binding.ref) ||
			observation.configGeneration !== observation.binding.configGeneration ||
			observation.transportGeneration !== observation.binding.transportGeneration) return undefined;
		return observation;
	}

	inspect(ref: ObservationRef): ShadowDecision {
		if (this.disposed) return { status: 'unresolved', reason: 'disposed' };
		const observation = this.observation(ref);
		if (!observation) return { status: 'unresolved', reason: 'stale-observation' };
		return {
			status: 'candidate-observed', protocol: observation.binding.protocol, observed: observation.observed,
			claimedEndpointUuid: observation.binding.claimedEndpointUuid,
			configGeneration: observation.configGeneration, transportGeneration: observation.transportGeneration,
			sequence: observation.sequence, phase: observation.phase,
		};
	}

	correlation(point: object): EvidenceResult<ObservationRef> {
		if (this.disposed) return unresolved('disposed');
		if (!isObject(point)) return unresolved('invalid-input');
		const ref = this.correlations.get(point);
		if (!ref) return unresolved('correlation-missing');
		if (!this.observation(ref)) return unresolved('stale-observation');
		return { status: 'ok', value: ref };
	}

	transfer(original: object, clone: object): EvidenceResult<ObservationRef> {
		if (!isObject(clone)) return unresolved('invalid-input');
		const result = this.correlation(original);
		if (result.status === 'unresolved') return result;
		if (this.correlations.has(clone)) return unresolved('correlation-conflict');
		this.correlations.set(clone, result.value);
		return result;
	}

	markDispatched(point: object): EvidenceResult<void> {
		const result = this.correlation(point);
		if (result.status === 'unresolved') return result;
		const observation = this.observation(result.value);
		if (!observation) return unresolved('stale-observation');
		observation.phase = 'adapter-dispatched';
		return { status: 'ok', value: undefined };
	}

	cleanup(point: object): void {
		if (isObject(point)) this.correlations.delete(point);
	}

	drop(ref: ObservationRef): void {
		if (!isObject(ref)) return;
		const observation = this.observations.get(ref);
		if (observation) {
			observation.active = false;
			observation.binding.observations.delete(ref);
		}
		this.observations.delete(ref);
	}

	dispose(): void {
		if (this.disposed) return;
		for (const binding of this.bySource.values()) this.removeBinding(binding);
		this.disposed = true;
		this.bindings = new WeakMap();
		this.observations.clear();
		this.correlations = new WeakMap();
		this.byAdapter = new WeakMap();
		this.byConfiguration = new WeakMap();
	}
}
