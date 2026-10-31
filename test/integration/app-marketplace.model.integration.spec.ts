import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { APP_TEMPLATES } from '../../src/data/app-templates';
import type { AppTemplate } from '../../src/data/app-templates';

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

	it('seeds the existing catalog without changing its schema or values', () => {
		expect(AppMarketplaceModel.getAll()).toEqual(APP_TEMPLATES);
	});

	it('persists custom templates and supports get, update, and delete', () => {
		const template: AppTemplate = {
			id: 'custom-image',
			name: 'Custom Image',
			category: 'Custom',
			description: 'A custom deployment',
			color: '#123456',
			letter: 'CI',
			appName: 'custom-app',
			services: [{
				serviceName: 'custom-service',
				image: 'example/custom:1',
				ports: ['8080:80'],
				volumes: ['custom-data:/data'],
				environment: { MODE: 'production' },
				restart: 'unless-stopped',
				enableSocketDestination: true,
			}],
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

	it('does not re-seed over changed entries or create duplicates on later startup', () => {
		const existing = APP_TEMPLATES[0];
		const updated = { ...existing, description: 'Locally customized' };
		AppMarketplaceModel.update(existing.id, updated);
		AppMarketplaceModel.create({
			...APP_TEMPLATES[0],
			id: 'user-created',
			name: 'User Created',
			appName: 'user-created',
		});

		runMigrations(db);

		expect(AppMarketplaceModel.getById(existing.id)).toEqual(updated);
		expect(AppMarketplaceModel.getById('user-created')?.name).toBe('User Created');
		expect(AppMarketplaceModel.getAll().filter(template => template.id === existing.id)).toHaveLength(1);
	});
});
