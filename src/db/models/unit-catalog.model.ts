import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../sqlite';

export interface UnitDefinitionRecord {
	id?: number;
	canonical_unit: string;
	quantity: string;
	symbol?: string | null;
	description?: string | null;
	/** The quantity's reference unit — self-referential (base_unit === canonical_unit) for the base unit itself. */
	base_unit: string;
	/** base_value = this_value * multiplier + offset */
	multiplier: number;
	offset: number;
}

export interface UnitAliasRecord {
	id?: number;
	/** NULL = protocol-independent/global alias. */
	source_system?: string | null;
	alias: string;
	canonical_unit: string;
}

type UnitDefinitionRow = Omit<UnitDefinitionRecord, 'offset'> & { offset_value: number };

function mapDefinitionRow(row: UnitDefinitionRow | undefined): UnitDefinitionRecord | null {
	if (!row) return null;
	const { offset_value, ...rest } = row;
	return { ...rest, offset: offset_value };
}

/**
 * Canonical engineering units. Reference data — reseeded from
 * src/data/unit-catalog-seed.ts on every startup via seedUnitCatalog()
 * (src/normalization/catalog.ts). No delete(): no runtime mutation path
 * beyond the startup reseed.
 */
export class UnitDefinitionsModel {
	private static readonly table = 'unit_definitions';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	static getAll(): UnitDefinitionRecord[] {
		const rows = this.getDb().prepare(`SELECT * FROM ${this.table} ORDER BY id ASC`).all() as unknown as UnitDefinitionRow[];
		return rows.map((row) => mapDefinitionRow(row)).filter((row): row is UnitDefinitionRecord => row !== null);
	}

	static getByCanonicalUnit(canonicalUnit: string): UnitDefinitionRecord | null {
		const row = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE canonical_unit = ? LIMIT 1`)
			.get(canonicalUnit) as unknown as UnitDefinitionRow | undefined;
		return mapDefinitionRow(row);
	}

	/** Internal use only (the seed loader) — no admin API route calls this. */
	static upsert(record: UnitDefinitionRecord): UnitDefinitionRecord {
		this.getDb().prepare(`
			INSERT INTO ${this.table} (canonical_unit, quantity, symbol, description, base_unit, multiplier, offset_value)
			VALUES (@canonical_unit, @quantity, @symbol, @description, @base_unit, @multiplier, @offset_value)
			ON CONFLICT(canonical_unit) DO UPDATE SET
				quantity = excluded.quantity,
				symbol = excluded.symbol,
				description = excluded.description,
				base_unit = excluded.base_unit,
				multiplier = excluded.multiplier,
				offset_value = excluded.offset_value
		`).run({
			canonical_unit: record.canonical_unit,
			quantity: record.quantity,
			symbol: record.symbol ?? null,
			description: record.description ?? null,
			base_unit: record.base_unit,
			multiplier: record.multiplier,
			offset_value: record.offset,
		});

		return this.getByCanonicalUnit(record.canonical_unit)!;
	}
}

/**
 * Protocol/source aliases for canonical units. Reference data, same lifecycle
 * as UnitDefinitionsModel. SQLite's UNIQUE(source_system, alias) treats NULL
 * source_system values as mutually non-colliding (standard SQL NULL
 * semantics), so a global (source_system: null) alias can't rely on
 * ON CONFLICT alone — upsert() does an explicit findExact() check first.
 */
export class UnitAliasesModel {
	private static readonly table = 'unit_aliases';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	static getAll(): UnitAliasRecord[] {
		return this.getDb().prepare(`SELECT * FROM ${this.table} ORDER BY id ASC`).all() as unknown as UnitAliasRecord[];
	}

	static findExact(sourceSystem: string | null, alias: string): UnitAliasRecord | null {
		const row = sourceSystem === null
			? this.getDb().prepare(`SELECT * FROM ${this.table} WHERE source_system IS NULL AND alias = ? LIMIT 1`).get(alias)
			: this.getDb().prepare(`SELECT * FROM ${this.table} WHERE source_system = ? AND alias = ? LIMIT 1`).get(sourceSystem, alias);
		return (row as unknown as UnitAliasRecord | undefined) ?? null;
	}

	/** Internal use only (the seed loader) — no admin API route calls this. */
	static upsert(record: UnitAliasRecord): UnitAliasRecord {
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
