import { randomUUID } from 'crypto';
import { getDatabase } from '../sqlite.js';

export interface AnomalyRuleTemplate {
	id?: number;
	uuid: string;
	name: string;
	category: string | null;
	purpose: string | null;
	methods: string[];
	threshold: number;
	window_size: number;
	min_confidence: number | null;
	cooldown_ms: number | null;
	seasonality: string | null;
	expected_range: [number, number] | null;
	created_at?: string;
	updated_at?: string;
}

export type AnomalyRuleTemplateCreateData = Omit<AnomalyRuleTemplate, 'id' | 'uuid' | 'created_at' | 'updated_at'>;

type AnomalyRuleTemplateRow = Omit<AnomalyRuleTemplate, 'methods' | 'expected_range'> & {
	methods_json: string;
	expected_range_json: string | null;
};

export class AnomalyRuleTemplateModel {
	private static table = 'anomaly_rule_templates';

	private static getDb() {
		return getDatabase();
	}

	private static parseRow(row: AnomalyRuleTemplateRow | undefined): AnomalyRuleTemplate | null {
		if (!row) return null;
		return {
			id: row.id,
			uuid: row.uuid,
			name: row.name,
			category: row.category,
			purpose: row.purpose,
			methods: JSON.parse(row.methods_json),
			threshold: row.threshold,
			window_size: row.window_size,
			min_confidence: row.min_confidence,
			cooldown_ms: row.cooldown_ms,
			seasonality: row.seasonality,
			expected_range: row.expected_range_json ? JSON.parse(row.expected_range_json) : null,
			created_at: row.created_at,
			updated_at: row.updated_at,
		};
	}

	static getAll(): AnomalyRuleTemplate[] {
		const rows = this.getDb()
			.prepare(`SELECT * FROM ${this.table} ORDER BY name ASC`)
			.all() as unknown as AnomalyRuleTemplateRow[];
		return rows.map(r => this.parseRow(r)).filter((r): r is AnomalyRuleTemplate => r !== null);
	}

	static getByUuid(uuid: string): AnomalyRuleTemplate | null {
		const row = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE uuid = ? LIMIT 1`)
			.get(uuid) as unknown as AnomalyRuleTemplateRow | undefined;
		return this.parseRow(row);
	}

	static create(data: AnomalyRuleTemplateCreateData): AnomalyRuleTemplate {
		const uuid = randomUUID();
		const now = new Date().toISOString();
		this.getDb().prepare(`
			INSERT INTO ${this.table}
				(uuid, name, category, purpose, methods_json, threshold, window_size, min_confidence, cooldown_ms, seasonality, expected_range_json, created_at, updated_at)
			VALUES
				(@uuid, @name, @category, @purpose, @methods_json, @threshold, @window_size, @min_confidence, @cooldown_ms, @seasonality, @expected_range_json, @created_at, @updated_at)
		`).run({
			uuid,
			name: data.name,
			category: data.category ?? null,
			purpose: data.purpose ?? null,
			methods_json: JSON.stringify(data.methods),
			threshold: data.threshold,
			window_size: data.window_size,
			min_confidence: data.min_confidence ?? null,
			cooldown_ms: data.cooldown_ms ?? null,
			seasonality: data.seasonality ?? null,
			expected_range_json: data.expected_range ? JSON.stringify(data.expected_range) : null,
			created_at: now,
			updated_at: now,
		});
		return this.getByUuid(uuid)!;
	}

	static update(uuid: string, patch: Partial<AnomalyRuleTemplateCreateData>): AnomalyRuleTemplate | null {
		const fields: Record<string, unknown> = { updated_at: new Date().toISOString() };

		if (patch.name !== undefined) fields.name = patch.name;
		if (patch.category !== undefined) fields.category = patch.category;
		if (patch.purpose !== undefined) fields.purpose = patch.purpose;
		if (patch.methods !== undefined) fields.methods_json = JSON.stringify(patch.methods);
		if (patch.threshold !== undefined) fields.threshold = patch.threshold;
		if (patch.window_size !== undefined) fields.window_size = patch.window_size;
		if (patch.min_confidence !== undefined) fields.min_confidence = patch.min_confidence;
		if (patch.cooldown_ms !== undefined) fields.cooldown_ms = patch.cooldown_ms;
		if (patch.seasonality !== undefined) fields.seasonality = patch.seasonality;
		if (patch.expected_range !== undefined) {
			fields.expected_range_json = patch.expected_range ? JSON.stringify(patch.expected_range) : null;
		}

		const cols = Object.keys(fields).map(k => `"${k}" = @${k}`).join(', ');
		this.getDb().prepare(`UPDATE ${this.table} SET ${cols} WHERE uuid = @lookup_uuid`).run({ ...fields, lookup_uuid: uuid });
		return this.getByUuid(uuid);
	}

	static delete(uuid: string): boolean {
		return this.getDb().prepare(`DELETE FROM ${this.table} WHERE uuid = ?`).run(uuid).changes > 0;
	}
}
