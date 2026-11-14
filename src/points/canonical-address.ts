/**
 * Version 1 keys are scoped externally by endpoint UUID and protocol. A future
 * version must reconcile existing addresses before allowing new identities.
 */
export const CANONICAL_ADDRESS_VERSION = 1 as const;
export const MAX_CANONICAL_ADDRESS_BYTES = 8192;

export type AddressProtocol = 'opcua' | 'mqtt' | 'modbus' | 'bacnet';
export type ModbusAddressSpace = 'coil' | 'discrete' | 'holding' | 'input';
export type UnresolvedReason =
	| 'unsupported-protocol'
	| 'invalid-input'
	| 'address-too-large'
	| 'invalid-node-id'
	| 'unsupported-expanded-node-id'
	| 'namespace-evidence-required'
	| 'invalid-namespace-array'
	| 'ambiguous-namespace'
	| 'namespace-index-unresolved'
	| 'invalid-topic'
	| 'invalid-selector'
	| 'ambiguous-legacy-selector'
	| 'invalid-unit-id'
	| 'invalid-address'
	| 'invalid-address-space'
	| 'conflicting-address-space'
	| 'invalid-projection'
	| 'ambiguous-projection'
	| 'inventory-incomplete'
	| 'too-many-candidates'
	| 'invalid-device-instance'
	| 'ambiguous-network-scope'
	| 'invalid-object-type'
	| 'invalid-object-instance'
	| 'invalid-property'
	| 'unsupported-array-selector';

export type MqttSelector =
	| { kind: 'whole' }
	| { kind: 'path'; tokens: readonly ({ kind: 'key'; key: string } | { kind: 'index'; index: number })[] };

export interface OpcuaAddressInput {
	protocol: 'opcua';
	nodeId: string;
	namespaceArray: { verified: true; uris: readonly string[] };
	nodeIdVerifiedAgainstNamespaceArray: true;
}
export interface MqttAddressInput {
	protocol: 'mqtt';
	topic: string;
	selector: MqttSelector;
	selectorSource: 'configured' | 'observed';
}
export interface ModbusAddressInput {
	protocol: 'modbus';
	unitId: number;
	address: number;
	type?: ModbusAddressSpace;
	functionCode?: 1 | 2 | 3 | 4;
	projection: {
		dataType: 'boolean' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'string';
		count: number;
		byteOrder?: 'ABCD' | 'CDAB' | 'BADC' | 'DCBA';
		endianness?: 'big' | 'little';
		encoding?: 'ascii' | 'utf8' | 'utf-8' | 'latin1' | 'binary';
		scale?: number;
		offset?: number;
	};
}
export interface BacnetAddressInput {
	protocol: 'bacnet';
	deviceInstance: number;
	networkScope: { uniqueDeviceInstance: true; source: 'configured' | 'observed' };
	objectType: string | number;
	objectInstance: number;
	propertyId?: number;
	arraySelector?: { kind: 'whole' };
}
export type CanonicalAddressInput = OpcuaAddressInput | MqttAddressInput | ModbusAddressInput | BacnetAddressInput;

export type AddressProvenance =
	| { protocol: 'opcua'; namespaceUri: string; namespaceIndex: number; namespaceArrayVerified: true; nodeIdVerifiedAgainstNamespaceArray: true; identifierType: 'i' | 's' | 'g' | 'b' }
	| { protocol: 'mqtt'; topic: string; selector: MqttSelector; selectorSource: 'configured' | 'observed' }
	| { protocol: 'modbus'; unitId: number; addressSpace: ModbusAddressSpace; functionCode: number; dataType: string; count: number; projectionComparison: 'not-compared' | 'complete-inventory' }
	| { protocol: 'bacnet'; deviceInstance: number; networkScope: 'configured' | 'observed'; objectType: number; objectInstance: number; propertyId: number; propertySource: 'configured' | 'default'; arraySelector: 'whole' };

export type CanonicalAddressResult =
	| { status: 'resolved'; protocol: AddressProtocol; version: typeof CANONICAL_ADDRESS_VERSION; addressKey: string; provenance: AddressProvenance }
	| { status: 'unresolved'; protocol: string; reason: UnresolvedReason; details?: { conflictingCandidateIndexes?: number[]; invalidCandidateIndexes?: number[] } };

