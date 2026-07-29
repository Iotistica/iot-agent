import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../sqlite';

export type MaintenanceRecommendationStatus = 'open' | 'scheduled' | 'completed' | 'dismissed';

export interface MaintenanceRecommendation {
	id?: number;
	asset_id: number;
	asset_name: string;
	criticality: string;
	component: string;
	rule_type: string;
	rule_config: Record<string, any>;
	status: MaintenanceRecommendationStatus;
	message: string;
	due_by: number | null;
	confidence: number | null;
	consecutive_count: number;
	first_evaluated_at: number;
	last_evaluated_at: number;
	created_at?: string;
	updated_at?: string;
}

type MaintenanceRecommendationRow = Omit<MaintenanceRecommendation, 'rule_config'> & { rule_config: string };

/** What an evaluator hands in each tick — the model resolves open/reopen/history itself. */
export interface MaintenanceRecommendationEvalResult {
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

export class MaintenanceRecommendationModel {
	private static table = 'maintenance_recommendations';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	private static parseRow(row: MaintenanceRecommendationRow | undefined): MaintenanceRecommendation | null {
		if (!row) return null;
		return { ...row, rule_config: JSON.parse(row.rule_config) };
	}

	static getAll(): MaintenanceRecommendation[] {
		const rows = this.getDb()
			.prepare(`SELECT * FROM ${this.table} ORDER BY last_evaluated_at DESC`)
			.all() as unknown as MaintenanceRecommendationRow[];
		return rows.map(r => this.parseRow(r)).filter((r): r is MaintenanceRecommendation => r !== null);
	}

	static getById(id: number): MaintenanceRecommendation | null {
		const row = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE id = ? LIMIT 1`)
			.get(id) as unknown as MaintenanceRecommendationRow | undefined;
		return this.parseRow(row);
	}

	/** The one active (open/scheduled) row for this (asset, component, rule), if any. */
	static getActive(assetId: number, component: string, ruleType: string): MaintenanceRecommendation | null {
		const row = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE asset_id = ? AND component = ? AND rule_type = ? AND status IN ('open', 'scheduled') LIMIT 1`)
			.get(assetId, component, ruleType) as unknown as MaintenanceRecommendationRow | undefined;
		return this.parseRow(row);
	}

	/**
	 * Re-evaluate in place if an active row exists; otherwise open a new one (including
	 * right after a prior row for the same (asset, component, rule) was completed/dismissed —
	 * the partial unique index only blocks a second *active* row, not a new history entry).
	 */
	static upsert(result: MaintenanceRecommendationEvalResult): MaintenanceRecommendation {
		const existing = this.getActive(result.asset_id, result.component, result.rule_type);

		if (existing) {
			this.getDb().prepare(`
				UPDATE ${this.table} SET
					asset_name = @asset_name,
					criticality = @criticality,
					rule_config = @rule_config,
					message = @message,
					due_by = @due_by,
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
				due_by: result.due_by,
				confidence: result.confidence,
				last_evaluated_at: result.evaluated_at,
				updated_at: new Date().toISOString(),
			});
			return this.getById(existing.id!)!;
		}

		const now = new Date().toISOString();
		const insertResult = this.getDb().prepare(`
			INSERT INTO ${this.table}
				(asset_id, asset_name, criticality, component, rule_type, rule_config, status, message, due_by, confidence, consecutive_count, first_evaluated_at, last_evaluated_at, created_at, updated_at)
			VALUES
				(@asset_id, @asset_name, @criticality, @component, @rule_type, @rule_config, 'open', @message, @due_by, @confidence, 1, @first_evaluated_at, @last_evaluated_at, @created_at, @updated_at)
		`).run({
			asset_id: result.asset_id,
			asset_name: result.asset_name,
			criticality: result.criticality,
			component: result.component,
			rule_type: result.rule_type,
			rule_config: JSON.stringify(result.rule_config),
			message: result.message,
			due_by: result.due_by,
			confidence: result.confidence,
			first_evaluated_at: result.evaluated_at,
			last_evaluated_at: result.evaluated_at,
			created_at: now,
			updated_at: now,
		});
		return this.getById(Number(insertResult.lastInsertRowid))!;
	}

	static updateStatus(id: number, status: MaintenanceRecommendationStatus): MaintenanceRecommendation | null {
		this.getDb().prepare(`UPDATE ${this.table} SET status = ?, updated_at = ? WHERE id = ?`)
			.run(status, new Date().toISOString(), id);
		return this.getById(id);
	}

	static deleteByAssetId(assetId: number): number {
		return Number(this.getDb().prepare(`DELETE FROM ${this.table} WHERE asset_id = ?`).run(assetId).changes);
	}
}
