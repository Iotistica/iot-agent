/**
 * Consecutive-hit-before-firing debounce, reused across every rule type
 * (per docs/preventive-maintenance-energy-plan.md decision #4 — same pattern
 * as anomaly_alerts.consecutive_count) rather than each evaluator
 * reimplementing it. Only ThresholdDurationRuleConfig exposes
 * consecutiveWindowsRequired as an admin-tunable knob; every other rule type
 * defaults to firing on its very first triggered tick (requiredHits = 1),
 * since a monotonic counter crossing (cumulative_runtime, cycle_count) or a
 * single bad reading (standby_waste, schedule_mismatch, duty_cycle) doesn't
 * need multi-tick agreement to be a real, actionable condition in v1.
 */
export class DebounceTracker {
	private consecutiveHits = new Map<string, number>();

	/** Records one tick's result for `key` and reports whether it has now hit `requiredHits` in a row. */
	recordAndShouldFire(key: string, triggered: boolean, requiredHits: number): boolean {
		if (!triggered) {
			this.consecutiveHits.delete(key);
			return false;
		}

		const count = (this.consecutiveHits.get(key) ?? 0) + 1;
		this.consecutiveHits.set(key, count);
		return count >= Math.max(1, requiredHits);
	}

	clear(key: string): void {
		this.consecutiveHits.delete(key);
	}
}
