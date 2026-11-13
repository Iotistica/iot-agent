import type { StatisticalBuffer } from '../analytics/anomaly/types.js';

export interface Sample {
	value: number;
	timestamp: number;
}

/** Most recent (value, timestamp) pair in the buffer, or null if empty. */
export function getLatestSample(buffer: StatisticalBuffer): Sample | null {
	if (buffer.size === 0) return null;
	const index = (buffer.head - 1 + buffer.maxSize) % buffer.maxSize;
	return { value: buffer.values[index], timestamp: buffer.timestamps[index] };
}

/**
 * How long (ms) the buffer's value has continuously satisfied `comparator`
 * against `threshold`, walking backward from the most recent sample. Returns
 * 0 if the latest sample doesn't currently satisfy the condition.
 */
export function continuousDurationMs(buffer: StatisticalBuffer, threshold: number, comparator: 'gt' | 'lt'): number {
	if (buffer.size === 0) return 0;

	const holds = (v: number) => (comparator === 'gt' ? v > threshold : v < threshold);
	const latestIndex = (buffer.head - 1 + buffer.maxSize) % buffer.maxSize;

	if (!holds(buffer.values[latestIndex])) return 0;

	let earliestHoldingIndex = latestIndex;
	for (let i = 1; i < buffer.size; i++) {
		const index = (buffer.head - 1 - i + buffer.maxSize) % buffer.maxSize;
		if (!holds(buffer.values[index])) break;
		earliestHoldingIndex = index;
	}

	return buffer.timestamps[latestIndex] - buffer.timestamps[earliestHoldingIndex];
}

/**
 * Fraction of time (0–1) the buffer's value was "on" (nonzero) within the
 * last `windowMs` before `now`. Treats each sample as holding its value
 * until the next sample (step function) — an approximation, adequate for
 * v1 duty-cycle rules where samples arrive at a roughly regular interval.
 */
export function onRatioWithinWindow(buffer: StatisticalBuffer, windowMs: number, now: number): number | null {
	if (buffer.size === 0) return null;

	const windowStart = now - windowMs;
	const samples: Sample[] = [];
	for (let i = 0; i < buffer.size; i++) {
		const index = (buffer.head - 1 - i + buffer.maxSize) % buffer.maxSize;
		const timestamp = buffer.timestamps[index];
		if (timestamp < windowStart) break;
		samples.unshift({ value: buffer.values[index], timestamp });
	}

	if (samples.length === 0) return null;

	let onMs = 0;
	let totalMs = 0;
	for (let i = 0; i < samples.length; i++) {
		const segmentStart = Math.max(samples[i].timestamp, windowStart);
		const segmentEnd = i + 1 < samples.length ? samples[i + 1].timestamp : now;
		const durationMs = Math.max(0, segmentEnd - segmentStart);
		totalMs += durationMs;
		if (samples[i].value !== 0) onMs += durationMs;
	}

	return totalMs > 0 ? onMs / totalMs : null;
}
