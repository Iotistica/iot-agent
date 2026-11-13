import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { generateDeviceCandidates, type DiscoverySnapshot } from '../../../src/discovery/device-candidates';
import { previewDeviceResolution } from '../../../src/discovery/device-resolution';

const snapshot: DiscoverySnapshot = {
	objects: [
		{ address: 'root', parentAddress: null, name: 'Site', browsePath: ['Site'] },
		{ address: 'pump', parentAddress: 'root', name: 'Pump', browsePath: ['Site', 'Pump'], isDeviceModel: true, identifiers: { AssetId: 'P-1' } },
		{ address: 'nested', parentAddress: 'pump', name: 'Measurements', browsePath: ['Site', 'Pump', 'Measurements'] },
		{ address: 'fan', parentAddress: 'root', name: 'Fan', browsePath: ['Site', 'Fan'] },
	],
	points: [
		{ address: 'p1', parentAddress: 'nested', name: 'pump_temperature' },
		{ address: 'p2', parentAddress: 'fan', name: 'fan_status' },
		{ address: 'p3', parentAddress: 'root', name: 'unmatched' },
	],
};

test('identifier and actual model evidence create suggestions, not identities', () => {
	const byId = generateDeviceCandidates(snapshot, { type: 'identifier', identifierPath: 'AssetId' });
	assert.equal(byId.candidates.length, 1);
	assert.deepEqual(byId.candidates[0].pointAddresses, ['p1']);
	assert.deepEqual(byId.candidates[0].keys, [
		{ kind: 'browse-path', value: '["Site","Pump"]' },
		{ kind: 'external-identifier:AssetId', value: 'P-1' },
	]);
	assert.deepEqual(byId.unproposedPointAddresses, ['p2', 'p3']);
	assert.equal(previewDeviceResolution('source', byId.candidates, [])[0].status, 'new');
	assert.deepEqual(generateDeviceCandidates(snapshot, { type: 'device-model' }).candidates.map(c => c.name), ['Pump']);
});

test('hierarchy uses explicit scope and depth rather than classifying every folder', () => {
	const shallow = generateDeviceCandidates(snapshot, { type: 'hierarchy', scopeAddress: 'root', deviceDepth: 1 });
	assert.deepEqual(shallow.candidates.map(c => c.name), ['Pump', 'Fan']);
	assert.deepEqual(shallow.unproposedPointAddresses, ['p3']);
	const deep = generateDeviceCandidates(snapshot, { type: 'hierarchy', scopeAddress: 'root', deviceDepth: 2 });
	assert.deepEqual(deep.candidates.map(c => c.name), ['Measurements']);
	assert.deepEqual(deep.unproposedPointAddresses, ['p2', 'p3']);
});

test('tag templates and manual mappings leave nonmatching points unassigned', () => {
	const tags = generateDeviceCandidates(snapshot, { type: 'tag-pattern', template: '{device}_{point}' });
	assert.deepEqual(tags.candidates.map(c => [c.name, c.pointAddresses]), [['pump', ['p1']], ['fan', ['p2']]]);
	assert.deepEqual(tags.unproposedPointAddresses, ['p3']);
	const manual = generateDeviceCandidates(snapshot, { type: 'manual', mappings: [{ id: 'm1', name: 'PLC', pointAddresses: ['p3'] }] });
	assert.deepEqual(manual.candidates[0].pointAddresses, ['p3']);
	assert.deepEqual(manual.unproposedPointAddresses, ['p1', 'p2']);
	assert.throws(() => generateDeviceCandidates(snapshot, { type: 'tag-pattern', template: '{device}{point}' }), /delimiter/);
	assert.throws(() => generateDeviceCandidates(snapshot, { type: 'manual', mappings: [{ id: 'm1', name: 'PLC', pointAddresses: ['missing'] }] }), /existing points/);
});

test('ambiguous ownership and invalid tree structures are not silently accepted', () => {
	const nestedModels: DiscoverySnapshot = {
		...snapshot,
		objects: snapshot.objects.map(o => o.address === 'nested' ? { ...o, isDeviceModel: true } : o),
	};
	const suggestions = generateDeviceCandidates(nestedModels, { type: 'device-model' });
	assert.deepEqual(previewDeviceResolution('source', suggestions.candidates, []).map(p => p.status), ['conflict', 'conflict']);
	const cyclic: DiscoverySnapshot = { ...snapshot, objects: snapshot.objects.map(o => o.address === 'root' ? { ...o, parentAddress: 'nested' } : o) };
	assert.throws(() => generateDeviceCandidates(cyclic, { type: 'device-model' }), /cycle/);
});
