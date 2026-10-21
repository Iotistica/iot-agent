import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_drift_rule_templates (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			uuid TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			category TEXT,
			description TEXT,
			suppress_drift_types_json TEXT,
			alert_on_drift_types_json TEXT,
			severity_overrides_json TEXT,
			consecutive_missing_threshold INTEGER,
			alert_cooldown_ms INTEGER,
			pin_as_baseline INTEGER,
			allowed_types_json TEXT,
			adaptive_promotion_batches INTEGER,
			adaptive_promotion_min_elapsed_ms INTEGER,
			adaptive_retire_batches INTEGER,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
	`);

	db.exec(`CREATE INDEX IF NOT EXISTS idx_schema_drift_rule_templates_name ON schema_drift_rule_templates(name);`);
}

export const migration: NativeSqliteMigration = {
	name: '20261017010000_add_schema_drift_rule_templates.js',
	up,
};
