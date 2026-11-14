import {
	CANONICAL_ADDRESS_VERSION, MAX_CANONICAL_ADDRESS_BYTES,
	canonicalizeAddress, canonicalizeModbusAddresses,
	type BacnetAddressInput, type ModbusAddressInput, type MqttAddressInput, type OpcuaAddressInput,
} from '../../../src/points/canonical-address';
import { DatabaseSync } from 'node:sqlite';
import { coerceNodeId, ExpandedNodeId, NodeId, NodeIdType } from 'node-opcua-nodeid';
import { normalizeModbusRegisters } from '../../../src/plugins/modbus/types';

const namespaces = { verified: true as const, uris: ['http://opcfoundation.org/UA/', 'urn:other', 'urn:plant'] };
const opcua: OpcuaAddressInput = {
	protocol: 'opcua', nodeId: 'ns=2;s=Temperature', namespaceArray: namespaces, nodeIdVerifiedAgainstNamespaceArray: true,
};
const mqtt: MqttAddressInput = { protocol: 'mqtt', topic: 'factory/line1', selector: { kind: 'whole' }, selectorSource: 'observed' };
const modbus: ModbusAddressInput = {
	protocol: 'modbus', unitId: 1, address: 10, type: 'holding',
	projection: { dataType: 'uint16', count: 1 },
};
const bacnet: BacnetAddressInput = {
	protocol: 'bacnet', deviceInstance: 42, networkScope: { uniqueDeviceInstance: true, source: 'observed' },
	objectType: 'analog-input', objectInstance: 7,
};

function key(input: unknown): string {
	const result = canonicalizeAddress(input);
	if (result.status !== 'resolved') throw new Error(`Unexpected unresolved address: ${result.reason}`);
	return result.addressKey;
}

function expectReason(input: unknown, reason: string): void {
	expect(canonicalizeAddress(input)).toMatchObject({ status: 'unresolved', reason });
}

describe('canonical address v1', () => {
	it('uses deterministic fixed-order arrays and ignores display names and physical identifiers', () => {
		const first = canonicalizeAddress(mqtt);
		const reordered = canonicalizeAddress({
			device_uuid: 'unrelated', endpointName: 'renamed', selectorSource: 'configured',
			selector: { kind: 'whole' }, topic: 'factory/line1', protocol: 'mqtt', name: 'changed',
		});
		expect(first).toMatchObject({
			status: 'resolved', protocol: 'mqtt', version: CANONICAL_ADDRESS_VERSION,
			addressKey: '["factory/line1",["whole"]]',
		});
		expect(first.status).toBe('resolved');
		expect(reordered.status).toBe('resolved');
		if (first.status === 'resolved' && reordered.status === 'resolved') expect(reordered.addressKey).toBe(first.addressKey);
		expect(CANONICAL_ADDRESS_VERSION).toBe(1);
		expectReason({ protocol: 's7' }, 'unsupported-protocol');
		expect(canonicalizeAddress({ protocol: 'secret-token', password: 'secret' }))
			.toEqual({ status: 'unresolved', protocol: 'unknown', reason: 'unsupported-protocol' });
		expectReason(null, 'invalid-input');
	});

	it('bounds input and serialized key sizes', () => {
		expectReason({ ...mqtt, topic: 'x'.repeat(MAX_CANONICAL_ADDRESS_BYTES + 1) }, 'address-too-large');
		expectReason({ ...mqtt, topic: '"'.repeat(5000) }, 'address-too-large');
		expectReason({ ...mqtt, topic: '\ud800' }, 'invalid-topic');
	});

	it('stores generated keys as nonempty binary-exact SQLite text', () => {
		const db = new DatabaseSync(':memory:');
		try {
			db.exec('CREATE TABLE addresses (address_key TEXT NOT NULL COLLATE BINARY UNIQUE)');
			const insert = db.prepare('INSERT INTO addresses (address_key) VALUES (?)');
			const keys = [key(mqtt), key({ ...mqtt, topic: 'Factory/line1' }), key(opcua), key(modbus), key(bacnet)];
			for (const address of keys) insert.run(address);
			expect(db.prepare('SELECT address_key FROM addresses ORDER BY rowid').all().map(row => row.address_key)).toEqual(keys);
		} finally {
			db.close();
		}
	});
});

