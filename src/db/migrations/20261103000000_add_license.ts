import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS license (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			token TEXT NOT NULL,
			activated_at INTEGER NOT NULL
		)
	`);
}

export const migration: NativeSqliteMigration = {
	name: '20261103000000_add_license.js',
	up,
};
