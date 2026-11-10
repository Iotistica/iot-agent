import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync as Database } from 'node:sqlite';
import { MaintenanceEnergyService } from '../service.js';

/**
 * Minimal in-memory schema mirroring the columns iot-agent's migrations
 * create (see iot-agent/src/db/migrations/20260728000000_add_assets.ts and
 * 20260728010000_add_maintenance_energy.ts) — enough for the service's own
 * raw SQL in storage.ts to run against, without depending on the sibling
 * Community repo at test time.
 */
function createTestDb(): Database {
	const db = new Database(':memory:');
	db.exec(`
		CREATE TABLE assets (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			uuid TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			criticality TEXT NOT NULL DEFAULT 'medium',
			rated_life_hours REAL,
			rated_cycles INTEGER,
			last_service_date INTEGER
		);
		CREATE TABLE asset_metrics (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			asset_id INTEGER NOT NULL,
			device_uuid TEXT NOT NULL,
			endpoint_uuid TEXT,
			metric TEXT NOT NULL
		);
		CREATE TABLE maintenance_rules (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			asset_id INTEGER NOT NULL,
			component TEXT NOT NULL,
			rule_type TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1,
			config TEXT NOT NULL
		);
		CREATE TABLE energy_rules (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			asset_id INTEGER NOT NULL,
			metric TEXT NOT NULL,
			rule_type TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1,
			config TEXT NOT NULL
		);
		CREATE TABLE maintenance_recommendations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			asset_id INTEGER NOT NULL,
			asset_name TEXT NOT NULL,
			criticality TEXT NOT NULL,
			component TEXT NOT NULL,
			rule_type TEXT NOT NULL,
			rule_config TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'open',
			message TEXT NOT NULL,
			due_by INTEGER,
			confidence REAL,
			consecutive_count INTEGER NOT NULL DEFAULT 1,
			first_evaluated_at INTEGER NOT NULL,
			last_evaluated_at INTEGER NOT NULL,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
		CREATE UNIQUE INDEX maintenance_rec_active_unique ON maintenance_recommendations(asset_id, component, rule_type) WHERE status IN ('open', 'scheduled');
		CREATE TABLE energy_recommendations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			asset_id INTEGER NOT NULL,
			asset_name TEXT NOT NULL,
			criticality TEXT NOT NULL,
			metric TEXT NOT NULL,
			rule_type TEXT NOT NULL,
			rule_config TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'open',
			message TEXT NOT NULL,
			estimated_impact TEXT,
			confidence REAL,
			consecutive_count INTEGER NOT NULL DEFAULT 1,
			first_evaluated_at INTEGER NOT NULL,
			last_evaluated_at INTEGER NOT NULL,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
		CREATE UNIQUE INDEX energy_rec_active_unique ON energy_recommendations(asset_id, metric, rule_type) WHERE status IN ('open', 'scheduled');
		CREATE TABLE recommendation_publish_settings (
			module TEXT PRIMARY KEY,
			mqtt INTEGER NOT NULL DEFAULT 0,
			cloud INTEGER NOT NULL DEFAULT 1,
			alert_destination_id INTEGER,
			alert_topic TEXT,
			updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
	`);
	return db;
}

function setPublishSettings(db: Database, module: string, settings: { mqtt: boolean; cloud: boolean; alert_destination_id?: number | null; alert_topic?: string | null }) {
	db.prepare(`
		INSERT INTO recommendation_publish_settings (module, mqtt, cloud, alert_destination_id, alert_topic)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(module) DO UPDATE SET mqtt = excluded.mqtt, cloud = excluded.cloud, alert_destination_id = excluded.alert_destination_id, alert_topic = excluded.alert_topic
	`).run(module, settings.mqtt ? 1 : 0, settings.cloud ? 1 : 0, settings.alert_destination_id ?? null, settings.alert_topic ?? null);
}

/** Waits a tick of the microtask queue so fire-and-forget publish() promises (tick() doesn't await them) resolve before assertions run. */
function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

