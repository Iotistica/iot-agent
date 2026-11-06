import type { DatabaseSync } from 'node:sqlite';
import { loadMarketplaceSeedSql } from '../migration-helpers.js';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	const { count } = db.prepare('SELECT COUNT(*) AS count FROM app_marketplace_templates').get() as { count: number };
	if (count === 0) {
		db.exec(loadMarketplaceSeedSql());
	}
}

export const migration: NativeSqliteMigration = {
	name: '20261106000000_seed_app_marketplace.js',
	up,
};
