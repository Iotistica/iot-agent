import type { StatisticalBuffer } from '../anomaly/types.js';

// ── Rule configs (v1) — typed shapes, not free-form JSON logic. Mirrors
// docs/preventive-maintenance-energy-plan.md "Rule types (v1)" in iot-agent. ──

export interface WindowGating {
	metric: string;
	min?: number;
	max?: number;
}

export interface CumulativeRuntimeRuleConfig {
	metric: string; // e.g. "runtime_hours" — a monotonically increasing counter
	thresholdHours: number;
	windowGating?: WindowGating;
}

export interface CycleCountRuleConfig {
	metric: string; // e.g. "start_stop_count"
	thresholdCycles: number;
}

export interface ThresholdDurationRuleConfig {
	metric: string; // e.g. "vibration_rms"
	threshold: number;
	comparator: 'gt' | 'lt';
	sustainedForMs: number;
	consecutiveWindowsRequired: number;
	windowGating?: WindowGating;
}

export type MaintenanceRuleConfig = CumulativeRuntimeRuleConfig | CycleCountRuleConfig | ThresholdDurationRuleConfig;

export interface StandbyWasteRuleConfig {
	metric: string; // e.g. "power_draw_w"
	standbyThreshold: number;
	outsideScheduleOnly: boolean;
	schedule?: { start: string; end: string; days: number[] }; // 24h "HH:mm", 0=Sun
}

export interface ScheduleMismatchRuleConfig {
	metric: string; // e.g. "occupancy" or "run_state"
	expectedSchedule: { start: string; end: string; days: number[] };
	toleranceMinutes: number;
}

export interface DutyCycleRuleConfig {
	metric: string; // on/off signal (nonzero = on)
	windowMs: number;
	expectedMinRatio?: number;
	expectedMaxRatio?: number;
}

export type EnergyRuleConfig = StandbyWasteRuleConfig | ScheduleMismatchRuleConfig | DutyCycleRuleConfig;

// ── Evaluator I/O ──────────────────────────────────────────────────────────

/** Everything an evaluator needs, decoupled from DB/service plumbing so each evaluator is a pure function. */
export interface EvaluatorContext {
	now: number; // epoch ms — injected, never Date.now() inside an evaluator, for testability
	buffer: StatisticalBuffer; // rolling buffer for the rule's primary metric
	gatingBuffer?: StatisticalBuffer; // rolling buffer for windowGating.metric, if configured and fed
	asset: {
		ratedLifeHours: number | null;
		ratedCycles: number | null;
		lastServiceDate: number | null;
	};
}

export interface EvaluationOutcome {
	/** Whether the rule's condition currently holds (before any consecutive-hit debounce is applied). */
	triggered: boolean;
	message: string;
	/** Maintenance only — epoch ms estimate of when service becomes due, if computable. */
	dueBy?: number | null;
	/** Energy only — free-text estimate for v1 (e.g. "~4.2 kWh/day"). */
	estimatedImpact?: string | null;
	/** 0–1. Threshold-crossing rules are binary (1.0); duration/ratio rules can reflect margin. */
	confidence: number;
}

export const NOT_TRIGGERED: EvaluationOutcome = { triggered: false, message: '', confidence: 0 };
