import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../sqlite';

export type EnergyRuleType = 'standby_waste' | 'schedule_mismatch' | 'duty_cycle';

export interface EnergyRule {
	id?: number;
	asset_id: number;
	metric: string;
	rule_type: EnergyRuleType;
	enabled: boolean;
	config: Record<string, any>;
	created_at?: string;
	updated_at?: string;
}

export type EnergyRuleCreateData = Omit<EnergyRule, 'id' | 'created_at' | 'updated_at'>;

type EnergyRuleRow = Omit<EnergyRule, 'enabled' | 'config'> & {
	enabled: number;
	config: string;
};

export class EnergyRuleModel {
	private static table = 'energy_rules';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	private static parseRow(row: EnergyRuleRow | undefined): EnergyRule | null {
		if (!row) return null;
		return {
			id: row.id,
			asset_id: row.asset_id,
			metric: row.metric,
			rule_type: row.rule_type,
			enabled: !!row.enabled,
			config: JSON.parse(row.config),
			created_at: row.created_at,
			updated_at: row.updated_at,
		};
	}

	static getAll(): EnergyRule[] {
		const rows = this.getDb()
			.prepare(`SELECT * FROM ${this.table} ORDER BY id ASC`)
			.all() as unknown as EnergyRuleRow[];
		return rows.map(r => this.parseRow(r)).filter((r): r is EnergyRule => r !== null);
	}

	static getEnabled(): EnergyRule[] {
		const rows = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE enabled = 1 ORDER BY id ASC`)
			.all() as unknown as EnergyRuleRow[];
		return rows.map(r => this.parseRow(r)).filter((r): r is EnergyRule => r !== null);
	}

	static getById(id: number): EnergyRule | null {
		const row = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE id = ? LIMIT 1`)
			.get(id) as unknown as EnergyRuleRow | undefined;
		return this.parseRow(row);
	}

	static getByAssetId(assetId: number): EnergyRule[] {
		const rows = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE asset_id = ? ORDER BY id ASC`)
			.all(assetId) as unknown as EnergyRuleRow[];
		return rows.map(r => this.parseRow(r)).filter((r): r is EnergyRule => r !== null);
	}

	static create(data: EnergyRuleCreateData): EnergyRule {
		const now = new Date().toISOString();
		const result = this.getDb().prepare(`
			INSERT INTO ${this.table} (asset_id, metric, rule_type, enabled, config, created_at, updated_at)
			VALUES (@asset_id, @metric, @rule_type, @enabled, @config, @created_at, @updated_at)
		`).run({
			asset_id: data.asset_id,
			metric: data.metric,
			rule_type: data.rule_type,
			enabled: data.enabled ? 1 : 0,
			config: JSON.stringify(data.config),
			created_at: now,
			updated_at: now,
		});
		return this.getById(Number(result.lastInsertRowid))!;
	}

	static update(id: number, patch: Partial<Omit<EnergyRule, 'id' | 'created_at'>>): EnergyRule | null {
		const fields: Record<string, unknown> = { updated_at: new Date().toISOString() };

		if (patch.asset_id !== undefined) fields.asset_id = patch.asset_id;
		if (patch.metric !== undefined) fields.metric = patch.metric;
		if (patch.rule_type !== undefined) fields.rule_type = patch.rule_type;
		if (patch.enabled !== undefined) fields.enabled = patch.enabled ? 1 : 0;
		if (patch.config !== undefined) fields.config = JSON.stringify(patch.config);

		const cols = Object.keys(fields).map(k => `"${k}" = @${k}`).join(', ');
		this.getDb().prepare(`UPDATE ${this.table} SET ${cols} WHERE id = @lookup_id`).run({ ...fields, lookup_id: id });
		return this.getById(id);
	}

	static delete(id: number): boolean {
		return this.getDb().prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id).changes > 0;
	}
}