type RecordValue = Record<string, unknown>;

const OPCUA_NAMESPACE_ZERO = 'http://opcfoundation.org/UA/';
const modbusSpaces = ['coil', 'discrete', 'holding', 'input'] as const;
const modbusTypes = new Set(['boolean', 'int16', 'uint16', 'int32', 'uint32', 'float32', 'string']);
const projectionFields = new Set(['dataType', 'count', 'byteOrder', 'endianness', 'encoding', 'scale', 'offset']);
const bacnetTypes: Readonly<Record<string, number>> = {
	'analog-input': 0, 'analog-output': 1, 'analog-value': 2,
	'binary-input': 3, 'binary-output': 4, 'binary-value': 5,
	'multi-state-input': 13, 'multi-state-output': 14, 'multi-state-value': 19,
};
const bacnetTypeNumbers = new Set(Object.values(bacnetTypes));
const guidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function record(value: unknown): value is RecordValue {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown, min: number, max: number): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function validText(value: unknown, allowEmpty = false): value is string {
	return typeof value === 'string' && (allowEmpty || value.length > 0) &&
		Buffer.byteLength(value, 'utf8') <= MAX_CANONICAL_ADDRESS_BYTES &&
		!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}

function unresolved(protocol: string, reason: UnresolvedReason, details?: { conflictingCandidateIndexes?: number[]; invalidCandidateIndexes?: number[] }): CanonicalAddressResult {
	return details ? { status: 'unresolved', protocol, reason, details } : { status: 'unresolved', protocol, reason };
}

function resolved(protocol: AddressProtocol, parts: readonly unknown[], provenance: AddressProvenance): CanonicalAddressResult {
	const addressKey = JSON.stringify(parts);
	if (Buffer.byteLength(addressKey, 'utf8') > MAX_CANONICAL_ADDRESS_BYTES) return unresolved(protocol, 'address-too-large');
	return { status: 'resolved', protocol, version: CANONICAL_ADDRESS_VERSION, addressKey, provenance };
}

