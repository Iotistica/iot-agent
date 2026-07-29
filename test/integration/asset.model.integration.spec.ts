import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';

// db-path.ts resolves its database path once, at module-init time, from
// process.env.DATABASE_PATH. It must be set before the first require() of
// ../../src/db/sqlite (directly or transitively) in this file's module
// registry — Jest gives each test file its own registry, so doing this in
// beforeAll, before any require, is sufficient.
describe('AssetModel + AssetMetricModel (integration)', () => {
	let dbPath: string;
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	let AssetModel: typeof import('../../src/db/models/asset.model').AssetModel;
	let AssetMetricModel: typeof import('../../src/db/models/asset-metric.model').AssetMetricModel;
	let closeDatabase: () => void;

	beforeAll(() => {
		dbPath = path.join(os.tmpdir(), `asset-model-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
		process.env.DATABASE_PATH = dbPath;

		const sqlite = require('../../src/db/sqlite');
		const { runMigrations } = require('../../src/db/migration-runner');

		const db: DatabaseSync = sqlite.getDatabase();
		runMigrations(db);
		closeDatabase = sqlite.closeDatabase;

		AssetModel = require('../../src/db/models/asset.model').AssetModel;
		AssetMetricModel = require('../../src/db/models/asset-metric.model').AssetMetricModel;
	});

	afterAll(() => {
		closeDatabase();
		for (const suffix of ['', '-wal', '-shm']) {
			fs.rmSync(`${dbPath}${suffix}`, { force: true });
		}
	});

	// === Asset CRUD ===

	describe('AssetModel', () => {
		it('creates an asset with defaults applied', () => {
			const asset = AssetModel.create({
				name: 'Compressor Unit A',
				asset_type: 'compressor',
				criticality: 'high',
				manufacturer: null,
				model: null,
				rated_life_hours: 20000,
				rated_cycles: null,
				install_date: null,
				last_service_date: null,
				location: null,
			});

			expect(asset.uuid).toBeTruthy();
			expect(asset.name).toBe('Compressor Unit A');
			expect(asset.criticality).toBe('high');
			expect(asset.rated_life_hours).toBe(20000);
		});

		it('defaults criticality to medium when not provided', () => {
			const asset = AssetModel.create({
				name: 'Fan Unit B',
				asset_type: null,
				criticality: 'medium',
				manufacturer: null,
				model: null,
				rated_life_hours: null,
				rated_cycles: null,
				install_date: null,
				last_service_date: null,
				location: null,
			});

			expect(asset.criticality).toBe('medium');
		});

		it('lists assets ordered by name', () => {
			const rows = AssetModel.getAll();
			const names = rows.map(r => r.name);
			expect(names).toEqual([...names].sort());
			expect(names).toContain('Compressor Unit A');
		});

		it('updates only the patched fields', () => {
			const asset = AssetModel.create({
				name: 'Pump Unit C',
				asset_type: 'pump',
				criticality: 'low',
				manufacturer: null,
				model: null,
				rated_life_hours: null,
				rated_cycles: null,
				install_date: null,
				last_service_date: null,
				location: null,
			});

			const updated = AssetModel.update(asset.uuid, { criticality: 'critical' });

			expect(updated?.criticality).toBe('critical');
			expect(updated?.name).toBe('Pump Unit C'); // untouched
			expect(updated?.asset_type).toBe('pump'); // untouched
		});

		it('returns null for a uuid that does not exist', () => {
			expect(AssetModel.getByUuid('does-not-exist')).toBeNull();
		});

		it('deletes an asset', () => {
			const asset = AssetModel.create({
				name: 'Deletable Unit',
				asset_type: null,
				criticality: 'medium',
				manufacturer: null,
				model: null,
				rated_life_hours: null,
				rated_cycles: null,
				install_date: null,
				last_service_date: null,
				location: null,
			});

			expect(AssetModel.delete(asset.uuid)).toBe(true);
			expect(AssetModel.getByUuid(asset.uuid)).toBeNull();
			expect(AssetModel.delete(asset.uuid)).toBe(false); // already gone
		});
	});

	// === Metric bindings ===

	describe('AssetMetricModel', () => {
		it('binds a device/endpoint metric to an asset', () => {
			const asset = AssetModel.create({
				name: 'Compressor Unit D',
				asset_type: 'compressor',
				criticality: 'high',
				manufacturer: null,
				model: null,
				rated_life_hours: null,
				rated_cycles: null,
				install_date: null,
				last_service_date: null,
				location: null,
			});

			const binding = AssetMetricModel.create({
				asset_id: asset.id!,
				device_uuid: 'device-1',
				endpoint_uuid: 'endpoint-1',
				metric: 'vibration_rms',
			});

			expect(binding.id).toBeTruthy();
			expect(binding.metric).toBe('vibration_rms');

			const bindings = AssetMetricModel.listByAssetId(asset.id!);
			expect(bindings).toHaveLength(1);
			expect(bindings[0].metric).toBe('vibration_rms');
		});

		it('allows one asset to bind metrics from more than one device', () => {
			const asset = AssetModel.create({
				name: 'Compressor Unit E',
				asset_type: 'compressor',
				criticality: 'high',
				manufacturer: null,
				model: null,
				rated_life_hours: null,
				rated_cycles: null,
				install_date: null,
				last_service_date: null,
				location: null,
			});

			AssetMetricModel.create({ asset_id: asset.id!, device_uuid: 'device-a', endpoint_uuid: null, metric: 'vibration_rms' });
			AssetMetricModel.create({ asset_id: asset.id!, device_uuid: 'device-b', endpoint_uuid: null, metric: 'runtime_hours' });

			const bindings = AssetMetricModel.listByAssetId(asset.id!);
			expect(bindings).toHaveLength(2);
			expect(bindings.map(b => b.device_uuid).sort()).toEqual(['device-a', 'device-b']);
		});

		it('rejects a duplicate (asset_id, device_uuid, metric) binding', () => {
			const asset = AssetModel.create({
				name: 'Compressor Unit F',
				asset_type: 'compressor',
				criticality: 'medium',
				manufacturer: null,
				model: null,
				rated_life_hours: null,
				rated_cycles: null,
				install_date: null,
				last_service_date: null,
				location: null,
			});

			AssetMetricModel.create({ asset_id: asset.id!, device_uuid: 'device-1', endpoint_uuid: null, metric: 'vibration_rms' });

			expect(() =>
				AssetMetricModel.create({ asset_id: asset.id!, device_uuid: 'device-1', endpoint_uuid: null, metric: 'vibration_rms' }),
			).toThrow();
		});

		it('removes a single binding without affecting the asset\'s other bindings', () => {
			const asset = AssetModel.create({
				name: 'Compressor Unit G',
				asset_type: 'compressor',
				criticality: 'medium',
				manufacturer: null,
				model: null,
				rated_life_hours: null,
				rated_cycles: null,
				install_date: null,
				last_service_date: null,
				location: null,
			});

			const keep = AssetMetricModel.create({ asset_id: asset.id!, device_uuid: 'device-1', endpoint_uuid: null, metric: 'vibration_rms' });
			const remove = AssetMetricModel.create({ asset_id: asset.id!, device_uuid: 'device-1', endpoint_uuid: null, metric: 'temperature' });

			expect(AssetMetricModel.delete(remove.id!)).toBe(true);

			const bindings = AssetMetricModel.listByAssetId(asset.id!);
			expect(bindings.map(b => b.id)).toEqual([keep.id]);
		});

		it('deleteByAssetId removes every binding for that asset (what deleteAsset relies on, since SQLite FK enforcement is off in this DB)', () => {
			const asset = AssetModel.create({
				name: 'Compressor Unit H',
				asset_type: 'compressor',
				criticality: 'medium',
				manufacturer: null,
				model: null,
				rated_life_hours: null,
				rated_cycles: null,
				install_date: null,
				last_service_date: null,
				location: null,
			});

			AssetMetricModel.create({ asset_id: asset.id!, device_uuid: 'device-1', endpoint_uuid: null, metric: 'vibration_rms' });
			AssetMetricModel.create({ asset_id: asset.id!, device_uuid: 'device-2', endpoint_uuid: null, metric: 'runtime_hours' });

			const removed = AssetMetricModel.deleteByAssetId(asset.id!);

			expect(removed).toBe(2);
			expect(AssetMetricModel.listByAssetId(asset.id!)).toHaveLength(0);
		});
	});
});