describe('OPC UA', () => {
	it.each([
		['ns=2;i=00123', '["urn:plant","i",123]'],
		['ns=2;s=Temperature', '["urn:plant","s","Temperature"]'],
		['ns=2;g=ABCDEF12-1234-ABCD-9876-1234567890AB', '["urn:plant","g","abcdef12-1234-abcd-9876-1234567890ab"]'],
		['ns=2;b=AQIDBA', '["urn:plant","b","AQIDBA=="]'],
		['i=85', '["http://opcfoundation.org/UA/","i",85]'],
	])('canonicalizes %s', (nodeId, expected) => {
		expect(key({ ...opcua, nodeId })).toBe(expected);
		expect(canonicalizeAddress({ ...opcua, nodeId })).toMatchObject({
			status: 'resolved', provenance: { namespaceUri: nodeId === 'i=85' ? namespaces.uris[0] : 'urn:plant', namespaceArrayVerified: true },
		});
	});

	it('survives namespace remapping without folding case or identifier types', () => {
		const moved = { verified: true, uris: ['http://opcfoundation.org/UA/', 'urn:other', 'urn:new', 'urn:more', 'urn:plant'] };
		expect(key({ ...opcua, nodeId: 'ns=4;s=Temperature', namespaceArray: moved })).toBe(key(opcua));
		expect(key({ ...opcua, nodeId: 'ns=2;s=temperature' })).not.toBe(key(opcua));
		expect(key({ ...opcua, nodeId: 'ns=2;i=123' })).not.toBe(key({ ...opcua, nodeId: 'ns=2;s=123' }));
	});

	it('rejects ambiguous library ExpandedNodeId strings rather than conflating remote and local nodes', () => {
		const remote = new ExpandedNodeId(NodeIdType.STRING, 'motor', 2, null, 1).toString();
		const local = new NodeId(NodeIdType.STRING, 'motor;serverIndex:1', 2).toString();
		expect(remote).toBe(local);
		expectReason({ ...opcua, nodeId: remote }, 'unsupported-expanded-node-id');
		expectReason({ ...opcua, nodeId: local }, 'unsupported-expanded-node-id');
		expectReason({ ...opcua, nodeId: new ExpandedNodeId(NodeIdType.STRING, 'motor', 2, 'urn:remote', 0).toString() }, 'unsupported-expanded-node-id');
		expect(key({ ...opcua, nodeId: 'ns=2;s=motor;section' })).toBe('["urn:plant","s","motor;section"]');
	});

	it('handles library GUID and empty opaque NodeId representations without accepting null NodeIds', () => {
		const guid = 'ABCDEF12-1234-ABCD-9876-1234567890AB';
		expect(coerceNodeId(guid).toString()).toBe(`ns=0;g=${guid}`);
		expect(key({ ...opcua, nodeId: guid })).toBe(key({ ...opcua, nodeId: `ns=0;g=${guid}` }));
		const empty = new NodeId(NodeIdType.BYTESTRING, Buffer.alloc(0), 2).toString();
		expect(empty).toBe('ns=2;b=');
		expect(key({ ...opcua, nodeId: empty })).toBe('["urn:plant","b",""]');
		expect(key({ ...opcua, nodeId: 'ns=2;s=' })).toBe('["urn:plant","s",""]');
		expect(key({ ...opcua, nodeId: 'ns=2;g=00000000-0000-0000-0000-000000000000' })).toBe('["urn:plant","g","00000000-0000-0000-0000-000000000000"]');
		expectReason({ ...opcua, nodeId: 'ns=0;b=' }, 'invalid-node-id');
		expectReason({ ...opcua, nodeId: 's=' }, 'invalid-node-id');
		expectReason({ ...opcua, nodeId: 'g=00000000-0000-0000-0000-000000000000' }, 'invalid-node-id');
	});

	it('rejects forbidden NodeId control characters and oversized identifiers', () => {
		expectReason({ ...opcua, nodeId: 'ns=2;s=A\0B' }, 'invalid-node-id');
		expectReason({ ...opcua, nodeId: 'ns=2;s=A\u0085B' }, 'invalid-node-id');
		expectReason({ ...opcua, nodeId: `ns=2;s=${'x'.repeat(4097)}` }, 'address-too-large');
		expectReason({ ...opcua, nodeId: `ns=2;b=${Buffer.alloc(4097).toString('base64')}` }, 'address-too-large');
		expect(key({ ...opcua, nodeId: `ns=2;s=${'x'.repeat(4096)}` })).toContain('x'.repeat(4096));
		const opaque = Buffer.alloc(4096).toString('base64');
		expect(key({ ...opcua, nodeId: `ns=2;b=${opaque}` })).toContain(opaque);
	});

	it.each([
		[{ ...opcua, namespaceArray: undefined }, 'namespace-evidence-required'],
		[{ ...opcua, nodeIdVerifiedAgainstNamespaceArray: false }, 'namespace-evidence-required'],
		[{ ...opcua, namespaceArray: { verified: false, uris: namespaces.uris } }, 'namespace-evidence-required'],
		[{ ...opcua, namespaceArray: { verified: true, uris: ['urn:wrong', 'urn:other', 'urn:plant'] } }, 'invalid-namespace-array'],
		[{ ...opcua, namespaceArray: { verified: true, uris: ['http://opcfoundation.org/UA/', 'not a uri'] } }, 'invalid-namespace-array'],
		[{ ...opcua, namespaceArray: { verified: true, uris: [...namespaces.uris, 'urn:plant'] } }, 'ambiguous-namespace'],
		[{ ...opcua, nodeId: 'ns=4;i=1' }, 'namespace-index-unresolved'],
		[{ ...opcua, nodeId: 'ns=65536;i=1' }, 'invalid-node-id'],
		[{ ...opcua, nodeId: 'svr=1;ns=2;i=1' }, 'unsupported-expanded-node-id'],
		[{ ...opcua, nodeId: 'nsu=urn:plant;i=1' }, 'unsupported-expanded-node-id'],
		[{ ...opcua, nodeId: 'ns=2;i=123junk' }, 'invalid-node-id'],
		[{ ...opcua, nodeId: 'ns=2;i=4294967296' }, 'invalid-node-id'],
		[{ ...opcua, nodeId: 'i=0' }, 'invalid-node-id'],
		[{ ...opcua, nodeId: 'ns=2;b=bad!' }, 'invalid-node-id'],
		[{ ...opcua, nodeId: 'ns=2;b=A===' }, 'invalid-node-id'],
		[{ ...opcua, nodeId: 'ns=2;g=not-a-guid' }, 'invalid-node-id'],
	])('rejects invalid or unverified input: %s', (input, reason) => expectReason(input, reason));
});

