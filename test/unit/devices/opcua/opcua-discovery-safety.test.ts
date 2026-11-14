import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { OPCUAClient } from 'node-opcua-client';
import { OPCUADiscovery } from '../../../../src/plugins/opcua/discovery';
import { DiscoveryService } from '../../../../src/discovery/service';

const good = { isGood: () => true, name: 'Good' };
const bad = { isGood: () => false, name: 'BadNotReadable' };
const reference = (nodeId: string, name: string) => ({
	nodeId: { toString: () => nodeId }, browseName: { name },
});

test('incomplete OPC UA scans are excluded from explicit pruning', async () => {
	const service = new DiscoveryService();
	const calls: unknown[][] = [];
	const internals = service as unknown as {
		plugins: Map<string, unknown>;
		optionsBuilder: { build: () => object };
		store: { save: (...args: unknown[]) => Promise<{ saved: number; skipped: number; pruned: number }> };
	};
	internals.plugins.set('opcua', {
		isAvailable: async () => true,
		discover: async () => Object.assign([], { scanComplete: false }),
	});

	internals.optionsBuilder = { build: () => ({}) };
	internals.store = { save: async (...args) => {
		calls.push(args);
		return { saved: 0, skipped: 0, pruned: 0 };
	} };
	try {
		await service.runDiscovery({ trigger: 'manual', protocols: ['opcua'], forceRun: true, prune: true });
		assert.deepEqual(calls[0][3], { protocols: [], dryRun: false });
	} finally {
		service.cleanup();
	}
});

test('configured identification keeps points when the selected identifier is unreadable', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'opcua-configured-safety-'));
	const oldAppData = process.env.APPDATA;
	process.env.APPDATA = dir;
	const node = (value: string) => ({ toString: () => value, namespace: 2, serverIndex: 0 });
	const object = { nodeId: node('device'), browseName: { name: 'Device' }, displayName: { text: 'Device' }, nodeClass: 1, typeDefinition: node('device-type') };
	const identifier = { nodeId: node('identifier'), browseName: { name: 'AssetId' }, nodeClass: 2 };
	const point = { nodeId: node('point'), browseName: { name: 'Temperature' }, nodeClass: 2 };
	const session = {
		browse: async (request: string | { nodeId: string }) => {
			const id = typeof request === 'string' ? request : request.nodeId;
			return { statusCode: good, references: id === 'ns=0;i=85' ? [object] : id === 'device' ? [identifier, point] : [] };
		},
		read: async (request: unknown) => Array.isArray(request)
			? [{ statusCode: good, value: { value: request[0].nodeId === 'device' ? 1 : 2 } }, { value: { value: 1 } }, { value: { value: 1 } }, { value: { value: null } }]
			: { statusCode: bad, value: { value: null } },
		createSubscription2: async () => ({ terminate: async () => {} }),
		close: async () => {},
	};
	mock.method(OPCUAClient, 'create', () => ({
		connect: async () => {}, disconnect: async () => {}, createSession: async () => session,
		getEndpoints: async () => [{ server: { applicationUri: 'urn:test' } }],
	}) as unknown as OPCUAClient);
	try {
		const discovery = new OPCUADiscovery();
		const [result] = await discovery.discover({
			discoveryUrls: ['opc.tcp://localhost:4840'],
			deviceIdentification: {
				scopeNodeId: 'ns=0;i=85', rootNodeId: 'device', deviceTypeNodeId: 'device-type',
				identifierProperty: 'AssetId', identifierPath: 'AssetId',
			},
		});
		assert.ok(result);
		assert.deepEqual(result.dataPoints.map(item => item.nodeId), ['point']);
		assert.equal(result.dataPoints[0].device_uuid, undefined);
	} finally {
		mock.restoreAll();
		if (oldAppData === undefined) delete process.env.APPDATA;
		else process.env.APPDATA = oldAppData;
		rmSync(dir, { recursive: true, force: true });
	}
});

