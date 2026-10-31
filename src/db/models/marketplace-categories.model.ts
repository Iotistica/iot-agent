import { randomUUID } from 'node:crypto';
import { getDatabase } from '../sqlite.js';

export interface MarketplaceCategory {
	id: string;
	name: string;
	color: string | null;
	sort_order: number;
}

interface CategoryRow {
	id: string;
	name: string;
	color: string | null;
	sort_order: number;
}

export class MarketplaceCategoriesModel {
	private static getDb() {
		return getDatabase();
	}

	static getAll(): MarketplaceCategory[] {
		return this.getDb()
			.prepare('SELECT id, name, color, sort_order FROM marketplace_categories ORDER BY sort_order ASC, name ASC')
			.all() as unknown as CategoryRow[];
	}

	static create(name: string, color?: string): MarketplaceCategory {
		const id = randomUUID();
		const nextOrder = (this.getDb()
			.prepare('SELECT COALESCE(MAX(sort_order) + 1, 0) AS next_order FROM marketplace_categories')
			.get() as { next_order: number }).next_order;
		this.getDb().prepare(
			'INSERT INTO marketplace_categories (id, name, color, sort_order) VALUES (?, ?, ?, ?)',
		).run(id, name, color ?? null, nextOrder);
		return { id, name, color: color ?? null, sort_order: nextOrder };
	}

	static delete(id: string): boolean {
		return this.getDb()
			.prepare('DELETE FROM marketplace_categories WHERE id = ?')
			.run(id).changes > 0;
	}
}
