import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { NodeClass, type ClientSession } from 'node-opcua-client';
import { identifyDevices } from '../../../../src/plugins/opcua/device-identification';
import type { OPCUADeviceIdentification } from '../../../../src/plugins/opcua/device-identification-config';

const good = { isGood: () => true, name: 'Good' };
const id = (value: string) => ({ toString: () => value, serverIndex: 0, namespaceUri: null });
const ref = (nodeId: string, name: string, nodeClass: NodeClass, type = 'device-type') => ({
	nodeId: id(nodeId), browseName: { name }, displayName: { text: name },
	nodeClass, typeDefinition: id(type),
});
const config: OPCUADeviceIdentification = {
	scopeNodeId: 'scope', rootNodeId: 'device1', deviceTypeNodeId: 'device-type',
	identifierProperty: 'AssetId', identifierPath: 'Identification/AssetId',
};

function makeSession(secondIdentifier = 'pump-2', omitRootIdentifier = false) {
	const object = NodeClass.Object;
	const variable = NodeClass.Variable;
	const nodes: Record<string, ReturnType<typeof ref>[]> = {
		scope: [ref('device1', 'Pump 1', object), ref('group', 'Group', object, 'folder-type')],
		group: [ref('device2', 'Pump 2', object), ref('folder', 'Not a device', object, 'folder-type')],
		device1: [ref('id1', 'Identification', object, 'folder-type')],
		device2: [ref('id2', 'Identification', object, 'folder-type')],
		folder: [],
		id1: omitRootIdentifier ? [] : [ref('value1', 'AssetId', variable)],
		id2: [ref('value2', 'AssetId', variable)],
	};
	const values: Record<string, string> = { value1: 'pump-1', value2: secondIdentifier };
	return {
		browse: async ({ nodeId }: { nodeId: string }) => ({ statusCode: good, references: nodes[nodeId] ?? [] }),
		read: async ({ nodeId }: { nodeId: string }) => ({ statusCode: good, value: { value: values[nodeId] } }),
	} as unknown as ClientSession;
}

test('identifies only matching device objects with the configured relative path', async () => {
	const devices = await identifyDevices(makeSession(), config);
	assert.deepEqual([...devices.entries()], [
		['device1', { identifier: 'pump-1', name: 'Pump 1', identifierNodeId: 'value1' }],
		['device2', { identifier: 'pump-2', name: 'Pump 2', identifierNodeId: 'value2' }],
	]);
});

test('rejects duplicate identifiers and a missing identifier on the selected root', async () => {
	await assert.rejects(identifyDevices(makeSession('pump-1'), config), /Duplicate device identifier/);
	await assert.rejects(identifyDevices(makeSession('pump-2', true), config), /Identifier path not found/);
});

test('rejects a property that does not match the final relative path segment', async () => {
	await assert.rejects(identifyDevices(makeSession(), { ...config, identifierProperty: 'DeviceUUID' }), /relative identifier path/);
});

test('discovery can skip missing, blank and unreadable identifiers without losing identified siblings', async () => {
	for (const identifier of ['', '   ']) {
		const missing: string[] = [];
		const devices = await identifyDevices(makeSession(identifier, true), config, {
			allowMissingIdentifiers: true,
			onMissingIdentifier: nodeId => missing.push(nodeId),
		});
		assert.equal(devices.size, 0);
		assert.deepEqual(missing.sort(), ['device1', 'device2']);
	}
	const session = makeSession();
	const read = session.read.bind(session);
	session.read = (async (request: any) => {
		if (request.nodeId === 'value1') throw new Error('BadNotReadable');
		return read(request);
	}) as ClientSession['read'];
	const missing: string[] = [];
	const devices = await identifyDevices(session, config, {
		allowMissingIdentifiers: true,
		onMissingIdentifier: nodeId => missing.push(nodeId),
	});
	assert.deepEqual(missing, ['device1']);
	assert.equal(devices.get('device2')?.identifier, 'pump-2');
});