function opcua(input: RecordValue): CanonicalAddressResult {
	const protocol = 'opcua';
	if (typeof input.nodeId !== 'string') return unresolved(protocol, 'invalid-node-id');
	if (Buffer.byteLength(input.nodeId, 'utf8') > MAX_CANONICAL_ADDRESS_BYTES) return unresolved(protocol, 'address-too-large');
	if (/^(?:svr|nsu)=/.test(input.nodeId)) return unresolved(protocol, 'unsupported-expanded-node-id');
	const nodeId = guidPattern.test(input.nodeId) ? `g=${input.nodeId}` : input.nodeId;
	const match = /^(?:ns=(\d+);)?([isgb])=([\s\S]*)$/.exec(nodeId);
	if (!match) return unresolved(protocol, 'invalid-node-id');
	const namespaceIndex = Number(match[1] ?? '0');
	if (!integer(namespaceIndex, 0, 65535)) return unresolved(protocol, 'invalid-node-id');
	if (!record(input.namespaceArray) || input.namespaceArray.verified !== true ||
		input.nodeIdVerifiedAgainstNamespaceArray !== true || !Array.isArray(input.namespaceArray.uris)) {
		return unresolved(protocol, 'namespace-evidence-required');
	}
	const uris: unknown[] = input.namespaceArray.uris;
	if (uris.length === 0 || uris.length > 65536 || uris[0] !== OPCUA_NAMESPACE_ZERO) {
		return unresolved(protocol, 'invalid-namespace-array');
	}
	let totalBytes = 0;
	const seen = new Set<string>();
	for (const uri of uris) {
		if (!validText(uri) || !/^[a-z][a-z0-9+.-]*:/i.test(uri) || !URL.canParse(uri) ||
			[...uri].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127) ||
			/%(?![0-9a-f]{2})/i.test(uri)) {
			return unresolved(protocol, 'invalid-namespace-array');
		}
		totalBytes += Buffer.byteLength(uri, 'utf8');
		if (totalBytes > 65536) return unresolved(protocol, 'address-too-large');
		if (seen.has(uri)) return unresolved(protocol, 'ambiguous-namespace');
		seen.add(uri);
	}
	const namespaceUri = uris[namespaceIndex];
	if (typeof namespaceUri !== 'string') return unresolved(protocol, 'namespace-index-unresolved');
	const identifier = match[3];
	let value: number | string;
	switch (match[2]) {
		case 'i': {
			if (!/^\d+$/.test(identifier)) return unresolved(protocol, 'invalid-node-id');
			const numeric = Number(identifier);
			if (!integer(numeric, 0, 4294967295) || (namespaceIndex === 0 && numeric === 0)) return unresolved(protocol, 'invalid-node-id');
			value = numeric;
			break;
		}
		case 's':
			if (!validText(identifier, true)) return unresolved(protocol, 'invalid-node-id');
			if (/;namespaceUri:|;serverIndex:\d+$/.test(identifier)) return unresolved(protocol, 'unsupported-expanded-node-id');
			if ((namespaceIndex === 0 && identifier.length === 0) ||
				Array.from(identifier).some((character) => {
					const code = character.codePointAt(0);
					return code !== undefined && (code <= 31 || (code >= 127 && code <= 159));
				})) return unresolved(protocol, 'invalid-node-id');
			if (Array.from(identifier).length > 4096) return unresolved(protocol, 'address-too-large');
			value = identifier;
			break;
		case 'g':
			if (!guidPattern.test(identifier) ||
				(namespaceIndex === 0 && identifier === '00000000-0000-0000-0000-000000000000')) return unresolved(protocol, 'invalid-node-id');
			value = identifier.toLowerCase();
			break;
		case 'b': {
			if (identifier === '') {
				if (namespaceIndex === 0) return unresolved(protocol, 'invalid-node-id');
				value = '';
				break;
			}
			if (!/^[A-Za-z0-9+/]+={0,2}$/.test(identifier)) return unresolved(protocol, 'invalid-node-id');
			const bytes = Buffer.from(identifier, 'base64');
			if (bytes.length > 4096) return unresolved(protocol, 'address-too-large');
			const encoded = bytes.toString('base64');
			if (encoded.replace(/=+$/, '') !== identifier.replace(/=+$/, '') ||
				(identifier.includes('=') && identifier !== encoded)) return unresolved(protocol, 'invalid-node-id');
			value = encoded;
			break;
		}
		default: return unresolved(protocol, 'invalid-node-id');
	}
	const identifierType = match[2];
	return resolved(protocol, [namespaceUri, identifierType, value],
		{ protocol, namespaceUri, namespaceIndex, namespaceArrayVerified: true, nodeIdVerifiedAgainstNamespaceArray: true, identifierType });
}

