import { randomUUID } from 'crypto';
import { getDatabase } from '../sqlite.js';

export interface DriftRuleTemplate {
	uuid: string;
	name: string;
	category: string | null;
	description: string | null;
	suppressDriftTypes?: string[];
	alertOnDriftTypes?: string[];
	severityOverrides?: Record<string, string>;
	consecutiveMissingThreshold?: number;
	alertCooldownMs?: number;
	pinAsBaseline?: boolean;
	allowedTypes?: string[];
	adaptivePromotionBatches?: number;
	adaptivePromotionMinElapsedMs?: number;
	adaptiveRetireBatches?: number;
	createdAt?: string;
	updatedAt?: string;
}

interface TemplateRow {
	id: number;
	uuid: string;
	name: string;
	category: string | null;
	description: string | null;
	suppress_drift_types_json: string | null;
	alert_on_drift_types_json: string | null;
	severity_overrides_json: string | null;
	consecutive_missing_threshold: number | null;
	alert_cooldown_ms: number | null;
	pin_as_baseline: number | null;
	allowed_types_json: string | null;
	adaptive_promotion_batches: number | null;
	adaptive_promotion_min_elapsed_ms: number | null;
	adaptive_retire_batches: number | null;
	created_at: string;
	updated_at: string;
}

function parseRow(row: TemplateRow | undefined): DriftRuleTemplate | null {
	if (!row) return null;
	return {
		uuid: row.uuid,
		name: row.name,
		category: row.category,
		description: row.description,
		suppressDriftTypes: row.suppress_drift_types_json ? JSON.parse(row.suppress_drift_types_json) : undefined,
		alertOnDriftTypes: row.alert_on_drift_types_json ? JSON.parse(row.alert_on_drift_types_json) : undefined,
		severityOverrides: row.severity_overrides_json ? JSON.parse(row.severity_overrides_json) : undefined,
		consecutiveMissingThreshold: row.consecutive_missing_threshold ?? undefined,
		alertCooldownMs: row.alert_cooldown_ms ?? undefined,
		pinAsBaseline: row.pin_as_baseline != null ? row.pin_as_baseline === 1 : undefined,
		allowedTypes: row.allowed_types_json ? JSON.parse(row.allowed_types_json) : undefined,
		adaptivePromotionBatches: row.adaptive_promotion_batches ?? undefined,
		adaptivePromotionMinElapsedMs: row.adaptive_promotion_min_elapsed_ms ?? undefined,
		adaptiveRetireBatches: row.adaptive_retire_batches ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class SchemaDriftRuleTemplateModel {
	private static table = 'schema_drift_rule_templates';
	private static getDb() { return getDatabase(); }

	static getAll(): DriftRuleTemplate[] {
		const rows = this.getDb()
			.prepare(`SELECT * FROM ${this.table} ORDER BY name ASC`)
			.all() as unknown as TemplateRow[];
		return rows.map(r => parseRow(r)).filter((r): r is DriftRuleTemplate => r !== null);
	}

	static getByUuid(uuid: string): DriftRuleTemplate | null {
		const row = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE uuid = ? LIMIT 1`)
			.get(uuid) as unknown as TemplateRow | undefined;
		return parseRow(row);
	}

	static create(data: Omit<DriftRuleTemplate, 'uuid' | 'createdAt' | 'updatedAt'>): DriftRuleTemplate {
		const uuid = randomUUID();
		const now = new Date().toISOString();
		this.getDb().prepare(`
			INSERT INTO ${this.table}
				(uuid, name, category, description,
				 suppress_drift_types_json, alert_on_drift_types_json, severity_overrides_json,
				 consecutive_missing_threshold, alert_cooldown_ms, pin_as_baseline, allowed_types_json,
				 adaptive_promotion_batches, adaptive_promotion_min_elapsed_ms, adaptive_retire_batches,
				 created_at, updated_at)
			VALUES
				(@uuid, @name, @category, @description,
				 @suppress_drift_types_json, @alert_on_drift_types_json, @severity_overrides_json,
				 @consecutive_missing_threshold, @alert_cooldown_ms, @pin_as_baseline, @allowed_types_json,
				 @adaptive_promotion_batches, @adaptive_promotion_min_elapsed_ms, @adaptive_retire_batches,
				 @created_at, @updated_at)
		`).run({
			uuid,
			name: data.name,
			category: data.category ?? null,
			description: data.description ?? null,
			suppress_drift_types_json: data.suppressDriftTypes ? JSON.stringify(data.suppressDriftTypes) : null,
			alert_on_drift_types_json: data.alertOnDriftTypes ? JSON.stringify(data.alertOnDriftTypes) : null,
			severity_overrides_json: data.severityOverrides ? JSON.stringify(data.severityOverrides) : null,
			consecutive_missing_threshold: data.consecutiveMissingThreshold ?? null,
			alert_cooldown_ms: data.alertCooldownMs ?? null,
			pin_as_baseline: data.pinAsBaseline != null ? (data.pinAsBaseline ? 1 : 0) : null,
			allowed_types_json: data.allowedTypes ? JSON.stringify(data.allowedTypes) : null,
			adaptive_promotion_batches: data.adaptivePromotionBatches ?? null,
			adaptive_promotion_min_elapsed_ms: data.adaptivePromotionMinElapsedMs ?? null,
			adaptive_retire_batches: data.adaptiveRetireBatches ?? null,
			created_at: now,
			updated_at: now,
		});
		return this.getByUuid(uuid)!;
	}

	static update(uuid: string, patch: Partial<DriftRuleTemplate>): DriftRuleTemplate | null {
		const fields: Record<string, unknown> = { updated_at: new Date().toISOString() };

		if (patch.name !== undefined) fields.name = patch.name;
		if (patch.category !== undefined) fields.category = patch.category;
		if (patch.description !== undefined) fields.description = patch.description;
		if (patch.suppressDriftTypes !== undefined) fields.suppress_drift_types_json = JSON.stringify(patch.suppressDriftTypes);
		if (patch.alertOnDriftTypes !== undefined) fields.alert_on_drift_types_json = JSON.stringify(patch.alertOnDriftTypes);
		if (patch.severityOverrides !== undefined) fields.severity_overrides_json = JSON.stringify(patch.severityOverrides);
		if (patch.consecutiveMissingThreshold !== undefined) fields.consecutive_missing_threshold = patch.consecutiveMissingThreshold;
		if (patch.alertCooldownMs !== undefined) fields.alert_cooldown_ms = patch.alertCooldownMs;
		if (patch.pinAsBaseline !== undefined) fields.pin_as_baseline = patch.pinAsBaseline ? 1 : 0;
		if (patch.allowedTypes !== undefined) fields.allowed_types_json = JSON.stringify(patch.allowedTypes);
		if (patch.adaptivePromotionBatches !== undefined) fields.adaptive_promotion_batches = patch.adaptivePromotionBatches;
		if (patch.adaptivePromotionMinElapsedMs !== undefined) fields.adaptive_promotion_min_elapsed_ms = patch.adaptivePromotionMinElapsedMs;
		if (patch.adaptiveRetireBatches !== undefined) fields.adaptive_retire_batches = patch.adaptiveRetireBatches;

		const cols = Object.keys(fields).map(k => `"${k}" = @${k}`).join(', ');
		this.getDb().prepare(`UPDATE ${this.table} SET ${cols} WHERE uuid = @lookup_uuid`).run({ ...fields, lookup_uuid: uuid });
		return this.getByUuid(uuid);
	}

	static delete(uuid: string): boolean {
		return this.getDb().prepare(`DELETE FROM ${this.table} WHERE uuid = ?`).run(uuid).changes > 0;
	}
}
