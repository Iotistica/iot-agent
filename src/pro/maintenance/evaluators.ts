import { getLatestSample, continuousDurationMs, onRatioWithinWindow } from './buffer-helpers.js';
import { isWithinSchedule } from './schedule.js';
import type {
	CumulativeRuntimeRuleConfig,
	CycleCountRuleConfig,
	ThresholdDurationRuleConfig,
	StandbyWasteRuleConfig,
	ScheduleMismatchRuleConfig,
	DutyCycleRuleConfig,
	EvaluatorContext,
	EvaluationOutcome,
	WindowGating,
} from './types.js';
import { NOT_TRIGGERED } from './types.js';

/** True (gating passes) when no gating is configured, or the gating metric's latest reading is unavailable. */
function passesGating(gating: WindowGating | undefined, gatingBuffer: EvaluatorContext['gatingBuffer']): boolean {
	if (!gating) return true;
	if (!gatingBuffer) return true;

	const sample = getLatestSample(gatingBuffer);
	if (!sample) return true;

	if (gating.min !== undefined && sample.value < gating.min) return false;
	if (gating.max !== undefined && sample.value > gating.max) return false;
	return true;
}

/**
 * Cumulative runtime: fires once the counter metric's current value crosses
 * thresholdHours. Assumes the underlying counter is reset by whoever performs
 * the service (a common pattern on PLCs/HMIs — "runtime since last reset"),
 * so v1 compares the raw current value directly rather than trying to derive
 * a delta from assets.last_service_date — there's no historical time-series
 * store to look up "value at that past timestamp" against.
 */
export function evaluateCumulativeRuntime(config: CumulativeRuntimeRuleConfig, ctx: EvaluatorContext): EvaluationOutcome {
	if (!passesGating(config.windowGating, ctx.gatingBuffer)) return NOT_TRIGGERED;

	const sample = getLatestSample(ctx.buffer);
	if (!sample) return NOT_TRIGGERED;

	if (sample.value < config.thresholdHours) return NOT_TRIGGERED;

	return {
		triggered: true,
		message: `${config.metric} has run ${sample.value.toFixed(0)}h, past the ${config.thresholdHours}h service threshold`,
		dueBy: ctx.now, // already due — no forecasting in v1, see plan's Deferred section
		confidence: 1,
	};
}

/** Cycle count: same reset-counter assumption as cumulative runtime, but for discrete start/stop cycles. */
export function evaluateCycleCount(config: CycleCountRuleConfig, ctx: EvaluatorContext): EvaluationOutcome {
	const sample = getLatestSample(ctx.buffer);
	if (!sample) return NOT_TRIGGERED;

	if (sample.value < config.thresholdCycles) return NOT_TRIGGERED;

	return {
		triggered: true,
		message: `${config.metric} has reached ${sample.value.toFixed(0)} cycles, past the ${config.thresholdCycles}-cycle threshold`,
		dueBy: ctx.now,
		confidence: 1,
	};
}

/**
 * Threshold duration: fires when the metric has stayed past `threshold` for
 * at least `sustainedForMs`. The additional consecutiveWindowsRequired
 * debounce (requiring N separate evaluation ticks to agree, not just one
 * sustained stretch) is applied by the caller/service, not here — this
 * function only answers "does the condition currently hold," matching how
 * every other evaluator in this module stays a pure per-tick check.
 */
export function evaluateThresholdDuration(config: ThresholdDurationRuleConfig, ctx: EvaluatorContext): EvaluationOutcome {
	if (!passesGating(config.windowGating, ctx.gatingBuffer)) return NOT_TRIGGERED;

	const durationMs = continuousDurationMs(ctx.buffer, config.threshold, config.comparator);
	if (durationMs < config.sustainedForMs) return NOT_TRIGGERED;

	const sample = getLatestSample(ctx.buffer);
	const comparatorWord = config.comparator === 'gt' ? 'above' : 'below';

	return {
		triggered: true,
		message: `${config.metric} has stayed ${comparatorWord} ${config.threshold} for ${Math.round(durationMs / 60_000)} min (threshold: ${Math.round(config.sustainedForMs / 60_000)} min)`,
		dueBy: ctx.now,
		confidence: sample ? 1 : 0.5,
	};
}

/**
 * Standby waste: metric reading below standbyThreshold is considered idle
 * draw. If outsideScheduleOnly is set, only flags idle draw observed outside
 * the configured operating hours (idle draw *during* operating hours may be
 * a legitimate low-load state, not waste).
 */
export function evaluateStandbyWaste(config: StandbyWasteRuleConfig, ctx: EvaluatorContext): EvaluationOutcome {
	const sample = getLatestSample(ctx.buffer);
	if (!sample) return NOT_TRIGGERED;

	if (sample.value >= config.standbyThreshold) return NOT_TRIGGERED;

	if (config.outsideScheduleOnly && config.schedule) {
		const withinSchedule = isWithinSchedule(config.schedule, ctx.now);
		if (withinSchedule) return NOT_TRIGGERED; // idle during operating hours — not flagged in v1
	}

	return {
		triggered: true,
		message: `${config.metric} reading ${sample.value.toFixed(1)} is below the ${config.standbyThreshold} standby threshold`,
		estimatedImpact: null, // structured impact estimation is a v2 idea per the plan doc
		confidence: 1,
	};
}

/**
 * Schedule mismatch: compares the metric's actual on/off state (nonzero =
 * on) against whether the asset is expected to be running right now,
 * per expectedSchedule (with toleranceMinutes of slack around the
 * start/end boundaries to avoid flagging normal startup/shutdown lag).
 */
export function evaluateScheduleMismatch(config: ScheduleMismatchRuleConfig, ctx: EvaluatorContext): EvaluationOutcome {
	const sample = getLatestSample(ctx.buffer);
	if (!sample) return NOT_TRIGGERED;

	const expectedOn = isWithinSchedule(config.expectedSchedule, ctx.now, config.toleranceMinutes);
	const actualOn = sample.value !== 0;

	if (expectedOn === actualOn) return NOT_TRIGGERED;

	const state = actualOn ? 'running' : 'off';
	const expected = expectedOn ? 'running' : 'off';
	return {
		triggered: true,
		message: `${config.metric} is ${state}, but the schedule expects it to be ${expected} right now`,
		estimatedImpact: null,
		confidence: 1,
	};
}

/**
 * Duty cycle: the on/off ratio over the trailing windowMs falls outside
 * [expectedMinRatio, expectedMaxRatio]. Either bound is optional — an
 * unset bound is simply never violated on that side.
 */
export function evaluateDutyCycle(config: DutyCycleRuleConfig, ctx: EvaluatorContext): EvaluationOutcome {
	const ratio = onRatioWithinWindow(ctx.buffer, config.windowMs, ctx.now);
	if (ratio === null) return NOT_TRIGGERED;

	const belowMin = config.expectedMinRatio !== undefined && ratio < config.expectedMinRatio;
	const aboveMax = config.expectedMaxRatio !== undefined && ratio > config.expectedMaxRatio;
	if (!belowMin && !aboveMax) return NOT_TRIGGERED;

	const pct = (ratio * 100).toFixed(0);
	const direction = belowMin ? `below the expected minimum ${(config.expectedMinRatio! * 100).toFixed(0)}%` : `above the expected maximum ${(config.expectedMaxRatio! * 100).toFixed(0)}%`;

	return {
		triggered: true,
		message: `${config.metric} duty cycle is ${pct}%, ${direction} over the last ${Math.round(config.windowMs / 60_000)} min`,
		estimatedImpact: null,
		confidence: 1,
	};
}
