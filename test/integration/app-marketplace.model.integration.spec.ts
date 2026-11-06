import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import type { MarketplaceImage } from '../../src/data/marketplace-image';
import { migration as seedAppMarketplace } from '../../src/db/migrations/20261106000000_seed_app_marketplace';

describe('AppMarketplaceModel (integration)', () => {
	let dbPath: string;
	let db: DatabaseSync;
	let AppMarketplaceModel: typeof import('../../src/db/models/app-marketplace.model').AppMarketplaceModel;
	let runMigrations: (database: DatabaseSync) => void;
	let closeDatabase: () => void;

	beforeAll(() => {
		dbPath = path.join(os.tmpdir(), `app-marketplace-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
		process.env.DATABASE_PATH = dbPath;

		const sqlite = require('../../src/db/sqlite');
		runMigrations = require('../../src/db/migration-runner').runMigrations;
		db = sqlite.getDatabase();
		runMigrations(db);
		closeDatabase = sqlite.closeDatabase;
		AppMarketplaceModel = require('../../src/db/models/app-marketplace.model').AppMarketplaceModel;
	});

	afterAll(() => {
		closeDatabase();
		for (const suffix of ['', '-wal', '-shm']) {
			fs.rmSync(`${dbPath}${suffix}`, { force: true });
		}
	});

	it('seeds the built-in catalog from SQLite', () => {
		const templates = AppMarketplaceModel.getAll();

		expect(templates.map(template => template.id)).toEqual([
			'node-red',
			'home-assistant',
			'n8n',
			'grafana',
			'prometheus',
			'telegraf',
			'influxdb',
			'timescaledb',
			'mosquitto',
			'emqx',
			'portainer',
			'zigbee2mqtt',
			'frigate',
			'postgres',
			'redis',
			'socket-listener',
			'socket-listener-python',
			'mqtt-sim',
			'opcua-sim',
			'ollama',
		]);
		expect(AppMarketplaceModel.getById('node-red')).toEqual({
			id: 'node-red',
			name: 'Node-RED',
			category: 'Automation',
			description: 'Low-code programming for event-driven IoT applications and automations.',
			color: '#8F0000',
			letter: 'NR',
			image: 'nodered/node-red:latest',
			ports: ['1880:1880'],
			volumes: ['node-red-data:/data'],
			environment: { TZ: 'UTC' },
			restart: 'unless-stopped',
		});
	});

	it('persists custom templates and supports get, update, and delete', () => {
		const template: MarketplaceImage = {
			id: 'custom-image',
			name: 'Custom Image',
			category: 'Custom',
			description: 'A custom deployment',
			color: '#123456',
			letter: 'CI',
			image: 'example/custom:1',
			ports: ['8080:80'],
			volumes: ['custom-data:/data'],
			environment: { MODE: 'production' },
			restart: 'unless-stopped',
			enableSocketDestination: true,
		};

		expect(AppMarketplaceModel.create(template)).toEqual(template);
		expect(AppMarketplaceModel.getById(template.id)).toEqual(template);

		const updated = { ...template, description: 'Updated deployment' };
		expect(AppMarketplaceModel.update(template.id, updated)).toEqual(updated);
		expect(AppMarketplaceModel.getById(template.id)).toEqual(updated);
		expect(AppMarketplaceModel.update('missing', updated)).toBeNull();

		expect(AppMarketplaceModel.delete(template.id)).toBe(true);
		expect(AppMarketplaceModel.delete(template.id)).toBe(false);
		expect(AppMarketplaceModel.getById(template.id)).toBeNull();
	});

	it('does not overwrite customized or user-created templates when seed migration is reapplied', () => {
		const existing = AppMarketplaceModel.getById('node-red')!;
		const updated = { ...existing, description: 'Locally customized' };
		AppMarketplaceModel.update(existing.id, updated);
		AppMarketplaceModel.create({
			...existing,
			id: 'user-created',
			name: 'User Created',
		});
		AppMarketplaceModel.delete('ollama');

		seedAppMarketplace.up(db);

		expect(AppMarketplaceModel.getById(existing.id)).toEqual(updated);
		expect(AppMarketplaceModel.getById('user-created')?.name).toBe('User Created');
		expect(AppMarketplaceModel.getById('ollama')).toBeNull();
		expect(AppMarketplaceModel.getAll().filter(template => template.id === existing.id)).toHaveLength(1);
	});
});
