import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createBuffer, addValue } from '../../anomaly/buffer.js';
import {
	evaluateCumulativeRuntime,
	evaluateCycleCount,
	evaluateThresholdDuration,
	evaluateStandbyWaste,
	evaluateScheduleMismatch,
	evaluateDutyCycle,
} from '../evaluators.js';
import type { EvaluatorContext } from '../types.js';

const NO_ASSET = { ratedLifeHours: null, ratedCycles: null, lastServiceDate: null };

function ctx(buffer: ReturnType<typeof createBuffer>, now: number, gatingBuffer?: ReturnType<typeof createBuffer>): EvaluatorContext {
	return { now, buffer, gatingBuffer, asset: NO_ASSET };
}

describe('evaluateCumulativeRuntime', () => {
	test('does not trigger below threshold', () => {
		const buf = createBuffer(10);
		addValue(buf, 4999, 1000);
		const result = evaluateCumulativeRuntime({ metric: 'runtime_hours', thresholdHours: 5000 }, ctx(buf, 1000));
		assert.equal(result.triggered, false);
	});

	test('triggers once the counter crosses the threshold', () => {
		const buf = createBuffer(10);
		addValue(buf, 5000, 1000);
		const result = evaluateCumulativeRuntime({ metric: 'runtime_hours', thresholdHours: 5000 }, ctx(buf, 1000));
		assert.equal(result.triggered, true);
		assert.match(result.message, /5000/);
	});

	test('windowGating suppresses the rule outside the valid operating envelope', () => {
		const buf = createBuffer(10);
		addValue(buf, 6000, 1000);
		const gating = createBuffer(10);
		addValue(gating, 5, 1000); // e.g. temperature during startup transient

		const config = { metric: 'runtime_hours', thresholdHours: 5000, windowGating: { metric: 'temp', min: 10 } };
		const result = evaluateCumulativeRuntime(config, ctx(buf, 1000, gating));
		assert.equal(result.triggered, false);
	});

	test('windowGating allows firing when the gating metric is within range', () => {
		const buf = createBuffer(10);
		addValue(buf, 6000, 1000);
		const gating = createBuffer(10);
		addValue(gating, 20, 1000);

		const config = { metric: 'runtime_hours', thresholdHours: 5000, windowGating: { metric: 'temp', min: 10, max: 30 } };
		const result = evaluateCumulativeRuntime(config, ctx(buf, 1000, gating));
		assert.equal(result.triggered, true);
	});

	test('does not trigger with no data', () => {
		const buf = createBuffer(10);
		const result = evaluateCumulativeRuntime({ metric: 'runtime_hours', thresholdHours: 5000 }, ctx(buf, 1000));
		assert.equal(result.triggered, false);
	});
});

describe('evaluateCycleCount', () => {
	test('triggers once cycles cross the threshold', () => {
		const buf = createBuffer(10);
		addValue(buf, 101, 1000);
		const result = evaluateCycleCount({ metric: 'start_stop_count', thresholdCycles: 100 }, ctx(buf, 1000));
		assert.equal(result.triggered, true);
	});

	test('does not trigger below threshold', () => {
		const buf = createBuffer(10);
		addValue(buf, 99, 1000);
		const result = evaluateCycleCount({ metric: 'start_stop_count', thresholdCycles: 100 }, ctx(buf, 1000));
		assert.equal(result.triggered, false);
	});
});

describe('evaluateThresholdDuration', () => {
	const config = {
		metric: 'vibration_rms',
		threshold: 5,
		comparator: 'gt' as const,
		sustainedForMs: 10_000,
		consecutiveWindowsRequired: 1,
	};

	test('does not trigger if the value has only just crossed the threshold', () => {
		const buf = createBuffer(20);
		addValue(buf, 3, 0);
		addValue(buf, 6, 1000); // crossed 1s ago — not sustained for 10s yet
		const result = evaluateThresholdDuration(config, ctx(buf, 1000));
		assert.equal(result.triggered, false);
	});

	test('triggers once the value has stayed past threshold for sustainedForMs', () => {
		const buf = createBuffer(20);
		addValue(buf, 6, 0);
		addValue(buf, 7, 5000);
		addValue(buf, 8, 11_000); // sustained continuously since t=0
		const result = evaluateThresholdDuration(config, ctx(buf, 11_000));
		assert.equal(result.triggered, true);
	});

	test('does not trigger if the condition broke and only recently resumed', () => {
		const buf = createBuffer(20);
		addValue(buf, 6, 0);
		addValue(buf, 2, 5000); // dropped below threshold — breaks the continuous run
		addValue(buf, 7, 11_000); // back above, but only for a moment
		const result = evaluateThresholdDuration(config, ctx(buf, 11_000));
		assert.equal(result.triggered, false);
	});

	test('lt comparator triggers on a sustained low reading', () => {
		const ltConfig = { ...config, comparator: 'lt' as const, threshold: 2 };
		const buf = createBuffer(20);
		addValue(buf, 1, 0);
		addValue(buf, 1, 11_000);
		const result = evaluateThresholdDuration(ltConfig, ctx(buf, 11_000));
		assert.equal(result.triggered, true);
	});
});

