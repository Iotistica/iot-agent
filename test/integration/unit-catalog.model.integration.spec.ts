import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';

// db-path.ts resolves its database path once, at module-init time, from
// process.env.DATABASE_PATH — must be set before the first require() of
// ../../src/db/sqlite, same convention as the other *.model.integration.spec.ts files.
describe('Unit Normalization Service catalog (integration)', () => {
	let dbPath: string;
	let UnitDefinitionsModel: typeof import('../../src/db/models/unit-catalog.model').UnitDefinitionsModel;
	let UnitAliasesModel: typeof import('../../src/db/models/unit-catalog.model').UnitAliasesModel;
	let seedUnitCatalog: typeof import('../../src/normalization/catalog').seedUnitCatalog;
	let closeDatabase: () => void;

	beforeAll(() => {
		dbPath = path.join(os.tmpdir(), `unit-catalog-model-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
		process.env.DATABASE_PATH = dbPath;

		const sqlite = require('../../src/db/sqlite');
		const { runMigrations } = require('../../src/db/migration-runner');

		const db: DatabaseSync = sqlite.getDatabase();
		runMigrations(db);
		closeDatabase = sqlite.closeDatabase;

		UnitDefinitionsModel = require('../../src/db/models/unit-catalog.model').UnitDefinitionsModel;
		UnitAliasesModel = require('../../src/db/models/unit-catalog.model').UnitAliasesModel;
		seedUnitCatalog = require('../../src/normalization/catalog').seedUnitCatalog;
	});

	afterAll(() => {
		closeDatabase();
		for (const suffix of ['', '-wal', '-shm']) {
			fs.rmSync(`${dbPath}${suffix}`, { force: true });
		}
	});

	describe('UnitDefinitionsModel', () => {
		it('upserts and reads back a definition', () => {
			const record = UnitDefinitionsModel.upsert({
				canonical_unit: 'testUnitX', quantity: 'testQuantity', symbol: 'TX',
				description: 'test', base_unit: 'testUnitX', multiplier: 1, offset: 0,
			});
			expect(record.canonical_unit).toBe('testUnitX');

			const fetched = UnitDefinitionsModel.getByCanonicalUnit('testUnitX');
			expect(fetched).toMatchObject({ canonical_unit: 'testUnitX', quantity: 'testQuantity', multiplier: 1, offset: 0 });
		});

		it('upsert on an existing canonical_unit updates in place rather than duplicating', () => {
			UnitDefinitionsModel.upsert({ canonical_unit: 'testUnitX', quantity: 'testQuantity', base_unit: 'testUnitX', multiplier: 2, offset: 5 });
			const all = UnitDefinitionsModel.getAll().filter((d) => d.canonical_unit === 'testUnitX');
			expect(all).toHaveLength(1);
			expect(all[0].multiplier).toBe(2);
			expect(all[0].offset).toBe(5);
		});

		it('returns null for an unknown canonical unit', () => {
			expect(UnitDefinitionsModel.getByCanonicalUnit('does-not-exist')).toBeNull();
		});
	});

	describe('UnitAliasesModel', () => {
		it('upserts a global alias and finds it via findExact(null, alias)', () => {
			UnitAliasesModel.upsert({ source_system: null, alias: 'testAliasGlobal', canonical_unit: 'testUnitX' });
			const found = UnitAliasesModel.findExact(null, 'testAliasGlobal');
			expect(found).toMatchObject({ source_system: null, alias: 'testAliasGlobal', canonical_unit: 'testUnitX' });
		});

		it('a scoped alias with the same text as a global one is a distinct row (NULL-safe uniqueness)', () => {
			UnitAliasesModel.upsert({ source_system: 'testsys', alias: 'testAliasGlobal', canonical_unit: 'testUnitX' });
			const scoped = UnitAliasesModel.findExact('testsys', 'testAliasGlobal');
			const global = UnitAliasesModel.findExact(null, 'testAliasGlobal');
			expect(scoped).not.toBeNull();
			expect(global).not.toBeNull();
			expect(scoped!.id).not.toBe(global!.id);
		});

		it('upsert on an existing (source_system, alias) pair updates rather than duplicating (NULL-safe)', () => {
			UnitAliasesModel.upsert({ source_system: null, alias: 'testAliasGlobal', canonical_unit: 'testUnitX' });
			UnitAliasesModel.upsert({ source_system: null, alias: 'testAliasGlobal', canonical_unit: 'testUnitX' });
			const all = UnitAliasesModel.getAll().filter((a) => a.source_system === null && a.alias === 'testAliasGlobal');
			expect(all).toHaveLength(1);
		});

		it('a true UNIQUE(source_system, alias) duplicate insert is surfaced as a clean, non-throwing update via upsert()', () => {
			expect(() => UnitAliasesModel.upsert({ source_system: 'testsys', alias: 'testAliasGlobal', canonical_unit: 'testUnitX' })).not.toThrow();
		});
	});

	describe('seedUnitCatalog()', () => {
		it('seeds the full production dataset without error', () => {
			expect(() => seedUnitCatalog()).not.toThrow();

			const def = UnitDefinitionsModel.getByCanonicalUnit('degreesCelsius');
			expect(def).toMatchObject({ canonical_unit: 'degreesCelsius', quantity: 'temperature', base_unit: 'degreesCelsius', multiplier: 1, offset: 0 });

			const alias = UnitAliasesModel.findExact(null, 'kPa');
			expect(alias).toMatchObject({ canonical_unit: 'kilopascals' });
		});

		it('is idempotent — running it twice does not double row counts', () => {
			const before = { defs: UnitDefinitionsModel.getAll().length, aliases: UnitAliasesModel.getAll().length };
			seedUnitCatalog();
			const after = { defs: UnitDefinitionsModel.getAll().length, aliases: UnitAliasesModel.getAll().length };
			expect(after).toEqual(before);
		});

		it('inserted base-unit rows without a foreign-key-ordering failure', () => {
			// Every non-base unit's base_unit must resolve to a real row after seeding —
			// confirms the base-units-first insertion order worked correctly.
			const all = UnitDefinitionsModel.getAll();
			const byCanonical = new Map(all.map((d) => [d.canonical_unit, d]));
			for (const def of all) {
				expect(byCanonical.has(def.base_unit)).toBe(true);
			}
		});
	});
});
