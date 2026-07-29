import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../sqlite';

export type MaintenanceRuleType = 'cumulative_runtime' | 'cycle_count' | 'threshold_duration';

export interface MaintenanceRule {
	id?: number;
	asset_id: number;
	component: string;
	rule_type: MaintenanceRuleType;
	enabled: boolean;
	config: Record<string, any>;
	created_at?: string;
	updated_at?: string;
}

export type MaintenanceRuleCreateData = Omit<MaintenanceRule, 'id' | 'created_at' | 'updated_at'>;

type MaintenanceRuleRow = Omit<MaintenanceRule, 'enabled' | 'config'> & {
	enabled: number;
	config: string;
};

export class MaintenanceRuleModel {
	private static table = 'maintenance_rules';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	private static parseRow(row: MaintenanceRuleRow | undefined): MaintenanceRule | null {
		if (!row) return null;
		return {
			id: row.id,
			asset_id: row.asset_id,
			component: row.component,
			rule_type: row.rule_type,
			enabled: !!row.enabled,
			config: JSON.parse(row.config),
			created_at: row.created_at,
			updated_at: row.updated_at,
		};
	}

	static getAll(): MaintenanceRule[] {
		const rows = this.getDb()
			.prepare(`SELECT * FROM ${this.table} ORDER BY id ASC`)
			.all() as unknown as MaintenanceRuleRow[];
		return rows.map(r => this.parseRow(r)).filter((r): r is MaintenanceRule => r !== null);
	}

	static getEnabled(): MaintenanceRule[] {
		const rows = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE enabled = 1 ORDER BY id ASC`)
			.all() as unknown as MaintenanceRuleRow[];
		return rows.map(r => this.parseRow(r)).filter((r): r is MaintenanceRule => r !== null);
	}

	static getById(id: number): MaintenanceRule | null {
		const row = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE id = ? LIMIT 1`)
			.get(id) as unknown as MaintenanceRuleRow | undefined;
		return this.parseRow(row);
	}

	static getByAssetId(assetId: number): MaintenanceRule[] {
		const rows = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE asset_id = ? ORDER BY id ASC`)
			.all(assetId) as unknown as MaintenanceRuleRow[];
		return rows.map(r => this.parseRow(r)).filter((r): r is MaintenanceRule => r !== null);
	}

	static create(data: MaintenanceRuleCreateData): MaintenanceRule {
		const now = new Date().toISOString();
		const result = this.getDb().prepare(`
			INSERT INTO ${this.table} (asset_id, component, rule_type, enabled, config, created_at, updated_at)
			VALUES (@asset_id, @component, @rule_type, @enabled, @config, @created_at, @updated_at)
		`).run({
			asset_id: data.asset_id,
			component: data.component,
			rule_type: data.rule_type,
			enabled: data.enabled ? 1 : 0,
			config: JSON.stringify(data.config),
			created_at: now,
			updated_at: now,
		});
		return this.getById(Number(result.lastInsertRowid))!;
	}

	static update(id: number, patch: Partial<Omit<MaintenanceRule, 'id' | 'created_at'>>): MaintenanceRule | null {
		const fields: Record<string, unknown> = { updated_at: new Date().toISOString() };

		if (patch.asset_id !== undefined) fields.asset_id = patch.asset_id;
		if (patch.component !== undefined) fields.component = patch.component;
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
