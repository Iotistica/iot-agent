import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_drift_rules (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			uuid TEXT NOT NULL UNIQUE,
			enabled INTEGER NOT NULL DEFAULT 1,
			priority INTEGER NOT NULL DEFAULT 0,
			name TEXT,
			description TEXT,
			field_pattern TEXT,
			device_pattern TEXT,
			endpoint_pattern TEXT,
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

	db.exec(`CREATE INDEX IF NOT EXISTS idx_schema_drift_rules_priority ON schema_drift_rules(priority DESC);`);
}

export const migration: NativeSqliteMigration = {
	name: '20261017000000_add_schema_drift_rules.js',
	up,
};
