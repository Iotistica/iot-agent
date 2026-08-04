import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';

// db-path.ts resolves its database path once, at module-init time, from
// process.env.DATABASE_PATH — must be set before the first require() of
// ../../src/db/sqlite, same convention as unit-catalog.model.integration.spec.ts.
describe('Point Name Normalization identity cache (integration)', () => {
	let dbPath: string;
	let PointNameMappingsModel: typeof import('../../src/db/models/point-name.model').PointNameMappingsModel;
	let closeDatabase: () => void;

	beforeAll(() => {
		dbPath = path.join(os.tmpdir(), `point-name-mappings-model-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
		process.env.DATABASE_PATH = dbPath;

		const sqlite = require('../../src/db/sqlite');
		const { runMigrations } = require('../../src/db/migration-runner');

		const db: DatabaseSync = sqlite.getDatabase();
		runMigrations(db);
		closeDatabase = sqlite.closeDatabase;

		PointNameMappingsModel = require('../../src/db/models/point-name.model').PointNameMappingsModel;
	});

	afterAll(() => {
		closeDatabase();
		for (const suffix of ['', '-wal', '-shm']) {
			fs.rmSync(`${dbPath}${suffix}`, { force: true });
		}
	});

	it('creates the point_name_mappings table via migration (getAll on an empty table returns [])', () => {
		expect(PointNameMappingsModel.getAll()).toEqual([]);
	});

	it('upsertMany inserts new rows and reads them back with source_fields round-tripped as an array', () => {
		PointNameMappingsModel.upsertMany([{
			source_system: 'bacnet',
			endpoint_name: 'ep-1',
			device_key: 'dev-1',
			raw_name: 'AHU-1 SAT',
			provisional_point_id: '11111111-2222-5333-8444-555555555555',
			normalized_name: 'ahu_1_sat',
			locked: true,
			method: 'algorithmic',
			source_fields: ['metric'],
			collision_suffix: null,
			rules_version: 'pn-rules-v1',
		}]);

		const rows = PointNameMappingsModel.getAll();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			source_system: 'bacnet',
			endpoint_name: 'ep-1',
			device_key: 'dev-1',
			raw_name: 'AHU-1 SAT',
			normalized_name: 'ahu_1_sat',
			locked: true,
			method: 'algorithmic',
			rules_version: 'pn-rules-v1',
		});
		expect(rows[0].source_fields).toEqual(['metric']);
	});

	it('upsertMany on an existing natural key updates in place rather than duplicating', () => {
		PointNameMappingsModel.upsertMany([{
			source_system: 'bacnet',
			endpoint_name: 'ep-1',
			device_key: 'dev-1',
			raw_name: 'AHU-1 SAT',
			provisional_point_id: '11111111-2222-5333-8444-555555555555',
			normalized_name: 'ahu_1_sat_renamed',
			locked: true,
			method: 'algorithmic',
			source_fields: ['metric'],
			collision_suffix: null,
			rules_version: 'pn-rules-v2',
		}]);

		const rows = PointNameMappingsModel.getAll();
		expect(rows).toHaveLength(1); // still one row, not two
		expect(rows[0].normalized_name).toBe('ahu_1_sat_renamed');
		expect(rows[0].rules_version).toBe('pn-rules-v2');
	});

	it('a NULL source_system row is distinct from a non-NULL one on the same (endpoint,device,raw_name) — NULL-safe natural-key handling', () => {
		PointNameMappingsModel.upsertMany([{
			source_system: null,
			endpoint_name: 'ep-1',
			device_key: 'dev-1',
			raw_name: 'AHU-1 SAT',
			provisional_point_id: '22222222-3333-5444-8555-666666666666',
			normalized_name: 'ahu_1_sat',
			locked: true,
			method: 'algorithmic',
			source_fields: ['metric'],
			collision_suffix: null,
			rules_version: 'pn-rules-v1',
		}]);

		const rows = PointNameMappingsModel.getAll();
		expect(rows).toHaveLength(2); // the null-source_system row is a distinct natural key, not an update of the 'bacnet' row
	});

	it('a real UNIQUE(endpoint_name, device_key, normalized_name) collision on a genuinely new raw_name is a constraint violation surfaced as a thrown error, not a silent duplicate', () => {
		expect(() => {
			PointNameMappingsModel.upsertMany([{
				source_system: 'bacnet',
				endpoint_name: 'ep-1',
				device_key: 'dev-1',
				raw_name: 'A Genuinely Different Raw Name',
				provisional_point_id: '33333333-4444-5555-8666-777777777777',
				normalized_name: 'ahu_1_sat_renamed', // collides with the row updated above
				locked: true,
				method: 'algorithmic',
				source_fields: ['metric'],
				collision_suffix: null,
				rules_version: 'pn-rules-v1',
			}]);
		}).toThrow();

		// The failed batch must not have partially inserted — still exactly 2 rows from prior tests.
		expect(PointNameMappingsModel.getAll()).toHaveLength(2);
	});

	it('upsertMany wraps a multi-row batch in a single transaction — one bad row rolls back the whole batch', () => {
		const before = PointNameMappingsModel.getAll().length;

		expect(() => {
			PointNameMappingsModel.upsertMany([
				{
					source_system: 'modbus',
					endpoint_name: 'ep-2',
					device_key: 'dev-9',
					raw_name: 'Valid Row',
					provisional_point_id: '44444444-5555-5666-8777-888888888888',
					normalized_name: 'valid_row',
					locked: true,
					method: 'algorithmic',
					source_fields: ['metric'],
					collision_suffix: null,
					rules_version: 'pn-rules-v1',
				},
				{
					source_system: 'bacnet',
					endpoint_name: 'ep-1',
					device_key: 'dev-1',
					raw_name: 'Another New Raw Name',
					provisional_point_id: '55555555-6666-5777-8888-999999999999',
					normalized_name: 'ahu_1_sat_renamed', // collides again — this row in the batch will fail
					locked: true,
					method: 'algorithmic',
					source_fields: ['metric'],
					collision_suffix: null,
					rules_version: 'pn-rules-v1',
				},
			]);
		}).toThrow();

		// Neither row landed — the transaction rolled back the whole batch.
		expect(PointNameMappingsModel.getAll()).toHaveLength(before);
	});
});
