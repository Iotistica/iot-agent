import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS assets (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			uuid TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			asset_type TEXT,
			criticality TEXT NOT NULL DEFAULT 'medium',
			manufacturer TEXT,
			model TEXT,
			rated_life_hours REAL,
			rated_cycles INTEGER,
			install_date INTEGER,
			last_service_date INTEGER,
			location TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_assets_criticality ON assets(criticality);`);

	// Maps an asset to the metric(s) that describe its condition. Many-to-many by
	// construction: one asset can bind metrics from multiple devices/endpoints,
	// one device can back multiple assets. device_uuid/endpoint_uuid identify the
	// *reporting* device, never the asset itself (see docs/preventive-maintenance-energy-plan.md).
	db.exec(`
		CREATE TABLE IF NOT EXISTS asset_metrics (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
			device_uuid TEXT NOT NULL,
			endpoint_uuid TEXT,
			metric TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
	`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_asset_metrics_asset_id ON asset_metrics(asset_id);`);
	db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_metrics_unique ON asset_metrics(asset_id, device_uuid, metric);`);
}

export const migration: NativeSqliteMigration = {
	name: '20260728000000_add_assets.js',
	up,
};