test('an unreadable child DeviceUUID does not inherit the parent device identity', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'opcua-inheritance-safety-'));
	const oldAppData = process.env.APPDATA;
	process.env.APPDATA = dir;
	const session = {
		browse: async (id: string) => ({
			statusCode: good,
			references: id === 'ns=0;i=85'
				? [reference('parent-id', 'DeviceUUID'), reference('parent-point', 'Parent'), reference('child', 'Child')]
				: id === 'child' ? [reference('child-id', 'DeviceUUID'), reference('child-point', 'ChildPoint')] : [],
		}),
		read: async (request: any) => Array.isArray(request)
			? [{ statusCode: good, value: { value: request[0].nodeId === 'child' ? 1 : 2 } }, { value: { value: 1 } }, { value: { value: 1 } }, { value: { value: null } }]
			: { statusCode: request.nodeId === 'child-id' ? bad : good, value: { value: 'parent-device' } },
		createSubscription2: async () => ({ terminate: async () => {} }),
		close: async () => {},
	};
	mock.method(OPCUAClient, 'create', () => ({
		connect: async () => {}, disconnect: async () => {}, createSession: async () => session,
		getEndpoints: async () => [{ server: { applicationUri: 'urn:test' } }],
	}) as unknown as OPCUAClient);
	try {
		const [result] = await new OPCUADiscovery().discover({ discoveryUrls: ['opc.tcp://localhost:4840'] });
		assert.equal(result.dataPoints.find(item => item.nodeId === 'parent-point')?.device_uuid, 'parent-device');
		assert.equal(result.dataPoints.find(item => item.nodeId === 'child-point')?.device_uuid, undefined);
	} finally {
		mock.restoreAll();
		if (oldAppData === undefined) delete process.env.APPDATA;
		else process.env.APPDATA = oldAppData;
		rmSync(dir, { recursive: true, force: true });
	}
});

test('OPC UA discovery keeps identified and unidentified points and reports incomplete scans', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'opcua-discovery-safety-'));
	const oldAppData = process.env.APPDATA;
	process.env.APPDATA = dir;
	try {
		for (const scenario of [
			{ marker: 'pump-existing', expected: 'pump-existing', count: 2, complete: true },
			{ marker: undefined, expected: undefined, count: 2, complete: true },
			{ marker: null, expected: undefined, count: 2, complete: true },
			{ marker: '   ', expected: undefined, count: 2, complete: true },
			{ marker: 'stale', markerBad: true, expected: undefined, count: 2, complete: true },
			{ marker: 'throw', expected: undefined, count: 2, complete: true },
			{ marker: 'pump-existing', partial: true, expected: 'pump-existing', count: 1, complete: false },
			{ failed: true, expected: undefined, count: 0, complete: false },
		]) {
			const refs = [
				reference('marker', 'DeviceUUID'),
				reference('a', 'Temperature'),
				reference('b', 'Pressure'),
			];
			const session = {
				browse: async (nodeId: string) => ({
					statusCode: nodeId === 'ns=0;i=85' && scenario.failed ? bad : good,
					references: nodeId === 'ns=0;i=85' ? refs : [],
				}),
				read: async (request: any) => {
					if (!Array.isArray(request)) {
						if (scenario.marker === 'throw') throw new Error('BadNotReadable');
						return { statusCode: scenario.markerBad ? bad : good, value: { value: scenario.marker } };
					}
					return [
						{ statusCode: scenario.partial && request[0].nodeId === 'b' ? bad : good, value: { value: 2 } },
						{ value: { value: 1 } }, { value: { value: 1 } }, { value: { value: null } },
					];
				},
				createSubscription2: async () => ({ terminate: async () => {} }),
				close: async () => {},
			};
			mock.method(OPCUAClient, 'create', () => ({
				connect: async () => {},
				disconnect: async () => {},
				createSession: async () => session,
				getEndpoints: async () => [{ server: { applicationUri: 'urn:test' } }],
			}) as unknown as OPCUAClient);
			const discovery = new OPCUADiscovery();
			const results = await discovery.discover({ discoveryUrls: ['opc.tcp://localhost:4840'] });
			const [result] = results;
			assert.ok(result);
			assert.equal(results.scanComplete, scenario.complete);
			assert.deepEqual(results.scanStatus, { successful: true, complete: scenario.complete, authoritative: false });
			assert.equal(result.dataPointsComplete, scenario.complete);
			assert.equal(result.dataPoints.length, scenario.count);
			assert.ok(result.dataPoints.every(point => point.device_uuid === scenario.expected));
			mock.restoreAll();
		}
	} finally {
		mock.restoreAll();
		if (oldAppData === undefined) delete process.env.APPDATA;
		else process.env.APPDATA = oldAppData;
		rmSync(dir, { recursive: true, force: true });
	}
});
