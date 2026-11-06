import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS app_marketplace_templates (
			id TEXT PRIMARY KEY,
			template_json TEXT NOT NULL,
			sort_order INTEGER NOT NULL,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
	`);
}

export const migration: NativeSqliteMigration = {
	name: '20261018000000_add_app_marketplace.js',
	up,
};