describe('MaintenanceEnergyService.tick', () => {
	let db: Database;
	let service: MaintenanceEnergyService;
	let assetId: number;

	beforeEach(() => {
		db = createTestDb();
		service = new MaintenanceEnergyService(db);

		const info = db.prepare(`INSERT INTO assets (uuid, name, criticality, rated_life_hours) VALUES ('asset-1', 'Compressor Unit A', 'high', 5000)`).run();
		assetId = Number(info.lastInsertRowid);
		db.prepare(`INSERT INTO asset_metrics (asset_id, device_uuid, endpoint_uuid, metric) VALUES (?, 'device-1', NULL, 'runtime_hours')`).run(assetId);
	});

	test('cumulative_runtime: feeds a data point, ticks, and writes an open recommendation', () => {
		db.prepare(`INSERT INTO maintenance_rules (asset_id, component, rule_type, enabled, config) VALUES (?, 'Compressor', 'cumulative_runtime', 1, ?)`)
			.run(assetId, JSON.stringify({ metric: 'runtime_hours', thresholdHours: 5000 }));

		const now = Date.now();
		service.processDataPoint('device-1', null, 'runtime_hours', 5200, now);
		service.tick(now);

		const rec = db.prepare('SELECT * FROM maintenance_recommendations WHERE asset_id = ?').get(assetId) as any;
		assert.ok(rec, 'expected a recommendation row to be written');
		assert.equal(rec.status, 'open');
		assert.equal(rec.component, 'Compressor');
		assert.equal(rec.criticality, 'high'); // denormalized from the asset
		assert.match(rec.message, /5200/);
	});

	test('does not fire below threshold, and does not create a row with no data at all', () => {
		db.prepare(`INSERT INTO maintenance_rules (asset_id, component, rule_type, enabled, config) VALUES (?, 'Compressor', 'cumulative_runtime', 1, ?)`)
			.run(assetId, JSON.stringify({ metric: 'runtime_hours', thresholdHours: 5000 }));

		service.tick(Date.now()); // no data point fed at all
		let rec = db.prepare('SELECT * FROM maintenance_recommendations WHERE asset_id = ?').get(assetId);
		assert.equal(rec, undefined);

		service.processDataPoint('device-1', null, 'runtime_hours', 1000, Date.now());
		service.tick(Date.now());
		rec = db.prepare('SELECT * FROM maintenance_recommendations WHERE asset_id = ?').get(assetId);
		assert.equal(rec, undefined);
	});

	test('re-ticking an already-open recommendation updates it in place, not a new row', () => {
		db.prepare(`INSERT INTO maintenance_rules (asset_id, component, rule_type, enabled, config) VALUES (?, 'Compressor', 'cumulative_runtime', 1, ?)`)
			.run(assetId, JSON.stringify({ metric: 'runtime_hours', thresholdHours: 5000 }));

		const t1 = Date.now();
		service.processDataPoint('device-1', null, 'runtime_hours', 5200, t1);
		service.tick(t1);

		const t2 = t1 + 60_000;
		service.processDataPoint('device-1', null, 'runtime_hours', 5300, t2);
		service.tick(t2);

		const rows = db.prepare('SELECT * FROM maintenance_recommendations WHERE asset_id = ?').all(assetId) as any[];
		assert.equal(rows.length, 1);
		assert.equal(rows[0].consecutive_count, 2);
		assert.match(rows[0].message, /5300/); // recomputed with the latest value
	});

	test('disabled rules are skipped entirely', () => {
		db.prepare(`INSERT INTO maintenance_rules (asset_id, component, rule_type, enabled, config) VALUES (?, 'Compressor', 'cumulative_runtime', 0, ?)`)
			.run(assetId, JSON.stringify({ metric: 'runtime_hours', thresholdHours: 5000 }));

		service.processDataPoint('device-1', null, 'runtime_hours', 9000, Date.now());
		service.tick(Date.now());

		const rec = db.prepare('SELECT * FROM maintenance_recommendations WHERE asset_id = ?').get(assetId);
		assert.equal(rec, undefined);
	});

	test('threshold_duration honors consecutiveWindowsRequired before firing', () => {
		db.prepare(`INSERT INTO maintenance_rules (asset_id, component, rule_type, enabled, config) VALUES (?, 'Bearing-1', 'threshold_duration', 1, ?)`)
			.run(assetId, JSON.stringify({
				metric: 'vibration_rms', threshold: 5, comparator: 'gt', sustainedForMs: 0, consecutiveWindowsRequired: 3,
			}));
		db.prepare(`INSERT INTO asset_metrics (asset_id, device_uuid, endpoint_uuid, metric) VALUES (?, 'device-1', NULL, 'vibration_rms')`).run(assetId);

		let t = Date.now();
		for (let i = 0; i < 2; i++) {
			t += 1000;
			service.processDataPoint('device-1', null, 'vibration_rms', 10, t);
			service.tick(t);
		}
		assert.equal(db.prepare('SELECT * FROM maintenance_recommendations WHERE asset_id = ?').get(assetId), undefined);

		t += 1000;
		service.processDataPoint('device-1', null, 'vibration_rms', 10, t);
		service.tick(t);
		assert.ok(db.prepare('SELECT * FROM maintenance_recommendations WHERE asset_id = ?').get(assetId));
	});

	test('energy rule (standby_waste) writes to energy_recommendations', () => {
		db.prepare(`INSERT INTO asset_metrics (asset_id, device_uuid, endpoint_uuid, metric) VALUES (?, 'device-1', NULL, 'power_draw_w')`).run(assetId);
		db.prepare(`INSERT INTO energy_rules (asset_id, metric, rule_type, enabled, config) VALUES (?, 'power_draw_w', 'standby_waste', 1, ?)`)
			.run(assetId, JSON.stringify({ metric: 'power_draw_w', standbyThreshold: 50, outsideScheduleOnly: false }));

		const now = Date.now();
		service.processDataPoint('device-1', null, 'power_draw_w', 10, now);
		service.tick(now);

		const rec = db.prepare('SELECT * FROM energy_recommendations WHERE asset_id = ?').get(assetId) as any;
		assert.ok(rec);
		assert.equal(rec.metric, 'power_draw_w');
		assert.equal(rec.rule_type, 'standby_waste');
	});

	test('opens a new recommendation row after the active one is closed out in the DB', () => {
		db.prepare(`INSERT INTO maintenance_rules (asset_id, component, rule_type, enabled, config) VALUES (?, 'Compressor', 'cumulative_runtime', 1, ?)`)
			.run(assetId, JSON.stringify({ metric: 'runtime_hours', thresholdHours: 5000 }));

		const t1 = Date.now();
		service.processDataPoint('device-1', null, 'runtime_hours', 5200, t1);
		service.tick(t1);

		const first = db.prepare('SELECT * FROM maintenance_recommendations WHERE asset_id = ?').get(assetId) as any;
		db.prepare(`UPDATE maintenance_recommendations SET status = 'completed' WHERE id = ?`).run(first.id);

		const t2 = t1 + 60_000;
		service.processDataPoint('device-1', null, 'runtime_hours', 5300, t2);
		service.tick(t2);

		const rows = db.prepare('SELECT * FROM maintenance_recommendations WHERE asset_id = ? ORDER BY id ASC').all(assetId) as any[];
		assert.equal(rows.length, 2);
		assert.equal(rows[0].status, 'completed');
		assert.equal(rows[1].status, 'open');
		assert.equal(rows[1].consecutive_count, 1);
	});
});

