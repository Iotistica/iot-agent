import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../../src/db/migration-runner';
import { canonicalizeAddress } from '../../src/points/canonical-address';
import {
	PointIdentityCatalog,
	type CatalogEvidenceVerifier,
	type PointAddress,
	type PointIdentityRecord,
} from '../../src/points/point-identity-catalog';

describe('isolated point identity catalog', () => {
	let db: DatabaseSync;
	let dbPath: string;
	let catalog: PointIdentityCatalog;
	const verifier: CatalogEvidenceVerifier = { verify: () => true };
	const address: PointAddress = { endpointUuid: 'source-1', protocol: 'mqtt', version: 1, key: 'address-1' };
	const alias = { endpointUuid: 'source-1', protocol: 'mqtt' as const, kind: 'legacy', key: 'old-name', evidence: 'fixture' };

	function point(result: Awaited<ReturnType<PointIdentityCatalog['createIdentityIfAbsent']>>): PointIdentityRecord {
		if (result.status !== 'resolved') throw new Error(`Unexpected catalog result: ${result.reason}`);
		return result.value;
	}

	beforeEach(() => {
		dbPath = path.join(os.tmpdir(), `catalog-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
		db = new DatabaseSync(dbPath);
		db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 1');
		runMigrations(db);
		db.exec(`
			INSERT INTO endpoints (id, uuid, name, protocol, connection, data_points)
				VALUES (1, 'source-1', 'Source', 'mqtt', '{}', '[]'),
					(2, 'source-2', 'Other', 'mqtt', '{}', '[]'),
					(3, 'source-3', 'OPC', 'opcua', '{}', '[]');
			INSERT INTO devices (uuid, endpoint_id, name, protocol, enabled)
				VALUES ('device-1', 1, 'Device', 'mqtt', 0), ('device-2', 1, 'Other device', 'mqtt', 1);
			INSERT INTO device_resolution_keys (endpoint_id, device_uuid, kind, value)
				VALUES (1, 'device-1', 'serial', 'fixture');
			INSERT INTO point_name_mappings
				(source_system, endpoint_name, device_key, raw_name, provisional_point_id, normalized_name, locked, method, rules_version)
				VALUES ('mqtt', 'Source', 'device-1', 'Point', 'legacy', 'locked_name', 1, 'manual', 'v1');
		`);
		catalog = new PointIdentityCatalog(db, verifier);
	});

	afterEach(() => {
		db.close();
		for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
	});

	it('requires verifier admission and never creates on lookup or unresolved inputs', async () => {
		expect(catalog.findByCanonicalAddress(address)).toMatchObject({ status: 'unresolved', reason: 'not-found' });
		expect(catalog.resolveExistingIdentity(address, [], 'fixture')).toMatchObject({ status: 'unresolved', reason: 'not-found' });
		expect(await new PointIdentityCatalog(db).createIdentityIfAbsent(address, 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'evidence-missing' });
		expect(await new PointIdentityCatalog(db, { verify: () => false }).createIdentityIfAbsent(address, 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'evidence-missing' });
		expect(await catalog.createIdentityIfAbsent({ ...address, key: '\ud800' }, 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'invalid-input' });
		expect(await catalog.createIdentityIfAbsent({ ...address, key: 'address\0suffix' }, 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'invalid-input' });
		expect(await catalog.attachVerifiedAlias('point', { ...alias, key: 'alias\0suffix' }, 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'invalid-input' });
		expect(await catalog.createIdentityIfAbsent({ ...address, version: 2 }, 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'version-unreconciled' });
		expect(db.prepare('SELECT * FROM point_identity').all()).toEqual([]);
	});

	it('requires fixture admission in addition to a canonical key and rejects ambiguous candidates', async () => {
		const input = { protocol: 'mqtt', topic: 'factory/line1', selector: { kind: 'whole' }, selectorSource: 'configured' } as const;
		const canonical = canonicalizeAddress(input);
		if (canonical.status !== 'resolved') throw new Error('Expected canonical fixture');
		const ambiguous = canonicalizeAddress({ ...input, selector: 'motor.speed' });
		expect(ambiguous).toMatchObject({ status: 'unresolved', reason: 'ambiguous-legacy-selector' });
		const admission = Symbol('fixture-only admission');
		const candidate = { ...address, key: canonical.addressKey };
		const guarded = new PointIdentityCatalog(db, { verify: request =>
			request.operation === 'create' && request.address.endpointUuid === 'source-1' &&
			request.address.protocol === canonical.protocol && request.address.version === canonical.version &&
			request.address.key === canonical.addressKey && request.evidence === admission,
		});
		expect(await guarded.createIdentityIfAbsent({ ...candidate, key: 'noncanonical' }, admission))
			.toMatchObject({ status: 'unresolved', reason: 'evidence-missing' });
		expect(await guarded.createIdentityIfAbsent(candidate, { verified: true, canonical: ambiguous }))
			.toMatchObject({ status: 'unresolved', reason: 'evidence-missing' });
		expect(await guarded.createIdentityIfAbsent(candidate, { verified: true, canonical }))
			.toMatchObject({ status: 'unresolved', reason: 'evidence-missing' });
		expect(db.prepare('SELECT * FROM point_identity').all()).toEqual([]);
		expect(await guarded.createIdentityIfAbsent(candidate, admission)).toMatchObject({ status: 'resolved' });
	});

	it('atomically creates a nullable-device identity and preserves it after reopening', async () => {
		const created = point(await catalog.createIdentityIfAbsent(address, 'fixture'));
		expect(created).toEqual({ pointUuid: expect.any(String), endpointUuid: 'source-1', protocol: 'mqtt', deviceUuid: null });
		expect(point(await catalog.createIdentityIfAbsent(address, 'fixture'))).toEqual(created);
		db.close();
		db = new DatabaseSync(dbPath);
		catalog = new PointIdentityCatalog(db, verifier);
		expect(catalog.findByCanonicalAddress(address)).toEqual({ status: 'resolved', value: created });
		expect(db.prepare('SELECT count(*) AS count FROM point_identity').get()).toMatchObject({ count: 1 });
	});

	it('keeps exact addresses scoped and does not change legacy records', async () => {
		const tables = ['endpoints', 'devices', 'device_resolution_keys', 'device_resolution_points', 'point_name_mappings'];
		const before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
		const first = point(await catalog.createIdentityIfAbsent(address, 'fixture'));
		const second = point(await catalog.createIdentityIfAbsent({ ...address, endpointUuid: 'source-2' }, 'fixture'));
		const third = point(await catalog.createIdentityIfAbsent({ ...address, endpointUuid: 'source-3', protocol: 'opcua' }, 'fixture'));
		expect(new Set([first.pointUuid, second.pointUuid, third.pointUuid]).size).toBe(3);
		expect(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
		expect(await catalog.attachVerifiedAddress(first.pointUuid, { ...address, endpointUuid: 'source-2' }, 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'protocol-mismatch' });
	});

	it('never steals addresses or aliases, or attaches a second address at the same version', async () => {
		const first = point(await catalog.createIdentityIfAbsent(address, 'fixture'));
		const secondAddress = { ...address, key: 'address-2' };
		const second = point(await catalog.createIdentityIfAbsent(secondAddress, 'fixture'));
		expect(await catalog.attachVerifiedAddress(first.pointUuid, secondAddress, 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'address-conflict' });
		expect(await catalog.attachVerifiedAddress(first.pointUuid, { ...address, key: 'address-3' }, 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'address-conflict' });
		expect(await catalog.attachVerifiedAlias(first.pointUuid, alias, 'fixture')).toMatchObject({ status: 'resolved' });
		expect(await catalog.attachVerifiedAlias(second.pointUuid, alias, 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'alias-conflict' });
		expect(catalog.resolveExistingIdentity(secondAddress, [alias], 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'identity-ambiguous' });
		expect(catalog.findAliases(address, first.pointUuid)).toEqual({ status: 'resolved', value: [alias] });
	});

	it('fails closed on a cross-protocol alias and an unreconciled stored version', async () => {
		db.exec(`
			INSERT INTO point_identity (point_uuid, endpoint_uuid, protocol) VALUES ('other-protocol', 'source-1', 'opcua');
			INSERT INTO point_identity_alias (endpoint_uuid, alias_kind, alias_key, point_uuid, evidence)
				VALUES ('source-1', 'legacy', 'old-name', 'other-protocol', 'fixture');
		`);
		expect(catalog.resolveExistingIdentity(address, [alias], 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'alias-conflict' });
		expect(await catalog.attachVerifiedAlias('other-protocol', alias, 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'protocol-mismatch' });
		db.exec(`
			INSERT INTO point_identity (point_uuid, endpoint_uuid, protocol) VALUES ('future', 'source-1', 'mqtt');
			INSERT INTO point_identity_address (endpoint_uuid, protocol, address_version, address_key, point_uuid)
				VALUES ('source-1', 'mqtt', 2, 'future-key', 'future');
		`);
		expect(await catalog.createIdentityIfAbsent(address, 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'version-unreconciled' });
	});

	it('does not trust an address row corrupted while foreign keys were disabled', async () => {
		db.exec(`
			PRAGMA foreign_keys = OFF;
			INSERT INTO point_identity (point_uuid, endpoint_uuid, protocol) VALUES ('wrong-scope', 'source-2', 'mqtt');
			INSERT INTO point_identity_address (endpoint_uuid, protocol, address_version, address_key, point_uuid)
				VALUES ('source-1', 'mqtt', 1, 'address-1', 'wrong-scope');
			INSERT INTO point_identity_address (endpoint_uuid, protocol, address_version, address_key, point_uuid)
				VALUES ('source-1', 'mqtt', 1, 'orphan', 'missing');
			INSERT INTO point_identity_alias (endpoint_uuid, alias_kind, alias_key, point_uuid, evidence)
				VALUES ('source-1', 'legacy', 'orphan', 'missing', 'fixture');
			PRAGMA foreign_keys = ON;
		`);
		expect(catalog.findByCanonicalAddress(address)).toMatchObject({ status: 'unresolved', reason: 'identity-ambiguous' });
		expect(catalog.resolveExistingIdentity(address, [], 'fixture')).toMatchObject({ status: 'unresolved', reason: 'identity-ambiguous' });
		expect(await catalog.createIdentityIfAbsent(address, 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'identity-ambiguous' });
		expect(() => catalog.findByCanonicalAddress({ ...address, key: 'orphan' })).toThrow(/missing identity/);
		expect(() => catalog.resolveExistingIdentity({ ...address, key: 'unknown' }, [{ ...alias, key: 'orphan' }], 'fixture'))
			.toThrow(/missing identity/);
	});

	it('rejects source ambiguity, mismatch and stale endpoint state', async () => {
		expect(await catalog.createIdentityIfAbsent({ ...address, endpointUuid: 'missing' }, 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'source-missing' });
		expect(await catalog.createIdentityIfAbsent({ ...address, protocol: 'opcua' }, 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'protocol-mismatch' });
		const stale = new PointIdentityCatalog(db, { verify: () => {
			db.prepare("UPDATE endpoints SET connection = '{\"changed\":true}' WHERE id = 1").run();
			return true;
		} });
		expect(await stale.createIdentityIfAbsent(address, 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'stale-configuration' });
		db.exec("DROP INDEX endpoints_uuid_unique; INSERT INTO endpoints (uuid, name, protocol, connection) VALUES ('source-1', 'Duplicate', 'mqtt', '{}')");
		expect(await catalog.createIdentityIfAbsent(address, 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'source-ambiguous' });
		expect(db.prepare('SELECT * FROM point_identity').all()).toEqual([]);
	});

	it('requires confirmed source-scoped devices and uses compare-and-swap without modifying evidence', async () => {
		const created = point(await catalog.createIdentityIfAbsent(address, 'fixture'));
		const devices = db.prepare('SELECT * FROM devices').all();
		const evidence = db.prepare('SELECT * FROM device_resolution_keys').all();
		expect(await catalog.updateOptionalDeviceAssociation(created.pointUuid, address, 'device-2', null, 'fixture', 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'association-conflict' });
		expect(await catalog.updateOptionalDeviceAssociation(created.pointUuid, address, 'device-1', null, 'fixture', 'fixture'))
			.toMatchObject({ status: 'resolved', value: { pointUuid: created.pointUuid, deviceUuid: 'device-1' } });
		expect(await catalog.updateOptionalDeviceAssociation(created.pointUuid, address, null, null, 'fixture', 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'association-conflict' });
		expect(await catalog.updateOptionalDeviceAssociation(created.pointUuid, address, null, 'device-1', 'fixture', 'fixture'))
			.toMatchObject({ status: 'resolved', value: { pointUuid: created.pointUuid, deviceUuid: null } });
		expect(db.prepare('SELECT * FROM devices').all()).toEqual(devices);
		expect(db.prepare('SELECT * FROM device_resolution_keys').all()).toEqual(evidence);
	});

	it('does not rewrite an unchanged authorized association, and still enforces compare-and-swap', async () => {
		const created = point(await catalog.createIdentityIfAbsent(address, 'fixture'));
		expect(await catalog.updateOptionalDeviceAssociation(created.pointUuid, address, 'device-1', null, 'confirmed', 'fixture'))
			.toMatchObject({ status: 'resolved' });
		db.prepare("UPDATE point_identity SET updated_at = '2000-01-01 00:00:00' WHERE point_uuid = ?").run(created.pointUuid);
		db.exec(`
			CREATE TEMP TABLE association_updates (marker INTEGER);
			CREATE TEMP TRIGGER count_association_updates AFTER UPDATE ON point_identity BEGIN
				INSERT INTO association_updates VALUES (1);
			END;
		`);
		const before = db.prepare('SELECT * FROM point_identity WHERE point_uuid = ?').get(created.pointUuid);
		expect(await catalog.updateOptionalDeviceAssociation(created.pointUuid, address, 'device-1', 'device-1', 'confirmed', 'fixture'))
			.toMatchObject({ status: 'resolved', value: { deviceUuid: 'device-1' } });
		expect(db.prepare('SELECT * FROM point_identity WHERE point_uuid = ?').get(created.pointUuid)).toEqual(before);
		expect(db.prepare('SELECT * FROM association_updates').all()).toEqual([]);
		expect(await catalog.updateOptionalDeviceAssociation(created.pointUuid, address, 'device-1', null, 'confirmed', 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'association-conflict' });
		expect(await new PointIdentityCatalog(db, { verify: () => false })
			.updateOptionalDeviceAssociation(created.pointUuid, address, 'device-1', 'device-1', 'confirmed', 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'evidence-missing' });
		expect(db.prepare('SELECT * FROM association_updates').all()).toEqual([]);
		expect(await catalog.updateOptionalDeviceAssociation(created.pointUuid, address, 'device-1', 'device-1', 'new-source', 'fixture'))
			.toMatchObject({ status: 'resolved' });
		expect(db.prepare('SELECT * FROM association_updates').all()).toHaveLength(1);
		expect(db.prepare('SELECT association_source FROM point_identity WHERE point_uuid = ?').get(created.pointUuid))
			.toMatchObject({ association_source: 'new-source' });
		expect(await catalog.updateOptionalDeviceAssociation(created.pointUuid, address, null, 'device-1', 'new-source', 'fixture'))
			.toMatchObject({ status: 'resolved', value: { deviceUuid: null } });
		const cleared = db.prepare('SELECT * FROM point_identity WHERE point_uuid = ?').get(created.pointUuid);
		expect(await catalog.updateOptionalDeviceAssociation(created.pointUuid, address, null, null, 'new-source', 'fixture'))
			.toMatchObject({ status: 'resolved', value: { deviceUuid: null } });
		expect(db.prepare('SELECT * FROM point_identity WHERE point_uuid = ?').get(created.pointUuid)).toEqual(cleared);
		expect(db.prepare('SELECT * FROM association_updates').all()).toHaveLength(2);
	});

	it('fails closed with disabled foreign keys or query-only connections', async () => {
		db.exec('PRAGMA foreign_keys = OFF');
		expect(catalog.findByCanonicalAddress(address)).toMatchObject({ status: 'unresolved', reason: 'foreign-keys-disabled' });
		expect(await catalog.createIdentityIfAbsent(address, 'fixture')).toMatchObject({ status: 'unresolved', reason: 'foreign-keys-disabled' });
		db.exec('PRAGMA foreign_keys = ON; PRAGMA query_only = ON');
		expect(await catalog.createIdentityIfAbsent(address, 'fixture')).toMatchObject({ status: 'unresolved', reason: 'read-only' });
		db.exec('PRAGMA query_only = OFF');
		expect(db.prepare('SELECT * FROM point_identity').all()).toEqual([]);
	});

	it('rolls back both inserts on a real SQLite failure', async () => {
		db.exec("CREATE TRIGGER fail_address BEFORE INSERT ON point_identity_address BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
		await expect(catalog.createIdentityIfAbsent(address, 'fixture')).rejects.toThrow('fixture failure');
		expect(db.prepare('SELECT * FROM point_identity').all()).toEqual([]);
	});

	it('preserves caller-owned transaction changes when a nested operation is rejected', async () => {
		const supportsTransactionState = typeof db.isTransaction === 'boolean';
		const verify = jest.fn(() => true);
		const guarded = new PointIdentityCatalog(db, { verify });
		db.exec("BEGIN; UPDATE endpoints SET name = 'Outer transaction' WHERE id = 1");
		if (supportsTransactionState) {
			expect(await guarded.createIdentityIfAbsent(address, 'fixture'))
				.toMatchObject({ status: 'unresolved', reason: 'transaction-active' });
			expect(verify).not.toHaveBeenCalled();
		} else {
			await expect(guarded.createIdentityIfAbsent(address, 'fixture')).rejects.toThrow(/transaction within a transaction/);
			expect(verify).toHaveBeenCalledTimes(1);
		}
		expect(db.prepare('SELECT name FROM endpoints WHERE id = 1').get()).toMatchObject({ name: 'Outer transaction' });
		db.exec('COMMIT');
		expect(db.prepare('SELECT name FROM endpoints WHERE id = 1').get()).toMatchObject({ name: 'Outer transaction' });
		expect(db.prepare('SELECT * FROM point_identity').all()).toEqual([]);
	});

	it('checks exposed transaction state before verifier calls and prevents verifier reentrancy', async () => {
		const verify = jest.fn(() => true);
		const guarded = new PointIdentityCatalog(db, { verify });
		db.exec('BEGIN');
		if (typeof db.isTransaction !== 'boolean') {
			Object.defineProperty(db, 'isTransaction', { configurable: true, value: true });
		}
		try {
			expect(await guarded.createIdentityIfAbsent(address, 'fixture'))
				.toMatchObject({ status: 'unresolved', reason: 'transaction-active' });
			expect(guarded.resolveExistingIdentity(address, [], 'fixture'))
				.toMatchObject({ status: 'unresolved', reason: 'transaction-active' });
			expect(verify).not.toHaveBeenCalled();
		} finally {
			db.exec('ROLLBACK');
			if (Object.hasOwn(db, 'isTransaction')) Reflect.deleteProperty(db, 'isTransaction');
		}
		let recursive: ReturnType<PointIdentityCatalog['createIdentityIfAbsent']> | undefined;
		const nested = new PointIdentityCatalog(db, { verify: () => {
			recursive = guarded.createIdentityIfAbsent(address, 'fixture');
			return false;
		} });
		expect(await nested.createIdentityIfAbsent(address, 'fixture'))
			.toMatchObject({ status: 'unresolved', reason: 'evidence-missing' });
		expect(await recursive).toMatchObject({ status: 'unresolved', reason: 'reentrant-operation' });
		expect(verify).not.toHaveBeenCalled();
		expect(db.prepare('SELECT * FROM point_identity').all()).toEqual([]);
	});

	it('does not return a UUID when a deferred foreign-key failure occurs at commit', async () => {
		db.exec(`
			CREATE TRIGGER invalid_alias AFTER INSERT ON point_identity_address BEGIN
				INSERT INTO point_identity_alias (endpoint_uuid, alias_kind, alias_key, point_uuid, evidence)
					VALUES ('source-1', 'fixture', 'invalid', 'missing', 'fixture');
			END;
			PRAGMA defer_foreign_keys = ON;
		`);
		await expect(catalog.createIdentityIfAbsent(address, 'fixture')).rejects.toThrow(/FOREIGN KEY/);
		expect(db.prepare('SELECT * FROM point_identity').all()).toEqual([]);
		expect(db.prepare('SELECT * FROM point_identity_address').all()).toEqual([]);
		expect(db.prepare('SELECT * FROM point_identity_alias').all()).toEqual([]);
	});

	it('converges on a competing committed owner and reports persistent busy contention', async () => {
		const other = new DatabaseSync(dbPath);
		other.exec('PRAGMA busy_timeout = 1; BEGIN IMMEDIATE');
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			other.exec(`
				INSERT INTO point_identity (point_uuid, endpoint_uuid, protocol) VALUES ('winner', 'source-1', 'mqtt');
				INSERT INTO point_identity_address (endpoint_uuid, protocol, address_version, address_key, point_uuid)
					VALUES ('source-1', 'mqtt', 1, 'address-1', 'winner');
			`);
			const pending = catalog.createIdentityIfAbsent(address, 'fixture');
			timer = setTimeout(() => other.exec('COMMIT'), 5);
			expect(point(await pending).pointUuid).toBe('winner');
			other.exec('BEGIN IMMEDIATE');
			expect(await catalog.createIdentityIfAbsent({ ...address, key: 'busy' }, 'fixture'))
				.toMatchObject({ status: 'unresolved', reason: 'busy', retryable: true });
			other.exec('ROLLBACK');
			expect(db.prepare('SELECT count(*) AS count FROM point_identity').get()).toMatchObject({ count: 1 });
		} finally {
			if (timer) clearTimeout(timer);
			other.close();
		}
	});

	it('rejects a changed endpoint configuration after a contended write lock', async () => {
		const other = new DatabaseSync(dbPath);
		other.exec(`BEGIN IMMEDIATE; UPDATE endpoints SET data_points = '[{"changed":true}]' WHERE id = 1`);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const pending = catalog.createIdentityIfAbsent(address, 'fixture');
			timer = setTimeout(() => other.exec('COMMIT'), 5);
			expect(await pending).toMatchObject({ status: 'unresolved', reason: 'stale-configuration' });
			expect(db.prepare('SELECT * FROM point_identity').all()).toEqual([]);
		} finally {
			if (timer) clearTimeout(timer);
			other.close();
		}
	});

	it('rechecks evidence after a contended write before creating an identity', async () => {
		const other = new DatabaseSync(dbPath);
		other.exec('PRAGMA busy_timeout = 1; BEGIN IMMEDIATE');
		let current = true;
		const verify = jest.fn(() => current);
		const guarded = new PointIdentityCatalog(db, { verify });
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const pending = guarded.createIdentityIfAbsent(address, 'fixture');
			timer = setTimeout(() => {
				current = false;
				other.exec('COMMIT');
			}, 5);
			expect(await pending).toMatchObject({ status: 'unresolved', reason: 'evidence-missing' });
			expect(verify).toHaveBeenCalledTimes(2);
			expect(db.prepare('SELECT * FROM point_identity').all()).toEqual([]);
			expect(db.prepare('SELECT * FROM point_identity_address').all()).toEqual([]);
		} finally {
			if (timer) clearTimeout(timer);
			other.close();
		}
	});

	it('surfaces read contention before and after verification without leaving a transaction open', () => {
		db.exec('PRAGMA journal_mode = DELETE');
		const other = new DatabaseSync(dbPath);
		other.exec('PRAGMA busy_timeout = 1; BEGIN EXCLUSIVE');
		const verify = jest.fn(() => true);
		const guarded = new PointIdentityCatalog(db, { verify });
		try {
			expect(() => guarded.resolveExistingIdentity(address, [], 'fixture')).toThrow(/database is locked/);
			expect(verify).not.toHaveBeenCalled();
			other.exec('ROLLBACK');
			const locksDuringVerification = new PointIdentityCatalog(db, { verify: () => {
				other.exec('BEGIN EXCLUSIVE');
				return true;
			} });
			expect(() => locksDuringVerification.resolveExistingIdentity(address, [], 'fixture')).toThrow(/database is locked/);
			other.exec('ROLLBACK');
			db.exec('BEGIN; ROLLBACK');
			expect(db.prepare('SELECT * FROM point_identity').all()).toEqual([]);
		} finally {
			other.close();
		}
	});

	it('detects stale configuration via revision trigger during identity resolution', async () => {
		const created = await catalog.createIdentityIfAbsent(address, 'fixture');
		expect(created.status).toBe('resolved');

		const staleCatalog = new PointIdentityCatalog(db, verifier);
		const initial = staleCatalog.resolveExistingIdentity(address, [alias], 'fixture');
		expect(initial.status).toBe('resolved');

		const rev0 = db.prepare('SELECT revision FROM endpoints WHERE uuid = ?').get('source-1') as { revision: number };
		expect(rev0.revision).toBe(0);

		db.prepare('UPDATE endpoints SET connection = ? WHERE uuid = ?').run('{"url":"changed"}', 'source-1');
		const rev1 = db.prepare('SELECT revision FROM endpoints WHERE uuid = ?').get('source-1') as { revision: number };
		expect(rev1.revision).toBe(1);

		const staleResult = staleCatalog.resolveExistingIdentity(address, [alias], 'fixture');
		expect(staleResult).toMatchObject({ status: 'unresolved', reason: 'stale-configuration' });

		const freshCatalog = new PointIdentityCatalog(db, verifier);
		const freshResult = freshCatalog.resolveExistingIdentity(address, [alias], 'fixture');
		expect(freshResult.status).toBe('resolved');
	});
});