describe('evaluateStandbyWaste', () => {
	const config = { metric: 'power_draw_w', standbyThreshold: 50, outsideScheduleOnly: false };

	test('triggers when the reading is below the standby threshold', () => {
		const buf = createBuffer(10);
		addValue(buf, 10, 1000);
		const result = evaluateStandbyWaste(config, ctx(buf, 1000));
		assert.equal(result.triggered, true);
	});

	test('does not trigger above the standby threshold', () => {
		const buf = createBuffer(10);
		addValue(buf, 200, 1000);
		const result = evaluateStandbyWaste(config, ctx(buf, 1000));
		assert.equal(result.triggered, false);
	});

	test('outsideScheduleOnly suppresses idle draw observed during operating hours', () => {
		const buf = createBuffer(10);
		addValue(buf, 10, 1000);
		const scheduleConfig = {
			...config,
			outsideScheduleOnly: true,
			schedule: { start: '08:00', end: '18:00', days: [0, 1, 2, 3, 4, 5, 6] },
		};
		// 2024-01-01 is a Monday, noon local time — well inside 08:00-18:00
		const noon = new Date(2024, 0, 1, 12, 0, 0).getTime();
		const result = evaluateStandbyWaste(scheduleConfig, ctx(buf, noon));
		assert.equal(result.triggered, false);
	});

	test('outsideScheduleOnly still fires for idle draw observed outside operating hours', () => {
		const buf = createBuffer(10);
		addValue(buf, 10, 1000);
		const scheduleConfig = {
			...config,
			outsideScheduleOnly: true,
			schedule: { start: '08:00', end: '18:00', days: [0, 1, 2, 3, 4, 5, 6] },
		};
		const midnight = new Date(2024, 0, 1, 0, 0, 0).getTime();
		const result = evaluateStandbyWaste(scheduleConfig, ctx(buf, midnight));
		assert.equal(result.triggered, true);
	});
});

describe('evaluateScheduleMismatch', () => {
	const config = {
		metric: 'run_state',
		expectedSchedule: { start: '08:00', end: '18:00', days: [1] }, // Monday only
		toleranceMinutes: 0,
	};

	test('flags off when the schedule expects it running', () => {
		const buf = createBuffer(10);
		addValue(buf, 0, 1000); // off
		const monday = new Date(2024, 0, 1, 12, 0, 0).getTime(); // Monday noon
		const result = evaluateScheduleMismatch(config, ctx(buf, monday));
		assert.equal(result.triggered, true);
		assert.match(result.message, /off.*running/);
	});

	test('flags running when the schedule expects it off', () => {
		const buf = createBuffer(10);
		addValue(buf, 1, 1000); // on
		const mondayNight = new Date(2024, 0, 1, 22, 0, 0).getTime(); // Monday 10pm, outside 08-18
		const result = evaluateScheduleMismatch(config, ctx(buf, mondayNight));
		assert.equal(result.triggered, true);
	});

	test('does not flag matching state', () => {
		const buf = createBuffer(10);
		addValue(buf, 1, 1000); // on
		const monday = new Date(2024, 0, 1, 12, 0, 0).getTime();
		const result = evaluateScheduleMismatch(config, ctx(buf, monday));
		assert.equal(result.triggered, false);
	});
});

describe('evaluateDutyCycle', () => {
	test('triggers when the on ratio falls below expectedMinRatio', () => {
		const buf = createBuffer(20);
		// Off for the whole window
		addValue(buf, 0, 0);
		addValue(buf, 0, 60_000);
		const config = { metric: 'run_state', windowMs: 60_000, expectedMinRatio: 0.5 };
		const result = evaluateDutyCycle(config, ctx(buf, 60_000));
		assert.equal(result.triggered, true);
		assert.match(result.message, /below the expected minimum/);
	});

	test('triggers when the on ratio exceeds expectedMaxRatio', () => {
		const buf = createBuffer(20);
		addValue(buf, 1, 0);
		addValue(buf, 1, 60_000);
		const config = { metric: 'run_state', windowMs: 60_000, expectedMaxRatio: 0.5 };
		const result = evaluateDutyCycle(config, ctx(buf, 60_000));
		assert.equal(result.triggered, true);
		assert.match(result.message, /above the expected maximum/);
	});

	test('does not trigger within the expected range', () => {
		const buf = createBuffer(20);
		addValue(buf, 1, 0);
		addValue(buf, 0, 30_000);
		const config = { metric: 'run_state', windowMs: 60_000, expectedMinRatio: 0.2, expectedMaxRatio: 0.8 };
		const result = evaluateDutyCycle(config, ctx(buf, 60_000));
		assert.equal(result.triggered, false);
	});

	test('does not trigger with no data in the window', () => {
		const buf = createBuffer(20);
		const config = { metric: 'run_state', windowMs: 60_000, expectedMinRatio: 0.2 };
		const result = evaluateDutyCycle(config, ctx(buf, 60_000));
		assert.equal(result.triggered, false);
	});
});