describe('MaintenanceEnergyService publishing', () => {
	let db: Database;
	let assetId: number;

	beforeEach(() => {
		db = createTestDb();
		const info = db.prepare(`INSERT INTO assets (uuid, name, criticality, rated_life_hours) VALUES ('asset-1', 'Compressor Unit A', 'high', 5000)`).run();
		assetId = Number(info.lastInsertRowid);
		db.prepare(`INSERT INTO asset_metrics (asset_id, device_uuid, endpoint_uuid, metric) VALUES (?, 'device-1', NULL, 'runtime_hours')`).run(assetId);
		db.prepare(`INSERT INTO maintenance_rules (asset_id, component, rule_type, enabled, config) VALUES (?, 'Compressor', 'cumulative_runtime', 1, ?)`)
			.run(assetId, JSON.stringify({ metric: 'runtime_hours', thresholdHours: 5000 }));
	});

	test('does not publish when both mqtt and cloud are disabled', async () => {
		setPublishSettings(db, 'maintenance', { mqtt: false, cloud: false });
		const publishSpy: any[] = [];
		const mqttManager = { isConnected: () => true, publish: async (...args: any[]) => { publishSpy.push(args); } };

		const service = new MaintenanceEnergyService(db, { mqttManager, deviceUuid: 'agent-1', buildTopic: (uuid, ...segs) => [uuid, ...segs].join('/') });
		service.processDataPoint('device-1', null, 'runtime_hours', 5200, Date.now());
		service.tick(Date.now());
		await flushMicrotasks();

		assert.equal(publishSpy.length, 0);
	});

	test('publishes to cloud on a new recommendation, but not again on re-evaluation', async () => {
		setPublishSettings(db, 'maintenance', { mqtt: false, cloud: true });
		const publishCalls: any[] = [];
		const mqttManager = { isConnected: () => true, publish: async (topic: string, payload: any) => { publishCalls.push({ topic, payload }); } };

		const service = new MaintenanceEnergyService(db, { mqttManager, deviceUuid: 'agent-1', buildTopic: (uuid, ...segs) => [uuid, ...segs].join('/') });

		const t1 = Date.now();
		service.processDataPoint('device-1', null, 'runtime_hours', 5200, t1);
		service.tick(t1);
		await flushMicrotasks();

		assert.equal(publishCalls.length, 1);
		assert.equal(publishCalls[0].topic, 'agent-1/events/maintenance');
		assert.equal(publishCalls[0].payload.format, 'json');
		assert.equal(publishCalls[0].payload.data.assetName, 'Compressor Unit A');
		assert.equal(publishCalls[0].payload.data.criticality, 'high');
		assert.equal(publishCalls[0].payload.data.component, 'Compressor');
		assert.equal(publishCalls[0].payload.data.status, 'open');

		// Re-evaluating the same still-open recommendation must not publish again.
		const t2 = t1 + 60_000;
		service.processDataPoint('device-1', null, 'runtime_hours', 5300, t2);
		service.tick(t2);
		await flushMicrotasks();

		assert.equal(publishCalls.length, 1);
	});

	test('publishes via the alert MQTT client when mqtt is enabled with a destination', async () => {
		setPublishSettings(db, 'maintenance', { mqtt: true, cloud: false, alert_destination_id: 42, alert_topic: 'custom/topic' });

		const connectCalls: number[] = [];
		const publishCalls: any[] = [];
		const fakeClient = {
			connect: async () => { connectCalls.push(1); },
			disconnect: async () => {},
			isConnected: () => true,
			publish: async (topic: string, payload: unknown) => { publishCalls.push({ topic, payload }); },
		};

		const getAlertDestination = (id: number) => (id === 42 ? { id: 42, type: 'mqtt', config_json: {} } : null);
		const createAlertMqttClient = () => fakeClient;

		const service = new MaintenanceEnergyService(db, { getAlertDestination, createAlertMqttClient: createAlertMqttClient as any });
		service.processDataPoint('device-1', null, 'runtime_hours', 5200, Date.now());
		service.tick(Date.now());
		await flushMicrotasks();

		assert.equal(connectCalls.length, 1);
		assert.equal(publishCalls.length, 1);
		assert.equal(publishCalls[0].topic, 'custom/topic');
		const payload = JSON.parse(publishCalls[0].payload.toString());
		assert.equal(payload.component, 'Compressor');
	});

	test('reconnects the alert client when alertDestinationId changes', async () => {
		setPublishSettings(db, 'maintenance', { mqtt: true, cloud: false, alert_destination_id: 1 });

		const disconnectCalls: number[] = [];
		const createdClientIds: number[] = [];
		const makeClient = (destId: number) => ({
			connect: async () => {},
			disconnect: async () => { disconnectCalls.push(destId); },
			isConnected: () => true,
			publish: async () => {},
		});

		const getAlertDestination = (id: number) => ({ id, type: 'mqtt', config_json: {} });
		const createAlertMqttClient = (_config: any, _deviceId?: string, _name?: string) => {
			// Infer which destination this is for from the currently-configured settings row.
			const row = db.prepare('SELECT alert_destination_id FROM recommendation_publish_settings WHERE module = ?').get('maintenance') as any;
			createdClientIds.push(row.alert_destination_id);
			return makeClient(row.alert_destination_id);
		};

		const service = new MaintenanceEnergyService(db, { getAlertDestination, createAlertMqttClient: createAlertMqttClient as any });

		// First recommendation — creates a client for destination 1.
		service.processDataPoint('device-1', null, 'runtime_hours', 5200, Date.now());
		service.tick(Date.now());
		await flushMicrotasks();

		// Change the destination, then trigger a second, distinct new recommendation
		// (different component) so publish() runs again against the same module.
		setPublishSettings(db, 'maintenance', { mqtt: true, cloud: false, alert_destination_id: 2 });
		db.prepare(`INSERT INTO maintenance_rules (asset_id, component, rule_type, enabled, config) VALUES (?, 'Bearing-1', 'cumulative_runtime', 1, ?)`)
			.run(assetId, JSON.stringify({ metric: 'runtime_hours', thresholdHours: 100 }));

		service.tick(Date.now());
		await flushMicrotasks();

		assert.deepEqual(createdClientIds, [1, 2]);
		assert.deepEqual(disconnectCalls, [1]);
	});
});
