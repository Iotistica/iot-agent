import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../sqlite';

export interface CustomUnitAliasRecord {
	id?: number;
	/** NULL = protocol-independent/global alias. */
	source_system?: string | null;
	alias: string;
	canonical_unit: string;
}

/**
 * Admin-created unit aliases (the "Resolve unit" dashboard action) — operational
 * data, not reference data: unlike UnitAliasesModel, never touched by the
 * startup reseed (src/units/catalog.ts's seedUnitCatalog()), so an admin's
 * mapping can never be silently overwritten by a future seed update.
 *
 * Same NULL-safe findExact()-then-branch upsert() as UnitAliasesModel — SQLite's
 * UNIQUE(source_system, alias) treats NULL source_system values as mutually
 * non-colliding, so a global (source_system: null) alias can't rely on
 * ON CONFLICT alone.
 */
export class CustomUnitAliasesModel {
	private static readonly table = 'custom_unit_aliases';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	static getAll(): CustomUnitAliasRecord[] {
		return this.getDb().prepare(`SELECT * FROM ${this.table} ORDER BY id ASC`).all() as unknown as CustomUnitAliasRecord[];
	}

	static findExact(sourceSystem: string | null, alias: string): CustomUnitAliasRecord | null {
		const row = sourceSystem === null
			? this.getDb().prepare(`SELECT * FROM ${this.table} WHERE source_system IS NULL AND alias = ? LIMIT 1`).get(alias)
			: this.getDb().prepare(`SELECT * FROM ${this.table} WHERE source_system = ? AND alias = ? LIMIT 1`).get(sourceSystem, alias);
		return (row as unknown as CustomUnitAliasRecord | undefined) ?? null;
	}

	static upsert(record: CustomUnitAliasRecord): CustomUnitAliasRecord {
		const sourceSystem = record.source_system ?? null;
		const existing = this.findExact(sourceSystem, record.alias);

		if (existing) {
			this.getDb().prepare(`UPDATE ${this.table} SET canonical_unit = ? WHERE id = ?`).run(record.canonical_unit, existing.id!);
		} else {
			this.getDb().prepare(`
				INSERT INTO ${this.table} (source_system, alias, canonical_unit) VALUES (?, ?, ?)
			`).run(sourceSystem, record.alias, record.canonical_unit);
		}

		return this.findExact(sourceSystem, record.alias)!;
	}
}
