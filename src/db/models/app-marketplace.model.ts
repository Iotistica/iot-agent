import { getDatabase } from '../sqlite.js';
import type { MarketplaceImage } from '../../data/app-templates.js';

interface TemplateRow {
	id: string;
	template_json: string;
}

export class AppMarketplaceModel {
	private static getDb() {
		return getDatabase();
	}

	static getAll(): MarketplaceImage[] {
		const rows = this.getDb()
			.prepare('SELECT id, template_json FROM app_marketplace_templates ORDER BY sort_order ASC, id ASC')
			.all() as unknown as TemplateRow[];
		return rows.map(row => JSON.parse(row.template_json) as MarketplaceImage);
	}

	static getById(id: string): MarketplaceImage | null {
		const row = this.getDb()
			.prepare('SELECT id, template_json FROM app_marketplace_templates WHERE id = ? LIMIT 1')
			.get(id) as unknown as TemplateRow | undefined;
		return row ? JSON.parse(row.template_json) as MarketplaceImage : null;
	}

	static create(template: MarketplaceImage): MarketplaceImage {
		this.getDb().prepare(`
			INSERT INTO app_marketplace_templates (id, template_json, sort_order)
			VALUES (?, ?, COALESCE((SELECT MAX(sort_order) + 1 FROM app_marketplace_templates), 0))
		`).run(template.id, JSON.stringify(template));
		return template;
	}

	static update(id: string, template: MarketplaceImage): MarketplaceImage | null {
		const result = this.getDb().prepare(`
			UPDATE app_marketplace_templates
			SET template_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			WHERE id = ?
		`).run(JSON.stringify(template), id);
		return result.changes > 0 ? this.getById(id) : null;
	}

	static delete(id: string): boolean {
		return this.getDb()
			.prepare('DELETE FROM app_marketplace_templates WHERE id = ?')
			.run(id).changes > 0;
	}
}
