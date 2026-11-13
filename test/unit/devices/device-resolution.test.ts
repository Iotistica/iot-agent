import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { confirmDeviceResolution, previewDeviceResolution, type DeviceResolutionCandidate } from '../../../src/discovery/device-resolution';

const candidate = (candidateId: string, keys: Array<[string, string]>, pointAddresses = [candidateId]): DeviceResolutionCandidate => ({
	candidateId, name: candidateId, keys: keys.map(([kind, value]) => ({ kind, value })), pointAddresses, reasons: [],
});

test('new candidates remain suggestions and matching is scoped to the source', () => {
	const preview = previewDeviceResolution('source-a', [
		candidate('one', [['external', 'same']]),
		candidate('two', [['path', 'site/pump']]),
	], [
		{ sourceUuid: 'source-b', deviceUuid: 'other', keys: [{ kind: 'external', value: 'same' }] },
		{ sourceUuid: 'source-a', deviceUuid: 'existing', keys: [{ kind: 'path', value: 'site/pump' }] },
	]);
	assert.equal(preview[0].status, 'new');
	assert.equal(preview[0].deviceUuid, undefined);
	assert.equal(preview[1].status, 'matched');
	assert.equal(preview[1].deviceUuid, 'existing');
});

test('conflicting identifier and path matches require review', () => {
	const preview = previewDeviceResolution('source', [candidate('pump', [['external', 'asset'], ['path', 'site/pump']])], [
		{ sourceUuid: 'source', deviceUuid: 'a', keys: [{ kind: 'external', value: 'asset' }] },
		{ sourceUuid: 'source', deviceUuid: 'b', keys: [{ kind: 'path', value: 'site/pump' }] },
	]);
	assert.equal(preview[0].status, 'conflict');
	assert.equal(preview[0].deviceUuid, undefined);
});

test('overlapping points or evidence cannot silently assign multiple devices', () => {
	const preview = previewDeviceResolution('source', [
		candidate('one', [['path', 'one']], ['shared']),
		candidate('two', [['path', 'two']], ['shared']),
		candidate('three', [['external', 'duplicate']]),
		candidate('four', [['external', 'duplicate']]),
	], []);
	assert.deepEqual(preview.map(item => item.status), ['conflict', 'conflict', 'conflict', 'conflict']);
});

test('two candidates matching different keys of the same device both require review', () => {
	const preview = previewDeviceResolution('source', [
		candidate('one', [['external', 'asset']]),
		candidate('two', [['path', 'site/pump']]),
	], [{ sourceUuid: 'source', deviceUuid: 'existing', keys: [
		{ kind: 'external', value: 'asset' }, { kind: 'path', value: 'site/pump' },
	] }]);
	assert.deepEqual(preview.map(item => item.status), ['conflict', 'conflict']);
	assert.ok(preview.every(item => !item.deviceUuid));
});

test('confirmation creates independent UUIDs only for selected candidates and retains identity on rediscovery', () => {
	const candidates = [
		candidate('pump', [['external', 'asset-1'], ['path', 'site/pump']]),
		candidate('fan', [['path', 'site/fan']]),
	];
	const [created] = confirmDeviceResolution('source', candidates, [], ['pump']);
	assert.match(created.identity.deviceUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.deepEqual(created.pointAddresses, ['pump']);

	const rediscovered = candidate('pump-new', [['external', 'asset-1'], ['path', 'site/new-pump']]);
	const [matched] = confirmDeviceResolution('source', [rediscovered], [created.identity], ['pump-new']);
	assert.equal(matched.identity.deviceUuid, created.identity.deviceUuid);
	assert.deepEqual(matched.identity.keys, [
		{ kind: 'external', value: 'asset-1' },
		{ kind: 'path', value: 'site/pump' },
		{ kind: 'path', value: 'site/new-pump' },
	]);
});

test('confirmation rejects stale, duplicate, or conflicting selections', () => {
	const candidates = [
		candidate('one', [['external', 'shared']]),
		candidate('two', [['external', 'shared']]),
	];
	assert.throws(() => confirmDeviceResolution('source', candidates, [], ['one']), /Conflicting/);
	assert.throws(() => confirmDeviceResolution('source', candidates, [], ['missing']), /no longer exists/);
	assert.throws(() => confirmDeviceResolution('source', candidates, [], ['one', 'one']), /more than once/);
	assert.throws(() => confirmDeviceResolution('', candidates, [], []), /source UUID/);
});
