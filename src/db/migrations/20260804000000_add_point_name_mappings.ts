import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

/**
 * Point Name Normalization identity cache. Operational, runtime-written data
 * (unlike unit_catalog's reference-data/reseed-every-startup lifecycle) — rows
 * accumulate as points are first observed, or are pre-seeded for curated
 * overrides in a later phase (Phase 1 ships with no seed path, see
 * src/point-name/catalog.ts). `locked` governs reuse policy independent of
 * `method`/`rules_version`; Phase 1 never regenerates a locked mapping.
 */
function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS point_name_mappings (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			source_system TEXT,
			endpoint_name TEXT NOT NULL,
			device_key TEXT NOT NULL DEFAULT '',
			raw_name TEXT NOT NULL,
			provisional_point_id TEXT NOT NULL,
			normalized_name TEXT NOT NULL,
			locked INTEGER NOT NULL DEFAULT 1,
			method TEXT NOT NULL,
			source_fields TEXT NOT NULL DEFAULT '[]',
			collision_suffix TEXT,
			rules_version TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(source_system, endpoint_name, device_key, raw_name),
			UNIQUE(endpoint_name, device_key, normalized_name)
		);

		CREATE INDEX IF NOT EXISTS idx_point_name_mappings_provisional_point_id ON point_name_mappings(provisional_point_id);
	`);
}

export const migration: NativeSqliteMigration = {
	name: '20260804000000_add_point_name_mappings.js',
	up,
};
