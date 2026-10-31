import type { DatabaseSync } from 'node:sqlite';
import { APP_TEMPLATES } from '../../data/app-templates.js';
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

	const insert = db.prepare(`
		INSERT OR IGNORE INTO app_marketplace_templates (id, template_json, sort_order)
		VALUES (?, ?, ?)
	`);

	APP_TEMPLATES.forEach((template, index) => {
		insert.run(template.id, JSON.stringify(template), index);
	});
}

export const migration: NativeSqliteMigration = {
	name: '20261018000000_add_app_marketplace.js',
	up,
};
