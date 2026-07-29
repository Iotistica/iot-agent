import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';

describe('Maintenance/Energy rule + recommendation models (integration)', () => {
	let dbPath: string;
	let AssetModel: typeof import('../../src/db/models/asset.model').AssetModel;
	let MaintenanceRuleModel: typeof import('../../src/db/models/maintenance-rule.model').MaintenanceRuleModel;
	let EnergyRuleModel: typeof import('../../src/db/models/energy-rule.model').EnergyRuleModel;
	let MaintenanceRecommendationModel: typeof import('../../src/db/models/maintenance-recommendation.model').MaintenanceRecommendationModel;
	let EnergyRecommendationModel: typeof import('../../src/db/models/energy-recommendation.model').EnergyRecommendationModel;
	let closeDatabase: () => void;
	let assetId: number;

	beforeAll(() => {
		dbPath = path.join(os.tmpdir(), `maint-energy-model-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
		process.env.DATABASE_PATH = dbPath;

		const sqlite = require('../../src/db/sqlite');
		const { runMigrations } = require('../../src/db/migration-runner');

		const db: DatabaseSync = sqlite.getDatabase();
		runMigrations(db);
		closeDatabase = sqlite.closeDatabase;

		AssetModel = require('../../src/db/models/asset.model').AssetModel;
		MaintenanceRuleModel = require('../../src/db/models/maintenance-rule.model').MaintenanceRuleModel;
		EnergyRuleModel = require('../../src/db/models/energy-rule.model').EnergyRuleModel;
		MaintenanceRecommendationModel = require('../../src/db/models/maintenance-recommendation.model').MaintenanceRecommendationModel;
		EnergyRecommendationModel = require('../../src/db/models/energy-recommendation.model').EnergyRecommendationModel;

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
		assetId = asset.id!;
	});

	afterAll(() => {
		closeDatabase();
		for (const suffix of ['', '-wal', '-shm']) {
			fs.rmSync(`${dbPath}${suffix}`, { force: true });
		}
	});

	describe('MaintenanceRuleModel / EnergyRuleModel', () => {
		it('creates and reads back a maintenance rule with JSON config', () => {
			const rule = MaintenanceRuleModel.create({
				asset_id: assetId,
				component: 'Bearing-1',
				rule_type: 'cumulative_runtime',
				enabled: true,
				config: { metric: 'runtime_hours', thresholdHours: 5000 },
			});

			expect(rule.id).toBeTruthy();
			expect(rule.config).toEqual({ metric: 'runtime_hours', thresholdHours: 5000 });

			const fetched = MaintenanceRuleModel.getById(rule.id!);
			expect(fetched?.config.thresholdHours).toBe(5000);
		});

		it('getEnabled excludes disabled rules', () => {
			const enabled = MaintenanceRuleModel.create({
				asset_id: assetId,
				component: 'Bearing-2',
				rule_type: 'cycle_count',
				enabled: true,
				config: { metric: 'start_stop_count', thresholdCycles: 100 },
			});
			MaintenanceRuleModel.create({
				asset_id: assetId,
				component: 'Bearing-3',
				rule_type: 'cycle_count',
				enabled: false,
				config: { metric: 'start_stop_count', thresholdCycles: 100 },
			});

			const enabledRules = MaintenanceRuleModel.getEnabled();
			expect(enabledRules.map(r => r.id)).toContain(enabled.id);
			expect(enabledRules.every(r => r.enabled)).toBe(true);
		});

		it('creates and reads back an energy rule', () => {
			const rule = EnergyRuleModel.create({
				asset_id: assetId,
				metric: 'power_draw_w',
				rule_type: 'standby_waste',
				enabled: true,
				config: { standbyThreshold: 50, outsideScheduleOnly: false },
			});

			expect(EnergyRuleModel.getById(rule.id!)?.config.standbyThreshold).toBe(50);
		});
	});

	describe('MaintenanceRecommendationModel upsert semantics', () => {
		const evalResult = (overrides: Partial<Parameters<typeof MaintenanceRecommendationModel.upsert>[0]> = {}) => ({
			asset_id: assetId,
			asset_name: 'Compressor Unit A',
			criticality: 'high',
			component: 'Bearing-1',
			rule_type: 'cumulative_runtime',
			rule_config: { metric: 'runtime_hours', thresholdHours: 5000 },
			message: 'Service due: 5000h runtime threshold crossed',
			due_by: null,
			confidence: 0.9,
			evaluated_at: Date.now(),
			...overrides,
		});

		it('opens a new recommendation on first evaluation', () => {
			const rec = MaintenanceRecommendationModel.upsert(evalResult());

			expect(rec.status).toBe('open');
			expect(rec.consecutive_count).toBe(1);
			expect(rec.first_evaluated_at).toBe(rec.last_evaluated_at);
		});

		it('re-evaluates the same open recommendation in place, incrementing consecutive_count', () => {
			const first = MaintenanceRecommendationModel.upsert(evalResult({ component: 'Bearing-4' }));
			const laterTs = first.first_evaluated_at + 60_000;

			const second = MaintenanceRecommendationModel.upsert(evalResult({ component: 'Bearing-4', evaluated_at: laterTs }));

			expect(second.id).toBe(first.id); // same row, not a new one
			expect(second.consecutive_count).toBe(2);
			expect(second.first_evaluated_at).toBe(first.first_evaluated_at); // unchanged
			expect(second.last_evaluated_at).toBe(laterTs);
		});

		it('opens a NEW row after the active one is marked completed, rather than reopening it', () => {
			const first = MaintenanceRecommendationModel.upsert(evalResult({ component: 'Bearing-5' }));
			MaintenanceRecommendationModel.updateStatus(first.id!, 'completed');

			const second = MaintenanceRecommendationModel.upsert(evalResult({ component: 'Bearing-5', evaluated_at: first.first_evaluated_at + 120_000 }));

			expect(second.id).not.toBe(first.id);
			expect(second.status).toBe('open');
			expect(second.consecutive_count).toBe(1);

			// The old completed row is untouched — history preserved.
			const oldRow = MaintenanceRecommendationModel.getById(first.id!);
			expect(oldRow?.status).toBe('completed');
		});

		it('opens a NEW row after the active one is dismissed', () => {
			const first = MaintenanceRecommendationModel.upsert(evalResult({ component: 'Bearing-6' }));
			MaintenanceRecommendationModel.updateStatus(first.id!, 'dismissed');

			const second = MaintenanceRecommendationModel.upsert(evalResult({ component: 'Bearing-6', evaluated_at: first.first_evaluated_at + 120_000 }));

			expect(second.id).not.toBe(first.id);
			expect(second.status).toBe('open');
		});

		it('treats a "scheduled" recommendation as still active (re-evaluates in place)', () => {
			const first = MaintenanceRecommendationModel.upsert(evalResult({ component: 'Bearing-7' }));
			MaintenanceRecommendationModel.updateStatus(first.id!, 'scheduled');

			const second = MaintenanceRecommendationModel.upsert(evalResult({ component: 'Bearing-7', evaluated_at: first.first_evaluated_at + 60_000 }));

			expect(second.id).toBe(first.id);
			expect(second.status).toBe('scheduled'); // upsert doesn't change status, only recomputes fields
		});
	});

	describe('EnergyRecommendationModel upsert semantics', () => {
		it('opens a new recommendation, then re-evaluates in place, then reopens fresh after completion', () => {
			const base = {
				asset_id: assetId,
				asset_name: 'Compressor Unit A',
				criticality: 'high',
				metric: 'power_draw_w',
				rule_type: 'standby_waste',
				rule_config: { standbyThreshold: 50 },
				message: 'Standby waste detected outside operating hours',
				estimated_impact: '~4.2 kWh/day',
				confidence: 0.8,
			};

			const first = EnergyRecommendationModel.upsert({ ...base, evaluated_at: Date.now() });
			expect(first.consecutive_count).toBe(1);

			const second = EnergyRecommendationModel.upsert({ ...base, evaluated_at: first.first_evaluated_at + 60_000 });
			expect(second.id).toBe(first.id);
			expect(second.consecutive_count).toBe(2);

			EnergyRecommendationModel.updateStatus(second.id!, 'completed');
			const third = EnergyRecommendationModel.upsert({ ...base, evaluated_at: first.first_evaluated_at + 120_000 });
			expect(third.id).not.toBe(second.id);
			expect(third.status).toBe('open');
		});
	});
});
