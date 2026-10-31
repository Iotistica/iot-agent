import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { APP_TEMPLATES } from '../../data/app-templates.js';
import type { NativeSqliteMigration } from '../migration-types.js';

interface OldTemplate {
	id: string;
	name: string;
	category: string;
	description: string;
	color: string;
	letter: string;
	appName?: string;
	image?: string;
	services?: Array<{
		serviceName: string;
		image: string;
		ports?: string[];
		volumes?: string[];
		environment?: Record<string, string>;
		restart?: string;
		enableSocketDestination?: boolean;
	}>;
	[key: string]: unknown;
}

const CATEGORY_SEEDS: { name: string; color: string }[] = [
	{ name: 'Automation', color: '#fa8c16' },
	{ name: 'Monitoring', color: '#1677ff' },
	{ name: 'Time Series', color: '#722ed1' },
	{ name: 'MQTT', color: '#13c2c2' },
	{ name: 'Management', color: '#2f54eb' },
	{ name: 'IoT Platform', color: '#52c41a' },
	{ name: 'Database', color: '#f5222d' },
	{ name: 'AI', color: '#fa541c' },
	{ name: 'Iotistica', color: '#722ed1' },
];

function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS marketplace_categories (
			id TEXT PRIMARY KEY,
			name TEXT UNIQUE NOT NULL,
			color TEXT,
			sort_order INTEGER NOT NULL DEFAULT 0
		);
	`);

	const insertCat = db.prepare(
		'INSERT OR IGNORE INTO marketplace_categories (id, name, color, sort_order) VALUES (?, ?, ?, ?)',
	);
	CATEGORY_SEEDS.forEach((cat, index) => {
		insertCat.run(randomUUID(), cat.name, cat.color, index);
	});

	const rows = db.prepare('SELECT id, template_json FROM app_marketplace_templates').all() as unknown as
		{ id: string; template_json: string }[];

	const update = db.prepare('UPDATE app_marketplace_templates SET template_json = ? WHERE id = ?');

	for (const row of rows) {
		const old = JSON.parse(row.template_json) as OldTemplate;
		if (old.services && Array.isArray(old.services) && old.services.length > 0) {
			const svc = old.services[0];
			const flat: Record<string, unknown> = {
				id: old.id,
				name: old.name,
				category: old.category,
				description: old.description,
				color: old.color,
				letter: old.letter,
				image: svc.image,
			};
			if (svc.ports?.length) flat.ports = svc.ports;
			if (svc.volumes?.length) flat.volumes = svc.volumes;
			if (svc.environment && Object.keys(svc.environment).length) flat.environment = svc.environment;
			if (svc.restart) flat.restart = svc.restart;
			if (svc.enableSocketDestination) flat.enableSocketDestination = true;
			update.run(JSON.stringify(flat), row.id);
		}
	}

	const insert = db.prepare(`
		INSERT OR IGNORE INTO app_marketplace_templates (id, template_json, sort_order)
		VALUES (?, ?, ?)
	`);
	APP_TEMPLATES.forEach((template, index) => {
		insert.run(template.id, JSON.stringify(template), index);
	});
}

export const migration: NativeSqliteMigration = {
	name: '20261031000000_flatten_marketplace.js',
	up,
};
