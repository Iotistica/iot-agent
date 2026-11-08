import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SchemaDriftDetector } from '../detector.js';
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

describe('SchemaDriftDetector.declareDeviceSchema', () => {
	test('seeds a baseline directly for a device that has never been observed', () => {
		const store = makeFakeStore();
		const detector = new SchemaDriftDetector('opcua-pipe', undefined, undefined, store);

		detector.declareDeviceSchema('AHU-1', ['CC-Valve', 'HC-Valve', 'Filter-DP-Alarm']);

		const persisted = store.saved.at(-1);
		assert.ok(persisted, 'expected a baseline to be persisted');
		const device = persisted!.devices?.['ahu_1'];
		assert.ok(device, 'expected the declared fields to land in the "ahu_1" bucket (matching resolveDeviceId normalization)');
		assert.deepEqual(
			[...device!.baselineFields].sort(),
			['reading:cc_valve', 'reading:filter_dp_alarm', 'reading:hc_valve'],
		);
	});

	test('a field declared but never observed does not get flagged as missing', () => {
		const store = makeFakeStore();
		const detector = new SchemaDriftDetector('opcua-pipe', undefined, { consecutiveMissingThreshold: 1 }, store);

		detector.declareDeviceSchema('AHU-1', ['CC-Valve', 'HC-Valve']);

		// Observe a batch that only reports cc_valve (hc_valve hasn't fired since
		// restart, exactly like the real fault/manual-behavior fields) — this
		// must not evict or flag hc_valve as drift, since it's declared/known.
		detector.observe([{ deviceName: 'AHU-1', metric: 'cc_valve', value: 22 }]);

		const persisted = store.saved.at(-1)!;
		const device = persisted.devices!['ahu_1'];
		assert.ok(device.baselineFields.includes('reading:hc_valve'), 'hc_valve should remain in baseline despite zero observations');
	});

	test('is additive — merges with fields already promoted through normal observation', () => {
		const store = makeFakeStore();
		const detector = new SchemaDriftDetector('opcua-pipe', undefined, undefined, store);

		// Declare after some fields may already be tracked some other way —
		// re-declaring the same field twice must be a harmless no-op.
		detector.declareDeviceSchema('AHU-1', ['CC-Valve']);
		detector.declareDeviceSchema('AHU-1', ['CC-Valve', 'HC-Valve']);

		const persisted = store.saved.at(-1)!;
		const device = persisted.devices!['ahu_1'];
		assert.deepEqual([...device.baselineFields].sort(), ['reading:cc_valve', 'reading:hc_valve']);
	});
});
