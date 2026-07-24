import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS anomaly_rule_templates (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			uuid TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			category TEXT,
			purpose TEXT,
			methods_json TEXT NOT NULL,
			threshold REAL NOT NULL,
			window_size INTEGER NOT NULL,
			min_confidence REAL,
			cooldown_ms INTEGER,
			seasonality TEXT,
			expected_range_json TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
	`);

	db.exec(`CREATE INDEX IF NOT EXISTS idx_anomaly_rule_templates_name ON anomaly_rule_templates(name);`);
}

export const migration: NativeSqliteMigration = {
	name: '20260723010000_add_anomaly_rule_templates.js',
	up,
};