describe('MQTT', () => {
	it('distinguishes scalar, typed paths, literal dots, array indexes and topics', () => {
		const cases: Array<[unknown, string]> = [
			[mqtt, '["factory/line1",["whole"]]'],
			[{ ...mqtt, selector: { kind: 'path', tokens: [{ kind: 'key', key: 'value' }] } }, '["factory/line1",["path",[["key","value"]]]]'],
			[{ ...mqtt, selector: { kind: 'path', tokens: [{ kind: 'key', key: 'motor' }, { kind: 'key', key: 'speed' }] } }, '["factory/line1",["path",[["key","motor"],["key","speed"]]]]'],
			[{ ...mqtt, selector: { kind: 'path', tokens: [{ kind: 'key', key: 'motor.speed' }] } }, '["factory/line1",["path",[["key","motor.speed"]]]]'],
			[{ ...mqtt, selector: { kind: 'path', tokens: [{ kind: 'index', index: 0 }] } }, '["factory/line1",["path",[["index",0]]]]'],
			[{ ...mqtt, selector: { kind: 'path', tokens: [{ kind: 'key', key: '0' }] } }, '["factory/line1",["path",[["key","0"]]]]'],
			[{ ...mqtt, topic: 'factory/line2' }, '["factory/line2",["whole"]]'],
		];
		expect(cases.map(([input, expected]) => {
			const actual = key(input);
			expect(actual).toBe(expected);
			return actual;
		})).toHaveLength(new Set(cases.map(([, expected]) => expected)).size);
	});

	it.each([
		[{ ...mqtt, topic: 'factory/+/value' }, 'invalid-topic'],
		[{ ...mqtt, topic: 'factory/#' }, 'invalid-topic'],
		[{ ...mqtt, topic: 'x\0y' }, 'invalid-topic'],
		[{ ...mqtt, selector: 'motor.speed' }, 'ambiguous-legacy-selector'],
		[{ ...mqtt, field: 'motor.speed' }, 'ambiguous-legacy-selector'],
		[{ ...mqtt, selectorSource: undefined }, 'invalid-selector'],
		[{ ...mqtt, selector: { kind: 'path', tokens: [] } }, 'invalid-selector'],
		[{ ...mqtt, selector: { kind: 'path', tokens: [{ kind: 'index', index: -1 }] } }, 'invalid-selector'],
		[{ ...mqtt, selector: { kind: 'path', tokens: [{ kind: 'key', key: 'x', index: 0 }] } }, 'invalid-selector'],
		[{ ...mqtt, selector: { kind: 'whole', tokens: [] } }, 'invalid-selector'],
	])('rejects unsafe topic or selector: %s', (input, reason) => expectReason(input, reason));
});

