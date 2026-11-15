import { DatabaseSync } from 'node:sqlite';
import * as sqlite from '../../../src/db/sqlite';
import { migration } from '../../../src/db/migrations/20261116000000_subscription_sources';
import { PublishSubscriptionsModel } from '../../../src/db/models/publish-subscriptions.model';

describe('subscription source relationships', () => {
	let db: DatabaseSync;

	beforeEach(() => {
		db = new DatabaseSync(':memory:');
		db.exec(`
			PRAGMA foreign_keys = ON;
			CREATE TABLE endpoints (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
			CREATE TABLE publish_subscriptions (
				id INTEGER PRIMARY KEY, publish_destination_id INTEGER NOT NULL, topics TEXT NOT NULL,
				route_json TEXT, payload_format TEXT NOT NULL, compression TEXT, ml_dataset_id TEXT,
				enabled INTEGER NOT NULL, created_at TEXT, updated_at TEXT
			);
			INSERT INTO endpoints VALUES (1, 'plc 1'), (2, 'plc 2');
			INSERT INTO publish_subscriptions VALUES
				(1, 1, '[]', '{"includeDevices":["plc 1","plc 2","deleted"],"excludeDevices":["deleted"],"topic":"out"}', 'tags', NULL, NULL, 1, NULL, NULL),
				(2, 1, '[]', '{"includeDevices":["deleted"]}', 'tags', NULL, NULL, 1, NULL, NULL),
				(3, 1, '[]', NULL, 'tags', NULL, NULL, 1, NULL, NULL);
		`);
		migration.up(db);
		jest.spyOn(sqlite, 'getDatabase').mockReturnValue(db);
	});

	afterEach(() => {
		jest.restoreAllMocks();
		db.close();
	});

	it('migrates existing selections and drops unmatched names without broadening the filter', () => {
		expect(PublishSubscriptionsModel.getById(1)?.route_json).toMatchObject({
			includeDevices: ['plc 1', 'plc 2'], sourceFilterMode: 'specific', topic: 'out',
		});
		expect(PublishSubscriptionsModel.getById(2)).toMatchObject({
			enabled: true, route_json: { includeDevices: [], sourceFilterMode: 'specific' },
		});
		expect(PublishSubscriptionsModel.getById(3)?.route_json).toBeNull();
		expect(db.prepare('SELECT route_json FROM publish_subscriptions WHERE id = 1').get()?.route_json).toBe('{"topic":"out"}');
	});

	it('cascades source deletion without changing subscriptions and retains specific mode when empty', () => {
		const before = db.prepare('SELECT * FROM publish_subscriptions WHERE id = 1').get();
		db.prepare('DELETE FROM endpoints WHERE id = ?').run(1);
		expect(PublishSubscriptionsModel.getById(1)?.route_json?.includeDevices).toEqual(['plc 2']);
		expect(db.prepare('SELECT * FROM publish_subscriptions WHERE id = 1').get()).toEqual(before);
		db.prepare('DELETE FROM endpoints WHERE id = ?').run(2);
		expect(PublishSubscriptionsModel.getById(1)).toMatchObject({
			enabled: true, route_json: { includeDevices: [], sourceFilterMode: 'specific', topic: 'out' },
		});
		expect(db.prepare('SELECT * FROM publish_subscriptions WHERE id = 1').get()).toEqual(before);
	});

	it('tracks source renames and atomically rejects unknown source selections', () => {
		db.prepare('UPDATE endpoints SET name = ? WHERE id = ?').run('renamed', 1);
		expect(PublishSubscriptionsModel.getById(1)?.route_json?.includeDevices).toEqual(['renamed', 'plc 2']);
		expect(() => PublishSubscriptionsModel.update(1, {
			route_json: { includeDevices: ['missing'], topic: 'new' },
		})).toThrow('missing or ambiguous');
		expect(PublishSubscriptionsModel.getById(1)?.route_json).toMatchObject({
			includeDevices: ['renamed', 'plc 2'], topic: 'out',
		});
	});

	it('creates and updates relations and cascades subscription deletion', () => {
		const created = PublishSubscriptionsModel.create({
			publish_destination_id: 1, topics: [], route_json: { includeDevices: ['plc 1'] },
			payload_format: 'tags', enabled: true,
		})!;
		expect(created.route_json).toMatchObject({ includeDevices: ['plc 1'], sourceFilterMode: 'specific' });
		const updated = PublishSubscriptionsModel.update(created.id!, { route_json: { excludeDevices: ['plc 2'] } });
		expect(updated?.route_json).toEqual({ excludeDevices: ['plc 2'] });
		PublishSubscriptionsModel.delete(created.id!);
		expect(db.prepare('SELECT * FROM subscription_source_filters WHERE subscription_id = ?').get(created.id!)).toBeUndefined();
		expect(db.prepare('SELECT * FROM subscription_source_members WHERE subscription_id = ?').get(created.id!)).toBeUndefined();
	});
});
