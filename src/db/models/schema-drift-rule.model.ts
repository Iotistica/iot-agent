import { randomUUID } from 'crypto';
import { getDatabase } from '../sqlite.js';
import type { DriftRuleConfig } from '../../publish/core/types.js';

interface DriftRuleRow {
	id: number;
	uuid: string;
	enabled: number;
	priority: number;
	name: string | null;
	description: string | null;
	field_pattern: string | null;
	device_pattern: string | null;
	endpoint_pattern: string | null;
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

function parseRow(row: DriftRuleRow | undefined): DriftRuleConfig | null {
	if (!row) return null;
	return {
		id: row.uuid,
		enabled: row.enabled === 1,
		priority: row.priority,
		name: row.name ?? undefined,
		description: row.description ?? undefined,
		fieldPattern: row.field_pattern ?? undefined,
		devicePattern: row.device_pattern ?? undefined,
		endpointPattern: row.endpoint_pattern ?? undefined,
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

export class SchemaDriftRuleModel {
	private static table = 'schema_drift_rules';
	private static getDb() { return getDatabase(); }

	static getAll(): DriftRuleConfig[] {
		const rows = this.getDb()
			.prepare(`SELECT * FROM ${this.table} ORDER BY priority DESC, id ASC`)
			.all() as unknown as DriftRuleRow[];
		return rows.map(r => parseRow(r)).filter((r): r is DriftRuleConfig => r !== null);
	}

	static getByUuid(uuid: string): DriftRuleConfig | null {
		const row = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE uuid = ? LIMIT 1`)
			.get(uuid) as unknown as DriftRuleRow | undefined;
		return parseRow(row);
	}

	static create(data: Omit<DriftRuleConfig, 'id' | 'createdAt' | 'updatedAt'>): DriftRuleConfig {
		const uuid = randomUUID();
		const now = new Date().toISOString();
		this.getDb().prepare(`
			INSERT INTO ${this.table}
				(uuid, enabled, priority, name, description, field_pattern, device_pattern, endpoint_pattern,
				 suppress_drift_types_json, alert_on_drift_types_json, severity_overrides_json,
				 consecutive_missing_threshold, alert_cooldown_ms, pin_as_baseline, allowed_types_json,
				 adaptive_promotion_batches, adaptive_promotion_min_elapsed_ms, adaptive_retire_batches,
				 created_at, updated_at)
			VALUES
				(@uuid, @enabled, @priority, @name, @description, @field_pattern, @device_pattern, @endpoint_pattern,
				 @suppress_drift_types_json, @alert_on_drift_types_json, @severity_overrides_json,
				 @consecutive_missing_threshold, @alert_cooldown_ms, @pin_as_baseline, @allowed_types_json,
				 @adaptive_promotion_batches, @adaptive_promotion_min_elapsed_ms, @adaptive_retire_batches,
				 @created_at, @updated_at)
		`).run({
			uuid,
			enabled: data.enabled ? 1 : 0,
			priority: data.priority ?? 0,
			name: data.name ?? null,
			description: data.description ?? null,
			field_pattern: data.fieldPattern ?? null,
			device_pattern: data.devicePattern ?? null,
			endpoint_pattern: data.endpointPattern ?? null,
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

	static update(uuid: string, patch: Partial<DriftRuleConfig>): DriftRuleConfig | null {
		const fields: Record<string, unknown> = { updated_at: new Date().toISOString() };

		if (patch.enabled !== undefined) fields.enabled = patch.enabled ? 1 : 0;
		if (patch.priority !== undefined) fields.priority = patch.priority;
		if (patch.name !== undefined) fields.name = patch.name;
		if (patch.description !== undefined) fields.description = patch.description;
		if (patch.fieldPattern !== undefined) fields.field_pattern = patch.fieldPattern;
		if (patch.devicePattern !== undefined) fields.device_pattern = patch.devicePattern;
		if (patch.endpointPattern !== undefined) fields.endpoint_pattern = patch.endpointPattern;
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
