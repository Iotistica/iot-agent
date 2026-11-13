import { strict as assert } from 'node:assert';
import { mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migration } from '../../../src/db/migrations/20261113000000_add_device_resolution_evidence';
import { DeviceResolutionStore } from '../../../src/discovery/device-resolution-store';
import type { DeviceResolutionCandidate } from '../../../src/discovery/device-resolution';

function candidate(id: string, identifier: string, path: string, point: string): DeviceResolutionCandidate {
	return {
		candidateId: id, name: id,
		keys: [{ kind: 'external-identifier', value: identifier }, { kind: 'browse-path', value: path }],
		pointAddresses: [point], reasons: [],
	};
}

test('confirmed identities and evidence survive reopening and are scoped by source', () => {
	const dir = mkdtempSync(join(tmpdir(), 'device-resolution-'));
	const filename = join(dir, 'test.sqlite');
	let db = new DatabaseSync(filename);
	try {
		db.exec(`
			PRAGMA foreign_keys = ON;
			CREATE TABLE endpoints (id INTEGER PRIMARY KEY, uuid TEXT UNIQUE NOT NULL, protocol TEXT NOT NULL);
			CREATE TABLE devices (
				uuid TEXT PRIMARY KEY, endpoint_id INTEGER NOT NULL REFERENCES endpoints(id),
				name TEXT NOT NULL, protocol TEXT NOT NULL, enabled INTEGER NOT NULL, identifier TEXT
			);
			INSERT INTO endpoints VALUES (1, 'source-a', 'opcua'), (2, 'source-b', 'modbus');
		`);
		migration.up(db);
		let store = new DeviceResolutionStore(db);
		const pump = candidate('pump', 'asset-1', 'building/pump', 'ns=2;s=pump.temp');
		assert.equal(store.preview('source-a', [pump])[0].status, 'new');
		assert.equal((db.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }).n, 0);
		const [first] = store.confirm('source-a', [pump], ['pump']);
		db.close();
		db = new DatabaseSync(filename);
		store = new DeviceResolutionStore(db);
		assert.equal(store.preview('source-a', [pump])[0].deviceUuid, first.identity.deviceUuid);
		assert.equal(store.preview('source-b', [pump])[0].status, 'new');
		assert.equal(store.confirm('source-a', [pump], ['pump'])[0].identity.deviceUuid, first.identity.deviceUuid);
		assert.notEqual(store.confirm('source-b', [pump], ['pump'])[0].identity.deviceUuid, first.identity.deviceUuid);
	} finally {
		db.close();
		rmSync(filename, { force: true });
		rmdirSync(dir);
	}
});

test('point ownership conflicts are shown in preview and confirmation rolls back', () => {
	const db = new DatabaseSync(':memory:');
	try {
		db.exec(`
			CREATE TABLE endpoints (id INTEGER PRIMARY KEY, uuid TEXT UNIQUE NOT NULL, protocol TEXT NOT NULL);
			CREATE TABLE devices (
				uuid TEXT PRIMARY KEY, endpoint_id INTEGER NOT NULL,
				name TEXT NOT NULL, protocol TEXT NOT NULL, enabled INTEGER NOT NULL, identifier TEXT
			);
			INSERT INTO endpoints VALUES (1, 'source', 'opcua');
		`);
		migration.up(db);
		const store = new DeviceResolutionStore(db);
		store.confirm('source', [candidate('pump', 'asset-1', 'pump', 'shared')], ['pump']);
		const fan = candidate('fan', 'asset-2', 'fan', 'shared');
		assert.equal(store.preview('source', [fan])[0].status, 'conflict');
		assert.throws(() => store.confirm('source', [fan], ['fan']), /already assigned/);
		assert.equal((db.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }).n, 1);
		assert.equal((db.prepare('SELECT COUNT(*) AS n FROM device_resolution_keys').get() as { n: number }).n, 2);
	} finally {
		db.close();
	}
});

test('evidence is removed with a deleted device or source even when foreign keys are disabled', () => {
	const db = new DatabaseSync(':memory:');
	try {
		db.exec(`
			PRAGMA foreign_keys = OFF;
			CREATE TABLE endpoints (id INTEGER PRIMARY KEY, uuid TEXT UNIQUE NOT NULL, protocol TEXT NOT NULL);
			CREATE TABLE devices (
				uuid TEXT PRIMARY KEY, endpoint_id INTEGER NOT NULL,
				name TEXT NOT NULL, protocol TEXT NOT NULL, enabled INTEGER NOT NULL, identifier TEXT
			);
			INSERT INTO endpoints VALUES (1, 'source', 'opcua');
		`);
		migration.up(db);
		const store = new DeviceResolutionStore(db);
		const pump = candidate('pump', 'asset-1', 'pump', 'temperature');
		const [first] = store.confirm('source', [pump], ['pump']);
		db.prepare('DELETE FROM devices WHERE uuid = ?').run(first.identity.deviceUuid);
		assert.equal((db.prepare('SELECT COUNT(*) AS n FROM device_resolution_keys').get() as { n: number }).n, 0);
		store.confirm('source', [pump], ['pump']);
		db.exec("DELETE FROM endpoints WHERE uuid = 'source'");
		assert.equal((db.prepare('SELECT COUNT(*) AS n FROM device_resolution_keys').get() as { n: number }).n, 0);
		assert.equal((db.prepare('SELECT COUNT(*) AS n FROM device_resolution_points').get() as { n: number }).n, 0);
	} finally {
		db.close();
	}
});
