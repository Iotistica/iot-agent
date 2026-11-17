import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BrowseDirection, type ClientSession } from 'node-opcua-client';
import { resolveDeviceDisplayNames } from '../../../../src/plugins/opcua/device-identity';
import type { Logger } from '../../../../src/plugins/types';

const good = { isGood: () => true, name: 'Good' };
const ref = (id: string, name: string) => ({
	nodeId: { namespace: 2, toString: () => id },
	browseName: { name },
	displayName: { text: name },
});
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

test('uses identifier aliases or the actual parent of numeric node IDs', async () => {
	const parents = [ref('ns=2;i=1', 'plc-001'), ref('ns=2;i=10', 'Folder'), ref('ns=2;i=20', 'Third')];
	const browse = async (requests: Array<{ browseDirection: BrowseDirection }>) => requests[0].browseDirection === BrowseDirection.Inverse
		? parents.map(parent => ({ statusCode: good, references: [parent] }))
		: [
			{ statusCode: good, references: [] },
			{ statusCode: good, references: [ref('ns=2;i=11', 'device_id')] },
			{ statusCode: good, references: [ref('ns=2;i=21', 'DeviceIdentifier')] },
		];
	const read = async () => [
		{ statusCode: good, value: { value: 'pump-12' } },
		{ statusCode: good, value: { value: 42 } },
	];
	const session = { browse, read } as unknown as ClientSession;
	const names = await resolveDeviceDisplayNames(session, ['ns=2;i=2', 'ns=2;i=12', 'ns=2;i=22'], logger);
	assert.deepEqual([...names.entries()], [
		['ns=2;i=2', 'plc-001'], ['ns=2;i=12', 'pump-12'], ['ns=2;i=22', '42'],
	]);
});

test('does not guess between multiple parents and uses the folder rather than a UUID', async () => {
	const browse = async (requests: Array<{ browseDirection: BrowseDirection }>) => requests[0].browseDirection === BrowseDirection.Inverse
		? [
			{ statusCode: good, references: [ref('ns=2;i=1', 'AHU')] },
			{ statusCode: good, references: [ref('ns=2;i=3', 'A'), ref('ns=2;i=4', 'B')] },
		]
		: [{ statusCode: good, references: [ref('ns=2;i=5', 'Device_UUID')] }];
	const read = async () => [{ statusCode: good, value: { value: '7c0e0a77-594c-49cc-a4d2-8d0b32e080e8' } }];
	const names = await resolveDeviceDisplayNames({ browse, read } as unknown as ClientSession, ['ns=2;i=2', 'ns=2;i=6'], logger);
	assert.deepEqual([...names.entries()], [['ns=2;i=2', 'AHU']]);
});
