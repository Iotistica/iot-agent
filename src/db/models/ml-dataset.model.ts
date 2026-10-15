import { getDatabase } from '../sqlite.js';

export interface MlDatasetRecord {
	id: string;
	name: string;
	description: string;
	owner_username: string;
	point_keys: string;
	sampling_interval_secs: number;
	window_secs: number;
	missing_values: string;
	normalization: string;
	exclude_bad_quality: number;
	remove_outliers: number;
	outlier_method: string;
	output_format: string;
	created_at: string;
	updated_at: string;
}

export class MlDatasetModel {
	private static readonly table = 'ml_datasets';

	private static getDb() {
		return getDatabase();
	}

	static listByOwner(username: string): MlDatasetRecord[] {
		return this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE owner_username = ? ORDER BY created_at DESC`)
			.all(username) as unknown as MlDatasetRecord[];
	}

	static getById(id: string, username: string): MlDatasetRecord | null {
		const row = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE id = ? AND owner_username = ?`)
			.get(id, username);
		return (row as unknown as MlDatasetRecord | undefined) ?? null;
	}

	static getByIdUnscoped(id: string): MlDatasetRecord | null {
		const row = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE id = ?`)
			.get(id);
		return (row as unknown as MlDatasetRecord | undefined) ?? null;
	}

	static create(
		id: string,
		data: {
			name: string;
			description: string;
			point_keys: string;
			sampling_interval_secs: number;
			window_secs: number;
			missing_values: string;
			normalization: string;
			exclude_bad_quality: number;
			remove_outliers: number;
			outlier_method: string;
			output_format: string;
		},
		username: string,
	): MlDatasetRecord {
		const now = new Date().toISOString();
		this.getDb()
			.prepare(
				`INSERT INTO ${this.table}
				 (id, name, description, owner_username, point_keys,
				  sampling_interval_secs, window_secs, missing_values, normalization,
				  exclude_bad_quality, remove_outliers, outlier_method, output_format,
				  created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id, data.name, data.description, username, data.point_keys,
				data.sampling_interval_secs, data.window_secs, data.missing_values, data.normalization,
				data.exclude_bad_quality, data.remove_outliers, data.outlier_method, data.output_format,
				now, now,
			);
		return this.getById(id, username)!;
	}

	static update(
		id: string,
		data: Partial<{
			name: string;
			description: string;
			point_keys: string;
			sampling_interval_secs: number;
			window_secs: number;
			missing_values: string;
			normalization: string;
			exclude_bad_quality: number;
			remove_outliers: number;
			outlier_method: string;
			output_format: string;
		}>,
		username: string,
	): MlDatasetRecord | null {
		const existing = this.getById(id, username);
		if (!existing) return null;

		const fields: string[] = [];
		const values: (string | number | null)[] = [];

		for (const [key, value] of Object.entries(data)) {
			if (value !== undefined) {
				fields.push(`${key} = ?`);
				values.push(value as string | number | null);
			}
		}

		if (fields.length === 0) return existing;

		fields.push('updated_at = ?');
		values.push(new Date().toISOString());
		values.push(id, username);

		this.getDb()
			.prepare(`UPDATE ${this.table} SET ${fields.join(', ')} WHERE id = ? AND owner_username = ?`)
			.run(...values);

		return this.getById(id, username)!;
	}

	static delete(id: string, username: string): number {
		const result = this.getDb()
			.prepare(`DELETE FROM ${this.table} WHERE id = ? AND owner_username = ?`)
			.run(id, username);
		return Number(result.changes);
	}
}
