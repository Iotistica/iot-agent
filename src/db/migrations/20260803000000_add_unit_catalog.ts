import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

/**
 * Unit Normalization Service catalog — canonical engineering units + protocol
 * aliases. Reference data (like Haystack tags or BACnet object types), not a
 * user-editable registry: reseeded from src/data/unit-catalog-seed.ts on every
 * startup, no CRUD/admin surface in v1. Conversion uses a base-unit hub model
 * (each row's own base_unit/multiplier/offset), so no separate conversion-rules
 * table is needed.
 */
function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS unit_definitions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			canonical_unit TEXT NOT NULL UNIQUE,
			quantity TEXT NOT NULL,
			symbol TEXT,
			description TEXT,
			base_unit TEXT NOT NULL,
			multiplier REAL NOT NULL DEFAULT 1,
			offset_value REAL NOT NULL DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (base_unit) REFERENCES unit_definitions(canonical_unit)
		);

		CREATE TABLE IF NOT EXISTS unit_aliases (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			source_system TEXT,
			alias TEXT NOT NULL,
			canonical_unit TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(source_system, alias),
			FOREIGN KEY (canonical_unit) REFERENCES unit_definitions(canonical_unit)
		);

		CREATE INDEX IF NOT EXISTS idx_unit_aliases_alias ON unit_aliases(alias);
		CREATE INDEX IF NOT EXISTS idx_unit_aliases_canonical ON unit_aliases(canonical_unit);
	`);
}

export const migration: NativeSqliteMigration = {
	name: '20260803000000_add_unit_catalog.js',
	up,
};
