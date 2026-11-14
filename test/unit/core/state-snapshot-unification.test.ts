import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { migration } from '../../../src/db/migrations/20261115000000_unify_state_snapshots';

const SCHEMA = `
CREATE TABLE stateSnapshot (
    id       INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    type     VARCHAR(50) NOT NULL,
    state    TEXT,
    stateHash VARCHAR(64),
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX statesnapshot_statehash_index ON stateSnapshot (stateHash);
CREATE INDEX statesnapshot_type_index ON stateSnapshot (type);
`;

function openDb(dir: string): DatabaseSync {
	const db = new DatabaseSync(join(dir, 'test.sqlite'));
	db.exec(SCHEMA);
	return db;
}

function insertSnapshot(db: DatabaseSync, type: string, state: object, hash?: string): void {
	db.prepare(
		`INSERT INTO stateSnapshot (type, state, stateHash) VALUES (?, ?, ?)`
	).run(type, JSON.stringify(state), hash ?? null);
}

function getTypes(db: DatabaseSync): string[] {
	const rows = db.prepare(
		`SELECT DISTINCT type FROM stateSnapshot ORDER BY type`
	).all() as Array<{ type: string }>;
	return rows.map(r => r.type);
}

function getLatest(db: DatabaseSync, type: string): any | null {
	const row = db.prepare(
		`SELECT state FROM stateSnapshot WHERE type = ? ORDER BY createdAt DESC LIMIT 1`
	).get(type) as { state: string } | undefined;
	return row ? JSON.parse(row.state) : null;
}

function countByType(db: DatabaseSync, type: string): number {
	const row = db.prepare(
		`SELECT COUNT(*) AS n FROM stateSnapshot WHERE type = ?`
	).get(type) as { n: number };
	return row.n;
}

// Sample state fixtures
const sampleApps = {
	1: { appId: 1, appName: 'apps', services: [] },
	2: {
		appId: 2, appName: 'devices', services: [
			{ serviceId: '1794684086843', serviceName: 'opcua-server-003', imageName: 'iotistic/sim-opcua:latest', state: 'running' }
		]
	}
};

const sampleConfig = {
	endpoints: [
		{ uuid: '91fe2094-514e-4893-8a19-84b806d59cd0', name: 'opcua-server-003-5000-points', protocol: 'opcua', enabled: true, pollInterval: 5000 },
		{ uuid: 'aaaa-bbbb', name: 'disabled-endpoint', protocol: 'modbus', enabled: false, pollInterval: 10000 },
	],
	features: { anomalyDetection: true },
	logging: { level: 'info' },
};

const sampleDisabledConfig = {
	...sampleConfig,
	endpoints: sampleConfig.endpoints.map(e =>
		e.uuid === '91fe2094-514e-4893-8a19-84b806d59cd0' ? { ...e, enabled: false } : e
	),
};

let dir: string;
let db: DatabaseSync;