function mqtt(input: RecordValue): CanonicalAddressResult {
	const protocol = 'mqtt';
	if (typeof input.topic === 'string' && Buffer.byteLength(input.topic, 'utf8') > MAX_CANONICAL_ADDRESS_BYTES) {
		return unresolved(protocol, 'address-too-large');
	}
	if (!validText(input.topic) || /[+#\0]/.test(input.topic)) return unresolved(protocol, 'invalid-topic');
	if (typeof input.selector === 'string' || typeof input.field === 'string') return unresolved(protocol, 'ambiguous-legacy-selector');
	if (!record(input.selector) || (input.selectorSource !== 'configured' && input.selectorSource !== 'observed')) {
		return unresolved(protocol, 'invalid-selector');
	}
	let selector: MqttSelector;
	let selectorParts: readonly unknown[];
	if (input.selector.kind === 'whole' && Object.keys(input.selector).length === 1) {
		selector = { kind: 'whole' };
		selectorParts = ['whole'];
	} else if (input.selector.kind === 'path' && Array.isArray(input.selector.tokens) &&
		input.selector.tokens.length > 0 && input.selector.tokens.length <= 64 && Object.keys(input.selector).length === 2) {
		const tokens: Array<{ kind: 'key'; key: string } | { kind: 'index'; index: number }> = [];
		const parts: Array<readonly [string, string | number]> = [];
		for (const token of input.selector.tokens) {
			if (!record(token)) return unresolved(protocol, 'invalid-selector');
			if (token.kind === 'key' && Object.keys(token).length === 2 && validText(token.key, true)) {
				tokens.push({ kind: 'key', key: token.key });
				parts.push(['key', token.key]);
			} else if (token.kind === 'index' && Object.keys(token).length === 2 && integer(token.index, 0, 4294967294)) {
				tokens.push({ kind: 'index', index: token.index });
				parts.push(['index', token.index]);
			} else return unresolved(protocol, 'invalid-selector');
		}
		selector = { kind: 'path', tokens };
		selectorParts = ['path', parts];
	} else return unresolved(protocol, 'invalid-selector');
	return resolved(protocol, [input.topic, selectorParts], { protocol, topic: input.topic, selector, selectorSource: input.selectorSource });
}

function modbus(input: RecordValue): CanonicalAddressResult {
	const protocol = 'modbus';
	if (!integer(input.unitId, 1, 247)) return unresolved(protocol, 'invalid-unit-id');
	if (!integer(input.address, 0, 65535)) return unresolved(protocol, 'invalid-address');
	const typeIndex = typeof input.type === 'string' ? modbusSpaces.indexOf(input.type.toLowerCase() as typeof modbusSpaces[number]) : -1;
	if (input.type !== undefined && typeIndex < 0) return unresolved(protocol, 'invalid-address-space');
	if (input.functionCode !== undefined && !integer(input.functionCode, 1, 4)) return unresolved(protocol, 'invalid-address-space');
	if (input.type === undefined && input.functionCode === undefined) return unresolved(protocol, 'invalid-address-space');
	if (input.type !== undefined && input.functionCode !== undefined && typeIndex + 1 !== input.functionCode) {
		return unresolved(protocol, 'conflicting-address-space');
	}
	const functionCode = typeof input.functionCode === 'number' ? input.functionCode : typeIndex + 1;
	const addressSpace = modbusSpaces[functionCode - 1];
	if (!record(input.projection) || typeof input.projection.dataType !== 'string' ||
		Object.keys(input.projection).some((field) => !projectionFields.has(field)) ||
		!modbusTypes.has(input.projection.dataType) || !integer(input.projection.count, 1, 125) ||
		input.address + input.projection.count > 65536 ||
		((functionCode <= 2) !== (input.projection.dataType === 'boolean')) ||
		(['int32', 'uint32', 'float32'].includes(input.projection.dataType) && input.projection.count < 2) ||
		(input.projection.byteOrder !== undefined && (typeof input.projection.byteOrder !== 'string' || !['ABCD', 'CDAB', 'BADC', 'DCBA'].includes(input.projection.byteOrder))) ||
		(input.projection.endianness !== undefined && (typeof input.projection.endianness !== 'string' || !['big', 'little'].includes(input.projection.endianness))) ||
		(input.projection.encoding !== undefined && (typeof input.projection.encoding !== 'string' || !['ascii', 'utf8', 'utf-8', 'latin1', 'binary'].includes(input.projection.encoding))) ||
		(input.projection.scale !== undefined && (typeof input.projection.scale !== 'number' || !Number.isFinite(input.projection.scale))) ||
		(input.projection.offset !== undefined && (typeof input.projection.offset !== 'number' || !Number.isFinite(input.projection.offset)))) {
		return unresolved(protocol, 'invalid-projection');
	}
	return resolved(protocol, [input.unitId, addressSpace, input.address], {
		protocol, unitId: input.unitId, addressSpace, functionCode,
		dataType: input.projection.dataType, count: input.projection.count, projectionComparison: 'not-compared',
	});
}

/**
 * Pass the complete same-source configuration to detect overlapping readings.
 * Even identical overlapping projections are unresolved: equal decoding does
 * not prove that two configured readings are the same logical point.
 */
export function canonicalizeModbusAddresses(inputs: readonly ModbusAddressInput[], inventory: { complete: true }): CanonicalAddressResult[] {
	if (inventory?.complete !== true) return inputs.map(() => unresolved('modbus', 'inventory-incomplete'));
	if (inputs.length > 1024) return inputs.map(() => unresolved('modbus', 'too-many-candidates'));
	const results = inputs.map((input) => record(input) && input.protocol === 'modbus'
		? canonicalizeAddress(input) : unresolved('modbus', 'invalid-input'));
	const invalidCandidateIndexes = results.flatMap((result, index) => result.status === 'unresolved' ? [index] : []);
	if (invalidCandidateIndexes.length > 0) {
		return results.map((result) => result.status === 'resolved'
			? unresolved('modbus', 'ambiguous-projection', { invalidCandidateIndexes }) : result);
	}
	const conflicts = new Map<number, number[]>();
	for (let left = 0; left < inputs.length; left++) {
		for (let right = left + 1; right < inputs.length; right++) {
			const a = results[left];
			const b = results[right];
			if (a.status !== 'resolved' || b.status !== 'resolved' || a.provenance.protocol !== 'modbus' || b.provenance.protocol !== 'modbus') continue;
			if (a.provenance.unitId === b.provenance.unitId && a.provenance.addressSpace === b.provenance.addressSpace &&
				inputs[left].address < inputs[right].address + b.provenance.count &&
				inputs[right].address < inputs[left].address + a.provenance.count) {
				conflicts.set(left, [...(conflicts.get(left) ?? []), right]);
				conflicts.set(right, [...(conflicts.get(right) ?? []), left]);
			}
		}
	}
	return results.map((result, index) => {
		if (conflicts.has(index)) return unresolved('modbus', 'ambiguous-projection', { conflictingCandidateIndexes: conflicts.get(index) });
		if (result.status === 'resolved' && result.provenance.protocol === 'modbus') {
			return { ...result, provenance: { ...result.provenance, projectionComparison: 'complete-inventory' } };
		}
		return result;
	});
}

function bacnet(input: RecordValue): CanonicalAddressResult {
	const protocol = 'bacnet';
	if (!integer(input.deviceInstance, 0, 4194303)) return unresolved(protocol, 'invalid-device-instance');
	if (!record(input.networkScope) || input.networkScope.uniqueDeviceInstance !== true ||
		(input.networkScope.source !== 'configured' && input.networkScope.source !== 'observed')) {
		return unresolved(protocol, 'ambiguous-network-scope');
	}
	const objectType = typeof input.objectType === 'string' && Object.hasOwn(bacnetTypes, input.objectType)
		? bacnetTypes[input.objectType] : input.objectType;
	if (typeof objectType !== 'number' || !bacnetTypeNumbers.has(objectType)) return unresolved(protocol, 'invalid-object-type');
	if (!integer(input.objectInstance, 0, 4194303)) return unresolved(protocol, 'invalid-object-instance');
	const propertySource = Object.hasOwn(input, 'propertyId') ? 'configured' : 'default';
	const propertyId = propertySource === 'default' ? 85 : input.propertyId;
	if (!integer(propertyId, 1, 4194303)) return unresolved(protocol, 'invalid-property');
	if (Object.hasOwn(input, 'arrayIndex') || (Object.hasOwn(input, 'arraySelector') &&
		(!record(input.arraySelector) || input.arraySelector.kind !== 'whole' || Object.keys(input.arraySelector).length !== 1))) {
		return unresolved(protocol, 'unsupported-array-selector');
	}
	return resolved(protocol, [input.deviceInstance, objectType, input.objectInstance, propertyId, ['whole']], {
		protocol, deviceInstance: input.deviceInstance, networkScope: input.networkScope.source,
		objectType, objectInstance: input.objectInstance, propertyId, propertySource, arraySelector: 'whole',
	});
}

export function canonicalizeAddress(input: CanonicalAddressInput): CanonicalAddressResult;
export function canonicalizeAddress(input: unknown): CanonicalAddressResult;
export function canonicalizeAddress(input: unknown): CanonicalAddressResult {
	if (!record(input)) return unresolved('unknown', 'invalid-input');
	switch (input.protocol) {
		case 'opcua': return opcua(input);
		case 'mqtt': return mqtt(input);
		case 'modbus': return modbus(input);
		case 'bacnet': return bacnet(input);
		default: return unresolved('unknown', 'unsupported-protocol');
	}
}
