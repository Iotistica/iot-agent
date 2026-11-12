/**
 * MAINTENANCE / ENERGY STORAGE
 * =============================
 *
 * Raw SQL against the agent.sqlite tables Community owns the schema for
 * (assets, asset_metrics, maintenance_rules, energy_rules,
 * maintenance_recommendations, energy_recommendations). Pro is a separate
 * npm package with zero import-time coupling to Community's TS model
 * classes, so this mirrors — deliberately, not by omission — the same
 * "Pro talks to Community's tables via a raw injected DB handle" pattern
 * already established in ../anomaly/storage.ts for anomaly_baselines.
 */

import type { DatabaseSync as Database } from 'node:sqlite';

export interface AssetRecord {
	id: number;
	uuid: string;
	name: string;
	criticality: string;
	rated_life_hours: number | null;
	rated_cycles: number | null;
	last_service_date: number | null;
}

export interface AssetMetricBinding {
	id: number;
	asset_id: number;
	device_uuid: string;
	endpoint_uuid: string | null;
	metric: string;
}

export interface MaintenanceRuleRecord {
	id: number;
	asset_id: number;
	component: string;
	rule_type: string;
	enabled: boolean;
	config: Record<string, any>;
}

export interface EnergyRuleRecord {
	id: number;
	asset_id: number;
	metric: string;
	rule_type: string;
	enabled: boolean;
	config: Record<string, any>;
}

export interface MaintenanceRecommendationUpsert {
	asset_id: number;
	asset_name: string;
	criticality: string;
	component: string;
	rule_type: string;
	rule_config: Record<string, any>;
	message: string;
	due_by: number | null;
	confidence: number | null;
	evaluated_at: number;
}

export interface EnergyRecommendationUpsert {
	asset_id: number;
	asset_name: string;
	criticality: string;
	metric: string;
	rule_type: string;
	rule_config: Record<string, any>;
	message: string;
	estimated_impact: string | null;
	confidence: number | null;
	evaluated_at: number;
}

export interface UpsertResult {
	id: number;
	/** True only when this call created a brand-new row (open, or reopened after a prior close) — false on an in-place re-evaluation of an already-active row. Callers use this to publish once per real event, not once per tick. */
	isNew: boolean;
}

export type RecommendationPublishModule = 'maintenance' | 'energy';

export interface PublishSettings {
	module: RecommendationPublishModule;
	mqtt: boolean;
	cloud: boolean;
	alertDestinationId: number | null;
	alertTopic: string | null;
}

export class MaintenanceEnergyStorageService {
	constructor(private db: Database) {}

	// ── Reads: rules + asset context ──────────────────────────────────────

	getEnabledMaintenanceRules(): MaintenanceRuleRecord[] {
		const rows = this.db.prepare('SELECT * FROM maintenance_rules WHERE enabled = 1 ORDER BY id ASC').all() as any[];
		return rows.map((r) => ({ ...r, enabled: !!r.enabled, config: JSON.parse(r.config) }));
	}

	getEnabledEnergyRules(): EnergyRuleRecord[] {
		const rows = this.db.prepare('SELECT * FROM energy_rules WHERE enabled = 1 ORDER BY id ASC').all() as any[];
		return rows.map((r) => ({ ...r, enabled: !!r.enabled, config: JSON.parse(r.config) }));
	}

	getAssetById(assetId: number): AssetRecord | null {
		const row = this.db.prepare('SELECT * FROM assets WHERE id = ? LIMIT 1').get(assetId) as AssetRecord | undefined;
		return row ?? null;
	}

	/** The metric binding(s) for a given asset + metric name — usually one, but the schema allows more than one device to report the same metric name for an asset. */
	getAssetMetricBindings(assetId: number, metric: string): AssetMetricBinding[] {
		return this.db
			.prepare('SELECT * FROM asset_metrics WHERE asset_id = ? AND metric = ?')
			.all(assetId, metric) as unknown as AssetMetricBinding[];
	}

	// ── Writes: recommendation upsert ──────────────────────────────────────
	// Mirrors MaintenanceRecommendationModel.upsert() / EnergyRecommendationModel.upsert()
	// in iot-agent exactly — same active-row lookup, same reopen-after-close semantics
	// (the partial unique index on (asset_id, component|metric, rule_type) WHERE status
	// IN ('open','scheduled') allows a fresh row once the old one is closed).

