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

// A Date.now() fake, restored after each test — simulates elapsed
// wall-clock time without actually waiting, and without depending on
// state.totalBatches (an observation counter that increments once per
// device batch, not once per field — on a subscription-pushed source like
// OPC-UA it can run into the thousands within seconds, completely
// decoupled from how often any individual field reports).
//
// Deliberately starts from the REAL current time, not an arbitrary small
// number — the detector's cooldown check
// (Date.now() - (lastAlertAtBySignature.get(sig) ?? 0) >= alertCooldownMs)
// compares elapsed time against a default of 0 for a signature never seen
// before, which only behaves like "cooldown already elapsed" (the correct,
// always-true-in-production behavior) when "now" is already a realistically
// large epoch value. A small fake start value made every field's very
// first occurrence look like it was still within the 30-minute default
// cooldown of "epoch zero" — caught during development of this test suite.
function withFakeNow<T>(fn: (advanceBy: (ms: number) => void) => T): T {
	let now = Date.now();
	const original = Date.now;
	Date.now = () => now;
	try {
		return fn((ms) => { now += ms; });
	} finally {
		Date.now = original;
	}
}

describe('SchemaDriftDetector new-field promotion (time-based)', () => {
	test('a field reporting infrequently relative to a high device batch rate still promotes once enough real time has passed', () => {
		withFakeNow((advance) => {
			const store = makeFakeStore();
			const detector = new SchemaDriftDetector(
				'opcua-pipe',
				undefined,
				{ adaptivePromotionBatches: 3, adaptivePromotionMinElapsedMs: 10 * 60 * 1000 },
				store,
			);
			detector.declareDeviceSchema('AHU-1', ['sat']); // baseline has one declared field

			// Simulate a high device batch rate (many unrelated observations
			// between each appearance of 'zone_setpoint') by observing many
			// baseline-only batches, then the new field, repeated — mirroring a
			// setpoint that only reports every few minutes on a subscription
			// source that's otherwise firing constantly for unrelated nodes.
			// 5 rounds * 3 minutes/round comfortably clears both criteria at
			// once (occurrence count hits 3 after round 3; elapsed time only
			// clears adaptivePromotionMinElapsedMs=10min partway into round 4) —
			// promotion fires on whichever round first satisfies both.
			for (let i = 0; i < 5; i++) {
				for (let burst = 0; burst < 50; burst++) {
					advance(50); // 50 unrelated high-frequency batches, 50ms apart
					detector.observe([{ deviceName: 'AHU-1', metric: 'sat', value: 20 }]);
				}
				advance(3 * 60 * 1000); // then, minutes later, the setpoint reports
				detector.observe([
					{ deviceName: 'AHU-1', metric: 'sat', value: 20 },
					{ deviceName: 'AHU-1', metric: 'zone_setpoint', value: 21 },
				]);
			}

			const persisted = store.saved.at(-1)!;
			const device = persisted.devices['ahu_1'];
			assert.ok(
				device.baselineFields.includes('reading:zone_setpoint'),
				'an infrequent-but-reliably-reporting field should promote once adaptivePromotionMinElapsedMs has genuinely elapsed, regardless of how many unrelated batches occurred in between',
			);
		});
	});

	test('a field that appears in a rapid burst then is seen again does not promote before adaptivePromotionMinElapsedMs has elapsed', () => {
		withFakeNow((advance) => {
			const store = makeFakeStore();
			const detector = new SchemaDriftDetector(
				'opcua-pipe',
				undefined,
				{ adaptivePromotionBatches: 3, adaptivePromotionMinElapsedMs: 10 * 60 * 1000 },
				store,
			);
			detector.declareDeviceSchema('AHU-1', ['sat']);

			// Hits the occurrence count immediately (3 observations), but only
			// 2 seconds of wall-clock time pass — must not promote yet.
			for (let i = 0; i < 3; i++) {
				advance(1000);
				detector.observe([{ deviceName: 'AHU-1', metric: 'burst_field', value: 1 }]);
			}

			const persisted = store.saved.at(-1);
			const device = persisted?.devices?.['ahu_1'];
			assert.ok(
				!device?.baselineFields.includes('reading:burst_field'),
				'must not promote purely on occurrence count before adaptivePromotionMinElapsedMs has elapsed',
			);
		});
	});

	test('evictStaleNewFieldCandidates does not evict a candidate still within adaptiveRetireMs, even across many unrelated batches', () => {
		withFakeNow((advance) => {
			const store = makeFakeStore();
			const detector = new SchemaDriftDetector(
				'opcua-pipe',
				undefined,
				{ adaptiveRetireMs: 60 * 60 * 1000, adaptivePromotionBatches: 1000 }, // never promotes in this test
				store,
			);
			detector.declareDeviceSchema('AHU-1', ['sat']);

			detector.observe([
				{ deviceName: 'AHU-1', metric: 'sat', value: 20 },
				{ deviceName: 'AHU-1', metric: 'zone_setpoint', value: 21 },
			]);

			// 500 unrelated high-frequency batches — would have blown past the
			// old adaptiveRetireBatches=250 default many times over — but only
			// 25 seconds of real time, nowhere near adaptiveRetireMs.
			for (let i = 0; i < 500; i++) {
				advance(50);
				detector.observe([{ deviceName: 'AHU-1', metric: 'sat', value: 20 }]);
			}

			advance(50);
			detector.observe([
				{ deviceName: 'AHU-1', metric: 'sat', value: 20 },
				{ deviceName: 'AHU-1', metric: 'zone_setpoint', value: 21 },
			]);

			const persisted = store.saved.at(-1)!;
			const device = persisted.devices['ahu_1'];
			assert.equal(
				device.newFieldCounts?.['reading:zone_setpoint'],
				2,
				'the candidate must still be tracked (count preserved across the unrelated batches), not evicted and reset to a fresh candidate',
			);
		});
	});
});