describe('unify_state_snapshots migration', () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'state-unify-'));
		db = openDb(dir);
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it('standard case: deletes apps-target, preserves target/current/config', () => {
		insertSnapshot(db, 'apps-target', { apps: sampleApps });
		insertSnapshot(db, 'target', { apps: sampleApps, config: sampleConfig });
		insertSnapshot(db, 'current', { apps: sampleApps, config: sampleConfig });
		insertSnapshot(db, 'config', sampleConfig);

		migration.up(db);

		const types = getTypes(db);
		assert.ok(!types.includes('apps-target'), 'apps-target should be removed');
		assert.ok(types.includes('target'), 'target should remain');
		assert.ok(types.includes('current'), 'current should remain');
		assert.ok(types.includes('config'), 'config should remain');
	});

	it('no target row: reconstructs unified target from apps-target + config', () => {
		insertSnapshot(db, 'apps-target', { apps: sampleApps });
		insertSnapshot(db, 'config', sampleConfig);

		migration.up(db);

		const types = getTypes(db);
		assert.ok(!types.includes('apps-target'), 'apps-target should be removed');
		assert.ok(types.includes('target'), 'target should be created');
		assert.ok(types.includes('current'), 'current should be created');

		const target = getLatest(db, 'target');
		assert.deepStrictEqual(Object.keys(target.apps).sort(), ['1', '2']);
		assert.ok(target.config.endpoints?.length === 2, 'target should have config endpoints');

		const current = getLatest(db, 'current');
		assert.deepStrictEqual(current.apps, {});
		assert.ok(current.config.endpoints?.length === 2, 'current should have config endpoints from config snapshot');
	});

	it('empty database: no-op', () => {
		migration.up(db);

		const types = getTypes(db);
		assert.deepStrictEqual(types, []);
	});

	it('already clean (no apps-target): no-op', () => {
		insertSnapshot(db, 'target', { apps: sampleApps, config: sampleConfig });
		insertSnapshot(db, 'current', { apps: sampleApps, config: sampleConfig });
		insertSnapshot(db, 'config', sampleConfig);

		migration.up(db);

		assert.equal(countByType(db, 'target'), 1);
		assert.equal(countByType(db, 'current'), 1);
		assert.equal(countByType(db, 'config'), 1);
		assert.equal(countByType(db, 'apps-target'), 0);
	});

	it('disabled endpoint preserved through migration', () => {
		insertSnapshot(db, 'apps-target', { apps: sampleApps });
		insertSnapshot(db, 'config', sampleDisabledConfig);

		migration.up(db);

		const target = getLatest(db, 'target');
		const opcuaEndpoint = target.config.endpoints.find(
			(e: any) => e.uuid === '91fe2094-514e-4893-8a19-84b806d59cd0'
		);
		assert.equal(opcuaEndpoint.enabled, false, 'disabled endpoint must stay disabled');

		const disabledEndpoint = target.config.endpoints.find(
			(e: any) => e.uuid === 'aaaa-bbbb'
		);
		assert.equal(disabledEndpoint.enabled, false, 'originally disabled endpoint must stay disabled');
	});

	it('only apps-target exists (no config): reconstructs target with empty config', () => {
		insertSnapshot(db, 'apps-target', { apps: sampleApps });

		migration.up(db);

		const target = getLatest(db, 'target');
		assert.ok(target, 'target should be created');
		assert.deepStrictEqual(Object.keys(target.apps).sort(), ['1', '2']);
		assert.deepStrictEqual(target.config, {});
		assert.equal(countByType(db, 'apps-target'), 0);
	});

	it('only config exists (no apps-target): reconstructs target with empty apps', () => {
		insertSnapshot(db, 'config', sampleConfig);

		migration.up(db);

		const target = getLatest(db, 'target');
		assert.ok(target, 'target should be created');
		assert.deepStrictEqual(target.apps, {});
		assert.ok(target.config.endpoints?.length === 2);
	});

	it('multiple apps-target rows: all are deleted', () => {
		insertSnapshot(db, 'apps-target', { apps: { 1: sampleApps[1] } });
		insertSnapshot(db, 'apps-target', { apps: sampleApps });
		insertSnapshot(db, 'target', { apps: sampleApps, config: sampleConfig });

		migration.up(db);

		assert.equal(countByType(db, 'apps-target'), 0);
		assert.equal(countByType(db, 'target'), 1);
	});

	it('idempotent: running migration twice is safe', () => {
		insertSnapshot(db, 'apps-target', { apps: sampleApps });
		insertSnapshot(db, 'config', sampleConfig);

		migration.up(db);
		migration.up(db);

		assert.equal(countByType(db, 'apps-target'), 0);
		assert.equal(countByType(db, 'target'), 1);
		assert.equal(countByType(db, 'config'), 1);
	});

	it('large endpoint config (5000 points) survives round-trip', () => {
		const largeEndpoints = Array.from({ length: 10 }, (_, i) => ({
			uuid: `endpoint-${i}`,
			name: `opcua-server-${i}`,
			protocol: 'opcua',
			enabled: true,
			pollInterval: 5000,
			dataPoints: Array.from({ length: 500 }, (_, j) => ({
				nodeId: `ns=2;s=point_${i}_${j}`,
				name: `Point ${j}`,
				dataType: 'Double',
			})),
		}));
		const largeConfig = { endpoints: largeEndpoints, features: {}, logging: { level: 'info' } };

		insertSnapshot(db, 'apps-target', { apps: sampleApps });
		insertSnapshot(db, 'config', largeConfig);

		migration.up(db);

		const target = getLatest(db, 'target');
		assert.equal(target.config.endpoints.length, 10);
		assert.equal(target.config.endpoints[0].dataPoints.length, 500);
		assert.equal(target.config.endpoints[9].dataPoints[499].nodeId, 'ns=2;s=point_9_499');
	});
});
