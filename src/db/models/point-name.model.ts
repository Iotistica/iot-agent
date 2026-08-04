import type { DatabaseSync } from 'node:sqlite';
import { getDatabase, transact } from '../sqlite';

export interface PointNameMappingRecord {
	id?: number;
	/** NULL = no protocol scope known for this reading (e.g. MQTT, which never emits a protocol field). */
	source_system?: string | null;
	endpoint_name: string;
	device_key: string;
	raw_name: string;
	provisional_point_id: string;
	normalized_name: string;
	locked: boolean;
	method: string;
	source_fields: string[];
	collision_suffix?: string | null;
	rules_version: string;
}

type PointNameMappingRow = Omit<PointNameMappingRecord, 'locked' | 'source_fields'> & {
	locked: number;
	source_fields: string;
};

function mapRow(row: PointNameMappingRow | undefined): PointNameMappingRecord | null {
	if (!row) return null;
	const { locked, source_fields, ...rest } = row;
	let parsedFields: string[];
	try {
		parsedFields = JSON.parse(source_fields);
	} catch {
		parsedFields = [];
	}
	return { ...rest, locked: locked === 1, source_fields: parsedFields };
}

/**
 * Point Name Normalization's operational identity cache (not reference data
 * — contrast with UnitDefinitionsModel/UnitAliasesModel above, which reseed
 * every startup). src/point-name/catalog.ts is the sole caller: getAll() is
 * the one-time startup preload, upsertMany() is the batched, bounded flush
 * target for the deferred-write queue (plan §8) — never called per-row from
 * the live interceptor.
 */
export class PointNameMappingsModel {
	private static readonly table = 'point_name_mappings';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	static getAll(): PointNameMappingRecord[] {
		const rows = this.getDb().prepare(`SELECT * FROM ${this.table} ORDER BY id ASC`).all() as unknown as PointNameMappingRow[];
		return rows.map((row) => mapRow(row)).filter((r): r is PointNameMappingRecord => r !== null);
	}

	// SQLite's UNIQUE(source_system, ...) treats NULL source_system values as
	// mutually non-colliding (same gotcha documented in UnitAliasesModel above)
	// — explicit IS NULL lookup needed, ON CONFLICT alone isn't sufficient.
	private static findExact(sourceSystem: string | null, endpointName: string, deviceKey: string, rawName: string): PointNameMappingRecord | null {
		const row = sourceSystem === null
			? this.getDb().prepare(`SELECT * FROM ${this.table} WHERE source_system IS NULL AND endpoint_name = ? AND device_key = ? AND raw_name = ? LIMIT 1`).get(endpointName, deviceKey, rawName)
			: this.getDb().prepare(`SELECT * FROM ${this.table} WHERE source_system = ? AND endpoint_name = ? AND device_key = ? AND raw_name = ? LIMIT 1`).get(sourceSystem, endpointName, deviceKey, rawName);
		return mapRow(row as unknown as PointNameMappingRow | undefined);
	}

	/**
	 * Batched upsert for the deferred-flush queue. Wraps the whole batch in a
	 * single transaction — on any row failure the whole batch rolls back
	 * (plan §8's transaction rollback handling), never a partial write. Batch
	 * size is capped by the caller (catalog.ts's MAX_ROWS_PER_FLUSH), not here.
	 */
	static upsertMany(records: PointNameMappingRecord[]): void {
		const db = this.getDb();
		transact(db, () => {
			for (const record of records) {
				const sourceSystem = record.source_system ?? null;
				const existing = this.findExact(sourceSystem, record.endpoint_name, record.device_key, record.raw_name);
				const sourceFieldsJson = JSON.stringify(record.source_fields);

				if (existing) {
					db.prepare(`
						UPDATE ${this.table} SET
							provisional_point_id = ?, normalized_name = ?, locked = ?, method = ?,
							source_fields = ?, collision_suffix = ?, rules_version = ?, updated_at = CURRENT_TIMESTAMP
						WHERE id = ?
					`).run(
						record.provisional_point_id,
						record.normalized_name,
						record.locked ? 1 : 0,
						record.method,
						sourceFieldsJson,
						record.collision_suffix ?? null,
						record.rules_version,
						existing.id!,
					);
				} else {
					db.prepare(`
						INSERT INTO ${this.table}
							(source_system, endpoint_name, device_key, raw_name, provisional_point_id, normalized_name, locked, method, source_fields, collision_suffix, rules_version)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					`).run(
						sourceSystem,
						record.endpoint_name,
						record.device_key,
						record.raw_name,
						record.provisional_point_id,
						record.normalized_name,
						record.locked ? 1 : 0,
						record.method,
						sourceFieldsJson,
						record.collision_suffix ?? null,
						record.rules_version,
					);
				}
			}
		}, 'IMMEDIATE');
	}
}
