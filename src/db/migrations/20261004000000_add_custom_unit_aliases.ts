import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

/**
 * Admin-created unit aliases — physically separate from unit_aliases
 * (20260803000000_add_unit_catalog.ts). unit_aliases is reseeded from the
 * static seed dataset on every startup (seedUnitCatalog(), src/units/catalog.ts);
 * keeping custom mappings in their own table means that reseed can never
 * collide with or overwrite an admin's mapping.
 */
function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS custom_unit_aliases (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			source_system TEXT,
			alias TEXT NOT NULL,
			canonical_unit TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(source_system, alias),
			FOREIGN KEY (canonical_unit) REFERENCES unit_definitions(canonical_unit)
		);

		CREATE INDEX IF NOT EXISTS idx_custom_unit_aliases_alias ON custom_unit_aliases(alias);
	`);
}

export const migration: NativeSqliteMigration = {
	name: '20261004000000_add_custom_unit_aliases.js',
	up,
};
