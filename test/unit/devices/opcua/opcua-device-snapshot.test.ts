import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AttributeIds, BrowseDirection, NodeClass, type ClientSession } from 'node-opcua-client';
import { collectOpcuaDeviceSnapshot } from '../../../../src/plugins/opcua/device-snapshot';
import { generateDeviceCandidates } from '../../../../src/discovery/device-candidates';

const good = { isGood: () => true };
const id = (value: string) => ({ toString: () => value, serverIndex: 0, namespaceUri: null });
const reference = (address: string, name: string, nodeClass: NodeClass, namespaceIndex: number, type = 'base') => ({
	nodeId: id(address), browseName: { name, namespaceIndex }, displayName: { text: name },
	nodeClass, typeDefinition: id(type),
});

function session(namespaceIndex = 1, duplicate = false): ClientSession {
	const uris = ['http://opcfoundation.org/UA/', 'urn:other'];
	uris[namespaceIndex] = 'urn:factory';
	const nodes: Record<string, ReturnType<typeof reference>[]> = {
		'ns=0;i=85': [reference('pump', 'Pump', NodeClass.Object, namespaceIndex)],
		pump: [reference('asset', 'AssetId', NodeClass.Variable, namespaceIndex), reference('temperature', 'Temperature', NodeClass.Variable, namespaceIndex)],
	};
	if (duplicate) nodes.pump.push(reference('temperature', 'Again', NodeClass.Variable, namespaceIndex));
	return {
		browse: async ({ nodeId }: { nodeId: string }) => ({ statusCode: good, references: nodes[nodeId] ?? [] }),
		read: async ({ nodeId }: { nodeId: string }) => ({
			statusCode: good,
			value: { value: nodeId === 'ns=0;i=2255' ? uris : 'P-1' },
		}),
	} as unknown as ClientSession;
}

test('captures identifier evidence and stable namespace-URI browse paths without treating it as telemetry', async () => {
	const first = await collectOpcuaDeviceSnapshot(session(), 'AssetId');
	const second = await collectOpcuaDeviceSnapshot(session(2), 'AssetId');
	assert.deepEqual(first.objects[1].browsePath, second.objects[1].browsePath);
	assert.deepEqual(first.points.map(p => p.address), ['temperature']);
	const result = generateDeviceCandidates(first, { type: 'identifier', identifierPath: 'AssetId' });
	assert.deepEqual(result.candidates.map(c => [c.name, c.pointAddresses]), [['Pump', ['temperature']]]);
});

test('recognizes a subtype of the OPC UA DI DeviceType rather than a generic folder', async () => {
	const uris = ['http://opcfoundation.org/UA/', 'urn:factory', 'http://opcfoundation.org/UA/DI/'];
	const nodes: Record<string, ReturnType<typeof reference>[]> = {
		'ns=0;i=85': [reference('pump', 'Pump', NodeClass.Object, 1, 'custom-device')],
		pump: [reference('temp', 'Temperature', NodeClass.Variable, 1)],
	};
	const mock = {
		browse: async ({ nodeId, browseDirection }: { nodeId: string; browseDirection: BrowseDirection }) => ({
			statusCode: good,
			references: browseDirection === BrowseDirection.Inverse
				? nodeId === 'custom-device' ? [reference('di-device', 'DeviceType', NodeClass.ObjectType, 2)] : []
				: nodes[nodeId] ?? [],
		}),
		read: async ({ nodeId, attributeId }: { nodeId: string; attributeId: AttributeIds }) => ({
			statusCode: good,
			value: { value: attributeId === AttributeIds.Value ? uris : nodeId === 'di-device'
				? { name: 'DeviceType', namespaceIndex: 2 } : { name: 'CustomType', namespaceIndex: 1 } },
		}),
	} as unknown as ClientSession;
	const snapshot = await collectOpcuaDeviceSnapshot(mock);
	assert.deepEqual(generateDeviceCandidates(snapshot, { type: 'device-model' }).candidates.map(c => c.name), ['Pump']);
});

test('rejects nodes with multiple browse paths instead of guessing ownership', async () => {
	await assert.rejects(collectOpcuaDeviceSnapshot(session(1, true)), /multiple browse paths/);
});