describe('Modbus', () => {
	it.each([
		[1, 'coil', 'boolean'],
		[2, 'discrete', 'boolean'],
		[3, 'holding', 'uint16'],
		[4, 'input', 'uint16'],
	] as const)('maps function %i to %s', (functionCode, space, dataType) => {
		const input = { ...modbus, type: space, functionCode, projection: { dataType, count: 1 } };
		expect(key(input)).toBe(JSON.stringify([1, space, 10]));
		expect(canonicalizeAddress(input)).toMatchObject({ status: 'resolved', provenance: { functionCode, projectionComparison: 'not-compared' } });
	});

	it('keeps unit IDs and wire addresses distinct, with no 40001 conversion', () => {
		expect(key({ ...modbus, unitId: 2 })).not.toBe(key(modbus));
		expect(key({ ...modbus, address: 40001 })).toBe('[1,"holding",40001]');
		expect(key({ ...modbus, address: 0 })).not.toBe(key({ ...modbus, address: 40001 }));
	});

	it.each([
		[{ ...modbus, unitId: 0 }, 'invalid-unit-id'],
		[{ ...modbus, unitId: 248 }, 'invalid-unit-id'],
		[{ ...modbus, address: -1 }, 'invalid-address'],
		[{ ...modbus, address: 65536 }, 'invalid-address'],
		[{ ...modbus, address: 1.5 }, 'invalid-address'],
		[{ ...modbus, functionCode: 4 }, 'conflicting-address-space'],
		[{ ...modbus, type: 'unknown' }, 'invalid-address-space'],
		[{ ...modbus, type: undefined }, 'invalid-address-space'],
		[{ ...modbus, projection: { dataType: 'float32', count: 1 } }, 'invalid-projection'],
		[{ ...modbus, projection: { dataType: 'uint16', count: 1, byteOrder: 'invalid' } }, 'invalid-projection'],
		[{ ...modbus, projection: { dataType: 'uint16', count: 1, bit: 3 } }, 'invalid-projection'],
		[{ ...modbus, projection: { dataType: 'uint16', count: 1, scale: Infinity } }, 'invalid-projection'],
		[{ ...modbus, address: 65535, projection: { dataType: 'float32', count: 2 } }, 'invalid-projection'],
	])('rejects invalid address or projection: %s', (input, reason) => expectReason(input, reason));

	it('rejects both sides of overlapping or duplicate projections without affecting other scopes', () => {
		const inputs: ModbusAddressInput[] = [
			{ ...modbus, projection: { dataType: 'float32', count: 2 } },
			{ ...modbus, address: 11 },
			{ ...modbus, unitId: 2 },
			{ ...modbus, type: 'input' },
		];
		const results = canonicalizeModbusAddresses(inputs, { complete: true });
		expect(results[0]).toMatchObject({ status: 'unresolved', reason: 'ambiguous-projection', details: { conflictingCandidateIndexes: [1] } });
		expect(results[1]).toMatchObject({ status: 'unresolved', reason: 'ambiguous-projection', details: { conflictingCandidateIndexes: [0] } });
		expect(results[2]).toMatchObject({ status: 'resolved', provenance: { projectionComparison: 'complete-inventory' } });
		expect(results[3]).toMatchObject({ status: 'resolved' });
		expect(canonicalizeModbusAddresses([modbus, modbus], { complete: true })).toEqual([
			expect.objectContaining({ reason: 'ambiguous-projection' }), expect.objectContaining({ reason: 'ambiguous-projection' }),
		]);
		expect(canonicalizeModbusAddresses([modbus, { ...modbus, projection: { dataType: 'int16', count: 1 } }], { complete: true }))
			.toEqual([expect.objectContaining({ reason: 'ambiguous-projection' }), expect.objectContaining({ reason: 'ambiguous-projection' })]);
	});

	it('does not claim safe comparison if another supplied candidate is malformed', () => {
		const results = canonicalizeModbusAddresses([modbus, { ...modbus, unitId: 0 }], { complete: true });
		expect(results).toEqual([
			expect.objectContaining({ status: 'unresolved', reason: 'ambiguous-projection', details: { invalidCandidateIndexes: [1] } }),
			expect.objectContaining({ status: 'unresolved', reason: 'invalid-unit-id' }),
		]);
	});

	it.each(['coil', 'discrete'] as const)('compares the full requested %s bit span', (type) => {
		const first: ModbusAddressInput = { ...modbus, type, address: 20, projection: { dataType: 'boolean', count: 3 } };
		const overlapping: ModbusAddressInput = { ...first, address: 22, projection: { dataType: 'boolean', count: 1 } };
		const adjacent: ModbusAddressInput = { ...overlapping, address: 23 };
		const results = canonicalizeModbusAddresses([first, overlapping, adjacent], { complete: true });
		expect(results[0]).toMatchObject({ status: 'unresolved', reason: 'ambiguous-projection', details: { conflictingCandidateIndexes: [1] } });
		expect(results[1]).toMatchObject({ status: 'unresolved', reason: 'ambiguous-projection', details: { conflictingCandidateIndexes: [0] } });
		expect(results[2]).toMatchObject({ status: 'resolved' });
	});

	it.each(['int32', 'uint32', 'float32'] as const)('matches adapter normalization for %s register width', (dataType) => {
		const [register] = normalizeModbusRegisters([{ address: 10, type: 'holding', dataType }]);
		expect(register).toMatchObject({ address: 10, functionCode: 3, dataType, count: 2 });
		const results = canonicalizeModbusAddresses([
			{ ...modbus, functionCode: register.functionCode, projection: { dataType, count: register.count } },
			{ ...modbus, address: 11 },
			{ ...modbus, address: 12 },
		], { complete: true });
		expect(results[0]).toMatchObject({ status: 'unresolved', reason: 'ambiguous-projection' });
		expect(results[1]).toMatchObject({ status: 'unresolved', reason: 'ambiguous-projection' });
		expect(results[2]).toMatchObject({ status: 'resolved' });
	});

	it('rejects excessively large inventories rather than silently skipping comparisons', () => {
		const results = canonicalizeModbusAddresses(Array.from({ length: 1025 }, () => modbus), { complete: true });
		expect(results).toHaveLength(1025);
		expect(results.every(result => result.status === 'unresolved' && result.reason === 'too-many-candidates')).toBe(true);
	});

	it('requires the caller to attest inventory completeness', () => {
		expect(Reflect.apply(canonicalizeModbusAddresses, undefined, [[modbus], undefined]))
			.toEqual([expect.objectContaining({ status: 'unresolved', reason: 'inventory-incomplete' })]);
	});
});

