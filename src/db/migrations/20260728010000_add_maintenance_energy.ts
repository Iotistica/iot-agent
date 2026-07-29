import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	// Rule definitions (admin-edited config), one row per configured rule instance.
	db.exec(`
		CREATE TABLE IF NOT EXISTS maintenance_rules (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			asset_id INTEGER NOT NULL REFERENCES assets(id),
			component TEXT NOT NULL,
			rule_type TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1,
			config TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_maintenance_rules_asset_id ON maintenance_rules(asset_id);`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_maintenance_rules_enabled ON maintenance_rules(enabled);`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS energy_rules (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			asset_id INTEGER NOT NULL REFERENCES assets(id),
			metric TEXT NOT NULL,
			rule_type TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1,
			config TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_energy_rules_asset_id ON energy_rules(asset_id);`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_energy_rules_enabled ON energy_rules(enabled);`);

	// One row per (asset, component, rule) — a standing recommendation, re-evaluated in place.
	// asset_name/criticality are denormalized from assets at eval time so the admin UI and
	// publish payloads (Phase 3) don't need a join to render or prioritize.
	db.exec(`
		CREATE TABLE IF NOT EXISTS maintenance_recommendations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			asset_id INTEGER NOT NULL REFERENCES assets(id),
			asset_name TEXT NOT NULL,
			criticality TEXT NOT NULL,
			component TEXT NOT NULL,
			rule_type TEXT NOT NULL,
			rule_config TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'open',
			message TEXT NOT NULL,
			due_by INTEGER,
			confidence REAL,
			consecutive_count INTEGER NOT NULL DEFAULT 1,
			first_evaluated_at INTEGER NOT NULL,
			last_evaluated_at INTEGER NOT NULL,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
	`);
	// Partial (not plain) unique index: only one *active* (open/scheduled) recommendation is
	// allowed per (asset, component, rule) at a time, but completed/dismissed history rows for
	// that same combination are exempt — otherwise a re-triggered rule could never "open a new
	// row" per the history-preservation rule below, since a plain unique index would collide
	// with the old closed row.
	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS maintenance_rec_active_unique
		ON maintenance_recommendations(asset_id, component, rule_type)
		WHERE status IN ('open', 'scheduled');
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_maintenance_rec_status ON maintenance_recommendations(status);`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS energy_recommendations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			asset_id INTEGER NOT NULL REFERENCES assets(id),
			asset_name TEXT NOT NULL,
			criticality TEXT NOT NULL,
			metric TEXT NOT NULL,
			rule_type TEXT NOT NULL,
			rule_config TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'open',
			message TEXT NOT NULL,
			estimated_impact TEXT,
			confidence REAL,
			consecutive_count INTEGER NOT NULL DEFAULT 1,
			first_evaluated_at INTEGER NOT NULL,
			last_evaluated_at INTEGER NOT NULL,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
	`);
	// Same partial-uniqueness reasoning as maintenance_recommendations above.
	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS energy_rec_active_unique
		ON energy_recommendations(asset_id, metric, rule_type)
		WHERE status IN ('open', 'scheduled');
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_energy_rec_status ON energy_recommendations(status);`);
}

export const migration: NativeSqliteMigration = {
	name: '20260728010000_add_maintenance_energy.js',
	up,
};
