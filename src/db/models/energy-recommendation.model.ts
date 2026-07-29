import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../sqlite';

export type EnergyRecommendationStatus = 'open' | 'scheduled' | 'completed' | 'dismissed';

export interface EnergyRecommendation {
	id?: number;
	asset_id: number;
	asset_name: string;
	criticality: string;
	metric: string;
	rule_type: string;
	rule_config: Record<string, any>;
	status: EnergyRecommendationStatus;
	message: string;
	estimated_impact: string | null;
	confidence: number | null;
	consecutive_count: number;
	first_evaluated_at: number;
	last_evaluated_at: number;
	created_at?: string;
	updated_at?: string;
}

type EnergyRecommendationRow = Omit<EnergyRecommendation, 'rule_config'> & { rule_config: string };

/** What an evaluator hands in each tick — the model resolves open/reopen/history itself. */
export interface EnergyRecommendationEvalResult {
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

export class EnergyRecommendationModel {
	private static table = 'energy_recommendations';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	private static parseRow(row: EnergyRecommendationRow | undefined): EnergyRecommendation | null {
		if (!row) return null;
		return { ...row, rule_config: JSON.parse(row.rule_config) };
	}

	static getAll(): EnergyRecommendation[] {
		const rows = this.getDb()
			.prepare(`SELECT * FROM ${this.table} ORDER BY last_evaluated_at DESC`)
			.all() as unknown as EnergyRecommendationRow[];
		return rows.map(r => this.parseRow(r)).filter((r): r is EnergyRecommendation => r !== null);
	}

	static getById(id: number): EnergyRecommendation | null {
		const row = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE id = ? LIMIT 1`)
			.get(id) as unknown as EnergyRecommendationRow | undefined;
		return this.parseRow(row);
	}

	/** The one active (open/scheduled) row for this (asset, metric, rule), if any. */
	static getActive(assetId: number, metric: string, ruleType: string): EnergyRecommendation | null {
		const row = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE asset_id = ? AND metric = ? AND rule_type = ? AND status IN ('open', 'scheduled') LIMIT 1`)
			.get(assetId, metric, ruleType) as unknown as EnergyRecommendationRow | undefined;
		return this.parseRow(row);
	}

	/**
	 * Re-evaluate in place if an active row exists; otherwise open a new one (including
	 * right after a prior row for the same (asset, metric, rule) was completed/dismissed —
	 * the partial unique index only blocks a second *active* row, not a new history entry).
	 */
	static upsert(result: EnergyRecommendationEvalResult): EnergyRecommendation {
		const existing = this.getActive(result.asset_id, result.metric, result.rule_type);

		if (existing) {
			this.getDb().prepare(`
				UPDATE ${this.table} SET
					asset_name = @asset_name,
					criticality = @criticality,
					rule_config = @rule_config,
					message = @message,
					estimated_impact = @estimated_impact,
					confidence = @confidence,
					consecutive_count = consecutive_count + 1,
					last_evaluated_at = @last_evaluated_at,
					updated_at = @updated_at
				WHERE id = @id
			`).run({
				id: existing.id!,
				asset_name: result.asset_name,
				criticality: result.criticality,
				rule_config: JSON.stringify(result.rule_config),
				message: result.message,
				estimated_impact: result.estimated_impact,
				confidence: result.confidence,
				last_evaluated_at: result.evaluated_at,
				updated_at: new Date().toISOString(),
			});
			return this.getById(existing.id!)!;
		}

		const now = new Date().toISOString();
		const insertResult = this.getDb().prepare(`
			INSERT INTO ${this.table}
				(asset_id, asset_name, criticality, metric, rule_type, rule_config, status, message, estimated_impact, confidence, consecutive_count, first_evaluated_at, last_evaluated_at, created_at, updated_at)
			VALUES
				(@asset_id, @asset_name, @criticality, @metric, @rule_type, @rule_config, 'open', @message, @estimated_impact, @confidence, 1, @first_evaluated_at, @last_evaluated_at, @created_at, @updated_at)
		`).run({
			asset_id: result.asset_id,
			asset_name: result.asset_name,
			criticality: result.criticality,
			metric: result.metric,
			rule_type: result.rule_type,
			rule_config: JSON.stringify(result.rule_config),
			message: result.message,
			estimated_impact: result.estimated_impact,
			confidence: result.confidence,
			first_evaluated_at: result.evaluated_at,
			last_evaluated_at: result.evaluated_at,
			created_at: now,
			updated_at: now,
		});
		return this.getById(Number(insertResult.lastInsertRowid))!;
	}

	static updateStatus(id: number, status: EnergyRecommendationStatus): EnergyRecommendation | null {
		this.getDb().prepare(`UPDATE ${this.table} SET status = ?, updated_at = ? WHERE id = ?`)
			.run(status, new Date().toISOString(), id);
		return this.getById(id);
	}

	static deleteByAssetId(assetId: number): number {
		return Number(this.getDb().prepare(`DELETE FROM ${this.table} WHERE asset_id = ?`).run(assetId).changes);
	}
}
