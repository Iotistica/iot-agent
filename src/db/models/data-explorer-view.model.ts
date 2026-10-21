import { getDatabase } from '../sqlite.js';

export interface DataExplorerViewRecord {
	id: string;
	name: string;
	description: string;
	point_keys: string;
	filters: string | null;
	owner_username: string;
	display_order: number;
	created_at: string;
	updated_at: string;
}

export class DataExplorerViewModel {
	private static readonly table = 'data_explorer_views';

	private static getDb() {
		return getDatabase();
	}

	static listByOwner(username: string): DataExplorerViewRecord[] {
		return this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE owner_username = ? ORDER BY display_order ASC, created_at ASC`)
			.all(username) as unknown as DataExplorerViewRecord[];
	}

	static getById(id: string, username: string): DataExplorerViewRecord | null {
		const row = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE id = ? AND owner_username = ?`)
			.get(id, username);
		return (row as unknown as DataExplorerViewRecord | undefined) ?? null;
	}

	static create(
		id: string,
		name: string,
		description: string,
		pointKeys: string,
		filters: string | null,
		username: string,
	): DataExplorerViewRecord {
		const now = new Date().toISOString();
		const maxOrder = this.getDb()
			.prepare(`SELECT COALESCE(MAX(display_order), -1) AS m FROM ${this.table} WHERE owner_username = ?`)
			.get(username) as { m: number };

		this.getDb()
			.prepare(
				`INSERT INTO ${this.table} (id, name, description, point_keys, filters, owner_username, display_order, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(id, name, description, pointKeys, filters, username, maxOrder.m + 1, now, now);

		return this.getById(id, username)!;
	}

	static update(
		id: string,
		data: { name?: string; description?: string; pointKeys?: string },
		username: string,
	): DataExplorerViewRecord | null {
		const existing = this.getById(id, username);
		if (!existing) return null;

		const name = data.name ?? existing.name;
		const description = data.description ?? existing.description;
		const pointKeys = data.pointKeys ?? existing.point_keys;
		const now = new Date().toISOString();

		this.getDb()
			.prepare(
				`UPDATE ${this.table} SET name = ?, description = ?, point_keys = ?, updated_at = ?
				 WHERE id = ? AND owner_username = ?`,
			)
			.run(name, description, pointKeys, now, id, username);

		return this.getById(id, username)!;
	}

	static delete(id: string, username: string): number {
		const result = this.getDb()
			.prepare(`DELETE FROM ${this.table} WHERE id = ? AND owner_username = ?`)
			.run(id, username);
		return Number(result.changes);
	}
}
