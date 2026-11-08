import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SchemaDriftDetector, type DriftAlertEvent } from '../detector.js';
import type { SchemaDriftStore, PersistedBaselineState } from '../types.js';

function makeFakeStore(): SchemaDriftStore & { saved: PersistedBaselineState[] } {
	return {
		saved: [],
		saveDrift() { /* not needed for these tests */ },
		saveBaseline(state: PersistedBaselineState) {
			this.saved.push(state);
		},
		loadBaseline() {
			return undefined;
		},
	};
}

// A naming-convention fix (this session's actual trigger) swaps an entire
// baseline's field names for a device at once — e.g. renaming every Modbus
// point to drop a stray uuid fragment. Without the bulk-change guard, every
// one of those fields independently crosses consecutiveMissingThreshold and
// fires as its own critical "missing-field" incident — 25 renamed fields,
// 25 misleading critical alerts, none of them a real failure.
describe('SchemaDriftDetector bulk-change guard', () => {
	test('a mass rename (>=50% of baseline replaced in one batch) raises zero alerts and refreshes the baseline', () => {
		const store = makeFakeStore();
		const alerts: DriftAlertEvent[] = [];
		const detector = new SchemaDriftDetector(
			'modbus-pipe',
			undefined,
			{ consecutiveMissingThreshold: 1 }, // would fire on the very next batch without the guard
			store,
		);
		detector.setDriftAlertHandler((event) => alerts.push(event));

		const oldFields = ['current_l1', 'current_l2', 'voltage_l1_n', 'voltage_l2_n', 'active_power_total'];
		detector.declareDeviceSchema('modbus-pm556x', oldFields);

		const newFields = ['modbus_pm556x_current_l1', 'modbus_pm556x_current_l2', 'modbus_pm556x_voltage_l1_n', 'modbus_pm556x_voltage_l2_n', 'modbus_pm556x_active_power_total'];
		detector.observe(
			newFields.map((metric) => ({ deviceName: 'modbus-pm556x', metric, value: 1 })),
		);

		assert.deepEqual(alerts, [], 'a mass rename must not raise any missing-field/new-field alerts');

		const persisted = store.saved.at(-1)!;
		const device = persisted.devices['modbus_pm556x'];
		assert.deepEqual(
			[...device.baselineFields].sort(),
			newFields.map((f) => `reading:${f}`).sort(),
			'baseline should be replaced with the newly observed field set',
		);
	});

	test('a single field going missing still fires a critical incident (guard must not swallow real drift)', () => {
		const store = makeFakeStore();
		const alerts: DriftAlertEvent[] = [];
		const detector = new SchemaDriftDetector(
			'modbus-pipe',
			undefined,
			{ consecutiveMissingThreshold: 1 },
			store,
		);
		detector.setDriftAlertHandler((event) => alerts.push(event));

		const fields = ['current_l1', 'current_l2', 'voltage_l1_n', 'voltage_l2_n', 'active_power_total'];
		detector.declareDeviceSchema('modbus-pm556x', fields);

		// Only one of five fields missing — well under the 50% bulk-change
		// ratio — must go through the normal per-field critical alert path.
		detector.observe(
			fields.slice(1).map((metric) => ({ deviceName: 'modbus-pm556x', metric, value: 1 })),
		);

		assert.equal(alerts.length, 1, 'expected exactly one missing-field alert');
		assert.equal(alerts[0].driftType, 'missing-field');
		assert.equal(alerts[0].fieldName, 'reading:current_l1');
	});

	test('bulkChangeMinFields floor prevents the guard from firing on a tiny baseline', () => {
		const store = makeFakeStore();
		const alerts: DriftAlertEvent[] = [];
		const detector = new SchemaDriftDetector(
			'modbus-pipe',
			undefined,
			{ consecutiveMissingThreshold: 1, bulkChangeMinFields: 5 },
			store,
		);
		detector.setDriftAlertHandler((event) => alerts.push(event));

		// Two fields, both renamed — 100% of baseline missing, but below the
		// absolute floor, so this must still be treated as ordinary drift
		// (two critical missing-field alerts), not auto-absorbed.
		detector.declareDeviceSchema('tiny-device', ['a', 'b']);
		detector.observe([
			{ deviceName: 'tiny-device', metric: 'c', value: 1 },
			{ deviceName: 'tiny-device', metric: 'd', value: 1 },
		]);

		const missingAlerts = alerts.filter((e) => e.driftType === 'missing-field');
		assert.equal(missingAlerts.length, 2, 'expected both renamed fields to be reported as missing, not absorbed');
	});
});
