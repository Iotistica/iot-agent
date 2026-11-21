import type { DatabaseSync } from 'node:sqlite';
import { loadTemplateSql, loadMarketplaceSeedSql } from '../migration-helpers.js';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	const templateSql = loadTemplateSql()
		.replace(/^\s*BEGIN TRANSACTION;\s*/m, '')
		.replace(/\s*COMMIT;\s*$/m, '');

	db.exec(templateSql);
	db.exec(loadMarketplaceSeedSql());
}

export const migration: NativeSqliteMigration = {
	name: '20260312020000_squashed_initial_schema.js',
	up,
};