	upsertMaintenanceRecommendation(result: MaintenanceRecommendationUpsert): UpsertResult {
		const existing = this.db
			.prepare(`SELECT id FROM maintenance_recommendations WHERE asset_id = ? AND component = ? AND rule_type = ? AND status IN ('open', 'scheduled') LIMIT 1`)
			.get(result.asset_id, result.component, result.rule_type) as { id: number } | undefined;

		const nowIso = new Date().toISOString();

		if (existing) {
			this.db.prepare(`
				UPDATE maintenance_recommendations SET
					asset_name = ?, criticality = ?, rule_config = ?, message = ?, due_by = ?,
					confidence = ?, consecutive_count = consecutive_count + 1, last_evaluated_at = ?, updated_at = ?
				WHERE id = ?
			`).run(
				result.asset_name, result.criticality, JSON.stringify(result.rule_config), result.message,
				result.due_by, result.confidence, result.evaluated_at, nowIso, existing.id,
			);
			return { id: existing.id, isNew: false };
		}

		const insertResult = this.db.prepare(`
			INSERT INTO maintenance_recommendations
				(asset_id, asset_name, criticality, component, rule_type, rule_config, status, message, due_by, confidence, consecutive_count, first_evaluated_at, last_evaluated_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 1, ?, ?, ?, ?)
		`).run(
			result.asset_id, result.asset_name, result.criticality, result.component, result.rule_type,
			JSON.stringify(result.rule_config), result.message, result.due_by, result.confidence,
			result.evaluated_at, result.evaluated_at, nowIso, nowIso,
		);
		return { id: Number(insertResult.lastInsertRowid), isNew: true };
	}

	upsertEnergyRecommendation(result: EnergyRecommendationUpsert): UpsertResult {
		const existing = this.db
			.prepare(`SELECT id FROM energy_recommendations WHERE asset_id = ? AND metric = ? AND rule_type = ? AND status IN ('open', 'scheduled') LIMIT 1`)
			.get(result.asset_id, result.metric, result.rule_type) as { id: number } | undefined;

		const nowIso = new Date().toISOString();

		if (existing) {
			this.db.prepare(`
				UPDATE energy_recommendations SET
					asset_name = ?, criticality = ?, rule_config = ?, message = ?, estimated_impact = ?,
					confidence = ?, consecutive_count = consecutive_count + 1, last_evaluated_at = ?, updated_at = ?
				WHERE id = ?
			`).run(
				result.asset_name, result.criticality, JSON.stringify(result.rule_config), result.message,
				result.estimated_impact, result.confidence, result.evaluated_at, nowIso, existing.id,
			);
			return { id: existing.id, isNew: false };
		}

		const insertResult = this.db.prepare(`
			INSERT INTO energy_recommendations
				(asset_id, asset_name, criticality, metric, rule_type, rule_config, status, message, estimated_impact, confidence, consecutive_count, first_evaluated_at, last_evaluated_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 1, ?, ?, ?, ?)
		`).run(
			result.asset_id, result.asset_name, result.criticality, result.metric, result.rule_type,
			JSON.stringify(result.rule_config), result.message, result.estimated_impact, result.confidence,
			result.evaluated_at, result.evaluated_at, nowIso, nowIso,
		);
		return { id: Number(insertResult.lastInsertRowid), isNew: true };
	}

	// ── Publish settings ────────────────────────────────────────────────────
	// Mirrors RecommendationPublishSettingsModel in iot-agent exactly — same
	// default-row-on-first-read behavior, same column shape.

	getPublishSettings(module: RecommendationPublishModule): PublishSettings {
		const row = this.db
			.prepare('SELECT * FROM recommendation_publish_settings WHERE module = ? LIMIT 1')
			.get(module) as { module: string; mqtt: number; cloud: number; alert_destination_id: number | null; alert_topic: string | null } | undefined;

		if (row) {
			return {
				module,
				mqtt: !!row.mqtt,
				cloud: !!row.cloud,
				alertDestinationId: row.alert_destination_id,
				alertTopic: row.alert_topic,
			};
		}

		this.db.prepare(`
			INSERT INTO recommendation_publish_settings (module, mqtt, cloud, alert_destination_id, alert_topic)
			VALUES (?, 0, 1, NULL, NULL)
		`).run(module);

		return { module, mqtt: false, cloud: true, alertDestinationId: null, alertTopic: null };
	}
}
