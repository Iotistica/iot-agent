import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type * as migrationRunner from '../../src/db/migration-runner';
import type { NativeSqliteMigration } from '../../src/db/migration-types';
import type * as nativeMigrationRegistry from '../../src/db/native-migrations';
import type * as sqlite from '../../src/db/sqlite';

describe('point identity migration', () => {
	const migrationName = '20261114000000_add_point_identity.js';
	let dbPath: string;
	let db: DatabaseSync;
	let getDatabase: () => DatabaseSync;
	let closeDatabase: () => void;
	let runMigrations: (database: DatabaseSync) => void;
	let migrations: NativeSqliteMigration[];
	let originalDatabasePath: string | undefined;
	let existingRows: Record<string, unknown[]>;

	function migrateBaseline(database: DatabaseSync): void {
		const idx = migrations.findIndex(m => m.name === migrationName);
		expect(idx).toBeGreaterThanOrEqual(0);
		const removed = migrations.splice(idx);
		try {
			runMigrations(database);
		} finally {
			migrations.push(...removed);
		}
	}

	function insertPoint(point: string, endpoint: string, protocol: string, device: string | null = null): void {
		db.prepare('INSERT INTO point_identity (point_uuid, endpoint_uuid, protocol, device_uuid) VALUES (?, ?, ?, ?)')
			.run(point, endpoint, protocol, device);
	}

	function insertAddress(endpoint: string, protocol: string, version: number, address: string, point: string): void {
		db.prepare(`
			INSERT INTO point_identity_address (endpoint_uuid, protocol, address_version, address_key, point_uuid)
			VALUES (?, ?, ?, ?, ?)
		`).run(endpoint, protocol, version, address, point);
	}

	function insertAlias(endpoint: string, kind: string, key: string, point: string): void {
		db.prepare(`
			INSERT INTO point_identity_alias (endpoint_uuid, alias_kind, alias_key, point_uuid, evidence)
			VALUES (?, ?, ?, ?, 'confirmed')
		`).run(endpoint, kind, key, point);
	}

	beforeAll(() => {
		originalDatabasePath = process.env.DATABASE_PATH;
		dbPath = path.join(os.tmpdir(), `point-identity-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
		process.env.DATABASE_PATH = dbPath;
		({ getDatabase, closeDatabase } = jest.requireActual<typeof sqlite>('../../src/db/sqlite'));
		({ runMigrations } = jest.requireActual<typeof migrationRunner>('../../src/db/migration-runner'));
		({ nativeMigrations: migrations } = jest.requireActual<typeof nativeMigrationRegistry>('../../src/db/native-migrations'));
		db = getDatabase();
		migrateBaseline(db);

		db.exec(`
			INSERT INTO endpoints (id, uuid, name, protocol, enabled, connection, data_points)
				VALUES (1, 'source-1', 'Existing source', 'opcua', 0, '{"url":"existing"}', '[{"name":"existing"}]');
			INSERT INTO devices (uuid, endpoint_id, name, protocol, enabled)
				VALUES ('device-1', 1, 'Existing device', 'opcua', 0);
			INSERT INTO device_resolution_keys (endpoint_id, device_uuid, kind, value)
				VALUES (1, 'device-1', 'serial', 'existing-key');
			INSERT INTO device_resolution_points (endpoint_id, device_uuid, address)
				VALUES (1, 'device-1', 'existing-address');
			INSERT INTO point_name_mappings
				(source_system, endpoint_name, device_key, raw_name, provisional_point_id, normalized_name, locked, method, rules_version)
				VALUES ('opcua', 'Existing source', 'device-1', 'Existing point', 'legacy-id', 'locked_name', 1, 'manual', 'v1');
		`);
		existingRows = Object.fromEntries(
			['endpoints', 'devices', 'device_resolution_keys', 'device_resolution_points', 'point_name_mappings']
				.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()])
		);
		runMigrations(db);
	});

	beforeEach(() => {
		db.exec('DELETE FROM point_identity_alias; DELETE FROM point_identity_address; DELETE FROM point_identity;');
	});

	afterAll(() => {
		closeDatabase?.();
		for (const suffix of ['', '-wal', '-shm']) {
			if (dbPath) fs.rmSync(`${dbPath}${suffix}`, { force: true });
		}
		if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
		else process.env.DATABASE_PATH = originalDatabasePath;
	});

	it('runs once through the native runner without modifying existing records or backfilling', () => {
		expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
		expect(db.prepare('SELECT name FROM schema_migrations WHERE name = ?').all(migrationName)).toHaveLength(1);
		for (const [table, rows] of Object.entries(existingRows)) {
			expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
		}
		for (const table of ['point_identity', 'point_identity_address', 'point_identity_alias']) {
			expect(db.prepare(`SELECT * FROM ${table}`).all()).toHaveLength(0);
		}
		runMigrations(db);
		expect(db.prepare('SELECT name FROM schema_migrations WHERE name = ?').all(migrationName)).toHaveLength(1);
	});

	it('creates scoped foreign keys and the specified indexes with binary keys', () => {
		const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_point_identity%'")
			.all().map((row) => row.name);
		expect(names.sort()).toEqual([
			'idx_point_identity_address_point', 'idx_point_identity_alias_point',
			'idx_point_identity_device', 'idx_point_identity_source',
		]);
		expect(db.prepare('PRAGMA table_info(point_identity)').all().map((row) => row.name)).toEqual([
			'point_uuid', 'endpoint_uuid', 'protocol', 'device_uuid', 'association_source', 'created_at', 'updated_at',
		]);
		expect(db.prepare('PRAGMA table_info(point_identity_address)').all().map((row) => row.name)).toEqual([
			'endpoint_uuid', 'protocol', 'address_version', 'address_key', 'point_uuid', 'created_at',
		]);
		expect(db.prepare('PRAGMA table_info(point_identity_alias)').all().map((row) => row.name)).toEqual([
			'endpoint_uuid', 'alias_kind', 'alias_key', 'point_uuid', 'evidence', 'created_at',
		]);
		expect(db.prepare('PRAGMA index_list(point_identity)').all().find((row) => row.name === 'idx_point_identity_device'))
			.toMatchObject({ partial: 1 });
		const addressForeignKeys = db.prepare('PRAGMA foreign_key_list(point_identity_address)').all();
		const aliasForeignKeys = db.prepare('PRAGMA foreign_key_list(point_identity_alias)').all();
		expect(addressForeignKeys.map((row) => [row.from, row.to])).toEqual([
			['point_uuid', 'point_uuid'], ['endpoint_uuid', 'endpoint_uuid'], ['protocol', 'protocol'],
		]);
		expect(aliasForeignKeys.map((row) => [row.from, row.to])).toEqual([
			['point_uuid', 'point_uuid'], ['endpoint_uuid', 'endpoint_uuid'],
		]);
		for (const [table, key] of [['point_identity_address', 'address_key'], ['point_identity_alias', 'alias_key']]) {
			const primary = db.prepare(`PRAGMA index_list(${table})`).all().find((row) => row.origin === 'pk');
			expect(primary).toBeDefined();
			const columns = db.prepare(`PRAGMA index_xinfo('${primary?.name}')`).all();
			expect(columns.find((row) => row.name === key)).toMatchObject({ coll: 'BINARY' });
		}
		expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
	});

	it('rolls back all new objects and history on failure, then permits a clean retry', () => {
		const isolated = new DatabaseSync(':memory:');
		try {
			migrateBaseline(isolated);
			isolated.exec("INSERT INTO endpoints (uuid, name, protocol, connection) VALUES ('preserved', 'Preserved', 'mqtt', '{}')");
			const rows = isolated.prepare("SELECT * FROM endpoints WHERE uuid = 'preserved'").all();
			isolated.exec('CREATE VIEW point_identity_alias AS SELECT 1 AS marker');
			expect(() => runMigrations(isolated)).toThrow();
			expect(isolated.prepare("SELECT name FROM sqlite_master WHERE name IN ('point_identity', 'point_identity_address')").all()).toEqual([]);
			expect(isolated.prepare('SELECT name FROM schema_migrations WHERE name = ?').all(migrationName)).toEqual([]);
			expect(isolated.prepare('SELECT marker FROM point_identity_alias').get()).toMatchObject({ marker: 1 });
			expect(isolated.prepare("SELECT * FROM endpoints WHERE uuid = 'preserved'").all()).toEqual(rows);
			isolated.exec('DROP VIEW point_identity_alias');
			runMigrations(isolated);
			expect(isolated.prepare('SELECT name FROM schema_migrations WHERE name = ?').all(migrationName)).toHaveLength(1);
		} finally {
			isolated.close();
		}
	});

	it('supports optional devices, scoped addresses, and binary-exact keys', () => {
		insertPoint('p1', 'source-1', 'opcua');
		insertPoint('p2', 'source-1', 'opcua');
		insertPoint('p3', 'source-2', 'opcua');
		insertPoint('p4', 'source-1', 'mqtt');
		expect(db.prepare('SELECT device_uuid FROM point_identity WHERE point_uuid = ?').get('p1'))
			.toMatchObject({ device_uuid: null });
		insertAddress('source-1', 'opcua', 1, 'Address', 'p1');
		expect(() => insertAddress('source-1', 'opcua', 1, 'Address', 'p2')).toThrow();
		insertAddress('source-1', 'opcua', 1, 'address', 'p2');
		insertAddress('source-1', 'opcua', 2, 'Address', 'p2');
		insertAddress('source-2', 'opcua', 1, 'Address', 'p3');
		insertAddress('source-1', 'mqtt', 1, 'Address', 'p4');
		insertAlias('source-1', 'legacy', 'Name', 'p1');
		insertAlias('source-1', 'legacy', 'name', 'p2');
		expect(() => insertAlias('source-1', 'legacy', 'Name', 'p2')).toThrow();
		insertAlias('source-2', 'legacy', 'Name', 'p3');
		expect(db.prepare('SELECT count(*) AS count FROM point_identity_address').get()).toMatchObject({ count: 5 });
	});

	it('rejects missing and cross-scope references with foreign keys active', () => {
		insertPoint('p1', 'source-1', 'opcua');
		expect(() => insertAddress('source-2', 'opcua', 1, 'a', 'p1')).toThrow(/FOREIGN KEY/);
		expect(() => insertAddress('source-1', 'mqtt', 1, 'a', 'p1')).toThrow(/FOREIGN KEY/);
		expect(() => insertAddress('source-1', 'opcua', 1, 'a', 'missing')).toThrow(/FOREIGN KEY/);
		expect(() => insertAlias('source-2', 'legacy', 'a', 'p1')).toThrow(/FOREIGN KEY/);
		expect(() => insertAlias('source-1', 'legacy', 'a', 'missing')).toThrow(/FOREIGN KEY/);
		insertAddress('source-1', 'opcua', 1, 'a', 'p1');
		expect(() => db.prepare('DELETE FROM point_identity WHERE point_uuid = ?').run('p1')).toThrow(/FOREIGN KEY/);
	});

	it('rejects empty identifiers, empty keys, and invalid address versions', () => {
		expect(() => insertPoint('', 'source-1', 'opcua')).toThrow();
		expect(() => insertPoint('p1', ' ', 'opcua')).toThrow();
		expect(() => insertPoint('p1', 'source-1', '')).toThrow();
		expect(() => insertPoint('p1', 'source-1', 'opcua', '')).toThrow();
		insertPoint('p1', 'source-1', 'opcua');
		for (const version of [0, -1, 1.5]) {
			expect(() => insertAddress('source-1', 'opcua', version, 'a', 'p1')).toThrow();
		}
		expect(() => insertAddress('source-1', 'opcua', 1, '', 'p1')).toThrow();
		expect(() => insertAlias('source-1', '', 'a', 'p1')).toThrow();
		expect(() => insertAlias('source-1', 'legacy', '', 'p1')).toThrow();
		expect(() => db.prepare(`
			INSERT INTO point_identity_alias (endpoint_uuid, alias_kind, alias_key, point_uuid, evidence)
			VALUES ('source-1', 'legacy', 'a', 'p1', '')
		`).run()).toThrow();
	});

	it('retains identities independently of deleted endpoints and devices', () => {
		db.exec(`
			INSERT INTO endpoints (id, uuid, name, protocol, connection) VALUES (2, 'source-2', 'Other', 'mqtt', '{}');
			INSERT INTO devices (uuid, endpoint_id, name, protocol) VALUES ('device-2', 2, 'Other device', 'mqtt');
		`);
		insertPoint('p1', 'source-2', 'mqtt', 'device-2');
		insertAddress('source-2', 'mqtt', 1, 'topic', 'p1');
		db.exec("DELETE FROM devices WHERE uuid = 'device-2'; DELETE FROM endpoints WHERE id = 2;");
		expect(db.prepare('SELECT endpoint_uuid, device_uuid FROM point_identity WHERE point_uuid = ?').get('p1'))
			.toMatchObject({ endpoint_uuid: 'source-2', device_uuid: 'device-2' });
		expect(db.prepare('SELECT point_uuid FROM point_identity_address WHERE point_uuid = ?').get('p1'))
			.toMatchObject({ point_uuid: 'p1' });
	});

	it('enforces uniqueness across overlapping writers on separate connections', () => {
		insertPoint('p1', 'source-1', 'opcua');
		insertPoint('p2', 'source-1', 'opcua');
		const other = new DatabaseSync(dbPath);
		let transactionOpen = false;
		try {
			expect(other.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
			other.exec('PRAGMA busy_timeout = 0');
			db.exec('BEGIN IMMEDIATE');
			transactionOpen = true;
			insertAddress('source-1', 'opcua', 1, 'a', 'p1');
			const writeOther = () => other.prepare(`
				INSERT INTO point_identity_address (endpoint_uuid, protocol, address_version, address_key, point_uuid)
				VALUES ('source-1', 'opcua', 1, 'a', 'p2')
			`).run();
			expect(writeOther).toThrow(/locked|busy/i);
			db.exec('COMMIT');
			transactionOpen = false;
			expect(writeOther).toThrow(/UNIQUE/);
			expect(db.prepare('SELECT point_uuid FROM point_identity_address').all()).toEqual([expect.objectContaining({ point_uuid: 'p1' })]);
		} finally {
			if (transactionOpen) db.exec('ROLLBACK');
			other.close();
		}
	});

	it('survives reopening while existing-table reads and writes remain usable', () => {
		insertPoint('p1', 'source-1', 'opcua');
		insertAddress('source-1', 'opcua', 1, 'a', 'p1');
		insertAlias('source-1', 'legacy', 'name', 'p1');
		closeDatabase();
		db = getDatabase();
		expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
		expect(db.prepare('SELECT point_uuid FROM point_identity_address').all()).toHaveLength(1);
		expect(db.prepare('SELECT point_uuid FROM point_identity_alias').all()).toHaveLength(1);
		db.prepare('UPDATE endpoints SET name = ? WHERE id = ?').run('Updated source', 1);
		expect(db.prepare('SELECT name FROM endpoints WHERE id = ?').get(1)).toMatchObject({ name: 'Updated source' });
		db.prepare('UPDATE endpoints SET name = ? WHERE id = ?').run('Existing source', 1);
		expect(db.prepare('SELECT normalized_name, locked FROM point_name_mappings').get())
			.toMatchObject({ normalized_name: 'locked_name', locked: 1 });
	});
});
