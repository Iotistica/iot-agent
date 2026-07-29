import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';

describe('RecommendationPublishSettingsModel (integration)', () => {
	let dbPath: string;
	let RecommendationPublishSettingsModel: typeof import('../../src/db/models/recommendation-publish-settings.model').RecommendationPublishSettingsModel;
	let closeDatabase: () => void;

	beforeAll(() => {
		dbPath = path.join(os.tmpdir(), `publish-settings-model-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
		process.env.DATABASE_PATH = dbPath;

		const sqlite = require('../../src/db/sqlite');
		const { runMigrations } = require('../../src/db/migration-runner');

		const db: DatabaseSync = sqlite.getDatabase();
		runMigrations(db);
		closeDatabase = sqlite.closeDatabase;

		RecommendationPublishSettingsModel = require('../../src/db/models/recommendation-publish-settings.model').RecommendationPublishSettingsModel;
	});

	afterAll(() => {
		closeDatabase();
		for (const suffix of ['', '-wal', '-shm']) {
			fs.rmSync(`${dbPath}${suffix}`, { force: true });
		}
	});

	it('creates a default row on first read', () => {
		const settings = RecommendationPublishSettingsModel.getByModule('maintenance');
		expect(settings.module).toBe('maintenance');
		expect(settings.mqtt).toBe(false);
		expect(settings.cloud).toBe(true);
		expect(settings.alert_destination_id).toBeNull();
		expect(settings.alert_topic).toBeNull();
	});

	it('does not recreate the row on a second read (idempotent default)', () => {
		RecommendationPublishSettingsModel.getByModule('energy');
		RecommendationPublishSettingsModel.update('energy', { mqtt: true, alert_destination_id: 7 });

		const settings = RecommendationPublishSettingsModel.getByModule('energy');
		expect(settings.mqtt).toBe(true);
		expect(settings.alert_destination_id).toBe(7);
	});

	it('keeps maintenance and energy settings independent', () => {
		RecommendationPublishSettingsModel.update('maintenance', { mqtt: true, alert_topic: 'iotistica/alerts/maintenance' });
		RecommendationPublishSettingsModel.update('energy', { mqtt: false });

		const maintenance = RecommendationPublishSettingsModel.getByModule('maintenance');
		const energy = RecommendationPublishSettingsModel.getByModule('energy');

		expect(maintenance.mqtt).toBe(true);
		expect(maintenance.alert_topic).toBe('iotistica/alerts/maintenance');
		expect(energy.mqtt).toBe(false);
	});

	it('update() only changes the patched fields', () => {
		RecommendationPublishSettingsModel.update('maintenance', { alert_destination_id: 3, alert_topic: 'topic-a' });
		const updated = RecommendationPublishSettingsModel.update('maintenance', { alert_destination_id: 9 });

		expect(updated.alert_destination_id).toBe(9);
		expect(updated.alert_topic).toBe('topic-a'); // untouched
	});
});
