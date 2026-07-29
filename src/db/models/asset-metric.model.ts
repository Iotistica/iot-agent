import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../sqlite';

export interface AssetMetric {
	id?: number;
	asset_id: number;
	device_uuid: string;
	endpoint_uuid: string | null;
	metric: string;
	created_at?: string;
	updated_at?: string;
}

export type AssetMetricCreateData = Omit<AssetMetric, 'id' | 'created_at' | 'updated_at'>;

export class AssetMetricModel {
	private static table = 'asset_metrics';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	static listByAssetId(assetId: number): AssetMetric[] {
		return this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE asset_id = ? ORDER BY id ASC`)
			.all(assetId) as unknown as AssetMetric[];
	}

	static getById(id: number): AssetMetric | null {
		const row = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE id = ? LIMIT 1`)
			.get(id) as unknown as AssetMetric | undefined;
		return row ?? null;
	}

	static create(data: AssetMetricCreateData): AssetMetric {
		const now = new Date().toISOString();
		const result = this.getDb().prepare(`
			INSERT INTO ${this.table} (asset_id, device_uuid, endpoint_uuid, metric, created_at, updated_at)
			VALUES (@asset_id, @device_uuid, @endpoint_uuid, @metric, @created_at, @updated_at)
		`).run({
			asset_id: data.asset_id,
			device_uuid: data.device_uuid,
			endpoint_uuid: data.endpoint_uuid ?? null,
			metric: data.metric,
			created_at: now,
			updated_at: now,
		});
		return this.getById(Number(result.lastInsertRowid))!;
	}

	static delete(id: number): boolean {
		return this.getDb().prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id).changes > 0;
	}

	static deleteByAssetId(assetId: number): number {
		return Number(this.getDb().prepare(`DELETE FROM ${this.table} WHERE asset_id = ?`).run(assetId).changes);
	}
}
