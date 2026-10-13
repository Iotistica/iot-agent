import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS data_explorer_views (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			description TEXT DEFAULT '',
			point_keys TEXT NOT NULL DEFAULT '[]',
			filters TEXT DEFAULT NULL,
			owner_username TEXT NOT NULL,
			display_order INTEGER DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE INDEX IF NOT EXISTS idx_data_explorer_views_owner
			ON data_explorer_views(owner_username);
	`);
}

export const migration: NativeSqliteMigration = {
	name: '20261012000000_add_data_explorer_views.js',
	up,
};