describe('BACnet', () => {
	it('normalizes supported object types and applies only an omitted present-value default', () => {
		expect(key(bacnet)).toBe('[42,0,7,85,["whole"]]');
		expect(key({ ...bacnet, objectType: 0, propertyId: 85, arraySelector: { kind: 'whole' } })).toBe(key(bacnet));
		expect(canonicalizeAddress(bacnet)).toMatchObject({ status: 'resolved', provenance: { propertySource: 'default', networkScope: 'observed' } });
		expect(canonicalizeAddress({ ...bacnet, propertyId: 85 })).toMatchObject({ status: 'resolved', provenance: { propertySource: 'configured' } });
		const alternatives = [
			{ ...bacnet, deviceInstance: 43 }, { ...bacnet, objectType: 'analog-value' },
			{ ...bacnet, objectInstance: 8 }, { ...bacnet, propertyId: 28 },
		];
		expect(new Set([key(bacnet), ...alternatives.map(key)]).size).toBe(5);
	});

	it('supports numeric property identifiers actually encoded by the BACnet client', () => {
		const readProperty = jest.requireActual<{
			encode: (buffer: { buffer: Buffer; offset: number }, objectType: number, objectInstance: number, propertyId: number, arrayIndex: number) => void;
			decode: (buffer: Buffer, offset: number, length: number) => { property: { id: number } };
				}>('bacstack/lib/services/read-property');
		for (const propertyId of [4, 512, 4194303]) {
			const encoded = { buffer: Buffer.alloc(64), offset: 0 };
			readProperty.encode(encoded, 0, 7, propertyId, 0xffffffff);
			expect(readProperty.decode(encoded.buffer, 0, encoded.offset).property.id).toBe(propertyId);
			expect(key({ ...bacnet, propertyId })).toBe(JSON.stringify([42, 0, 7, propertyId, ['whole']]));
		}
	});

	it.each([
		[{ ...bacnet, deviceInstance: -1 }, 'invalid-device-instance'],
		[{ ...bacnet, deviceInstance: 4194304 }, 'invalid-device-instance'],
		[{ ...bacnet, networkScope: undefined }, 'ambiguous-network-scope'],
		[{ ...bacnet, networkScope: { uniqueDeviceInstance: false, source: 'observed' } }, 'ambiguous-network-scope'],
		[{ ...bacnet, objectType: 'type-900' }, 'invalid-object-type'],
		[{ ...bacnet, objectInstance: 1.5 }, 'invalid-object-instance'],
		[{ ...bacnet, propertyId: undefined }, 'invalid-property'],
		[{ ...bacnet, propertyId: 0 }, 'invalid-property'],
		[{ ...bacnet, propertyId: 4194304 }, 'invalid-property'],
		[{ ...bacnet, propertyId: 4.5 }, 'invalid-property'],
		[{ ...bacnet, arraySelector: { kind: 'index', index: 0 } }, 'unsupported-array-selector'],
		[{ ...bacnet, arrayIndex: 0 }, 'unsupported-array-selector'],
	])('rejects invalid scope or object information: %s', (input, reason) => expectReason(input, reason));
});
