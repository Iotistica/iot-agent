export interface DailySchedule {
	start: string; // "HH:mm", 24h
	end: string;
	days: number[]; // 0=Sun .. 6=Sat
}

function minutesSinceMidnight(hhmm: string): number {
	const [h, m] = hhmm.split(':').map(Number);
	return h * 60 + m;
}

/**
 * Whether `timestamp` falls inside the given daily schedule, with an optional
 * tolerance window (minutes) extending both the start and end boundaries —
 * used by schedule_mismatch to avoid flagging normal startup/shutdown lag.
 *
 * Simplification for an overnight schedule (e.g. 22:00–06:00): `days` is
 * checked against the timestamp's own calendar day only, not "does the prior
 * day's occurrence carry into this morning." So `days: [1]` (Monday only)
 * matches both Monday 23:00 and Monday 02:00, even though the 02:00 instant
 * is technically the tail of Sunday night's occurrence, which wouldn't be
 * scheduled if Sunday isn't in `days`. Same-day schedules (the common case)
 * are unaffected; revisit only if overnight schedules on non-consecutive
 * days turn out to matter in practice.
 */
export function isWithinSchedule(schedule: DailySchedule, timestamp: number, toleranceMinutes = 0): boolean {
	const date = new Date(timestamp);
	const day = date.getDay();
	if (!schedule.days.includes(day)) return false;

	const minutesNow = date.getHours() * 60 + date.getMinutes();
	const start = minutesSinceMidnight(schedule.start) - toleranceMinutes;
	const end = minutesSinceMidnight(schedule.end) + toleranceMinutes;

	if (start <= end) {
		return minutesNow >= start && minutesNow <= end;
	}
	// Overnight schedule (e.g. 22:00–06:00)
	return minutesNow >= start || minutesNow <= end;
}
