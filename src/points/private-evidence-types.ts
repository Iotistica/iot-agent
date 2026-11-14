import type { AddressProtocol, CanonicalAddressInput, CanonicalAddressResult, MqttSelector } from './canonical-address.js';

export type SourceBindingRef = object;
export type ObservationRef = object;

export type ModbusDecoder =
	| Readonly<{ dataType: 'boolean' }>
	| Readonly<{
		dataType: 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32';
		byteOrder: 'ABCD' | 'CDAB' | 'BADC' | 'DCBA';
	}>
	| Readonly<{
		dataType: 'string';
		byteOrder: 'ABCD' | 'CDAB' | 'BADC' | 'DCBA';
		encoding: 'ascii' | 'utf8' | 'utf-8' | 'latin1' | 'binary';
	}>;

export type ObservedAddress =
	| Readonly<{ protocol: 'opcua'; nodeId: string }>
	| Readonly<{ protocol: 'mqtt'; topic: string; selector?: MqttSelector; origin?: 'configured' | 'automatic' | 'fallback' }>
	| Readonly<{ protocol: 'modbus'; unitId: number; functionCode: number; address: number; count: number; decoder?: ModbusDecoder }>
	| Readonly<{ protocol: 'bacnet'; objectType: number; objectInstance: number; propertyId: number }>;

export interface SourceBindingProposal {
	adapter: object;
	configuration: object;
	protocol: AddressProtocol;
	claimedProtocol: AddressProtocol;
	claimedEndpointUuid?: string;
}

export interface ObservationClaims {
	canonicalInput?: CanonicalAddressInput;
	canonicalResult?: CanonicalAddressResult;
}

export type EvidenceReason =
	| 'disposed' | 'source-missing' | 'protocol-mismatch' | 'invalid-input'
	| 'binding-conflict' | 'capacity' | 'stale-binding' | 'stale-observation'
	| 'correlation-missing' | 'correlation-conflict' | 'disabled'
	| 'queue-full' | 'metadata-too-large';

export type EvidenceResult<T> =
	| { status: 'ok'; value: T }
	| { status: 'unresolved'; reason: EvidenceReason };

export type ShadowDecision =
	| { status: 'unresolved'; reason: EvidenceReason }
	| {
		status: 'candidate-observed';
		protocol: AddressProtocol;
		observed: ObservedAddress;
		claimedEndpointUuid: string;
		configGeneration: number;
		transportGeneration: number;
		sequence: number;
		phase: 'constructed' | 'adapter-dispatched';
	};

export interface ShadowMetadata {
	readonly status: 'candidate-observed';
	readonly protocol: AddressProtocol;
	readonly sequence: number;
	readonly phase: 'constructed' | 'adapter-dispatched';
}
