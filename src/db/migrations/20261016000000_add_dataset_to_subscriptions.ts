import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	const cols = (db.prepare(`PRAGMA table_info(publish_subscriptions)`).all() as unknown as Array<{ name: string }>).map((r) => r.name);
	if (!cols.includes('ml_dataset_id')) {
		db.exec(`ALTER TABLE publish_subscriptions ADD COLUMN ml_dataset_id TEXT DEFAULT NULL`);
	}
}

export const migration: NativeSqliteMigration = {
	name: '20261016000000_add_dataset_to_subscriptions.js',
	up,
};
