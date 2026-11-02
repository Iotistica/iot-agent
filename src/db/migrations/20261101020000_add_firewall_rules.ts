import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS firewall_rules (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			port TEXT NOT NULL,
			protocol TEXT NOT NULL DEFAULT 'tcp',
			interface_name TEXT,
			description TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)
	`);
}

export const migration: NativeSqliteMigration = {
	name: '20261101020000_add_firewall_rules.js',
	up,
};
