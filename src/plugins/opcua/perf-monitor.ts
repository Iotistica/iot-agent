import { monitorEventLoopDelay, type IntervalHistogram, performance } from 'node:perf_hooks';
import type { Logger } from '../types.js';

const REPORT_INTERVAL_MS = 30_000;
const HISTOGRAM_RESOLUTION_MS = 20;
const NS_PER_MS = 1e6;
const MAX_BATCH_DURATIONS = 1000;

export interface EndpointCounters {
	received: number;
	emitted: number;
	batches: number;
	batchDurations: number[];
}

export class OpcuaPerfMonitor {
	private readonly endpoints = new Map<string, EndpointCounters>();
	private reportTimer: ReturnType<typeof setInterval> | undefined;
	private histogram: IntervalHistogram | undefined;
	private previousELU = performance.eventLoopUtilization();
	private started = false;

	constructor(private readonly logger: Logger) {}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.histogram = monitorEventLoopDelay({ resolution: HISTOGRAM_RESOLUTION_MS });
		this.histogram.enable();
		this.previousELU = performance.eventLoopUtilization();
		this.reportTimer = setInterval(() => this.report(), REPORT_INTERVAL_MS);
		this.reportTimer.unref();
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		if (this.reportTimer) {
			clearInterval(this.reportTimer);
			this.reportTimer = undefined;
		}
		if (this.histogram) {
			this.histogram.disable();
			this.histogram = undefined;
		}
		this.endpoints.clear();
	}

	recordReceived(endpoint: string, count: number): void {
		this.counters(endpoint).received += count;
	}

	recordEmitted(endpoint: string, count: number): void {
		this.counters(endpoint).emitted += count;
	}

	recordBatchDuration(endpoint: string, durationMs: number): void {
		const c = this.counters(endpoint);
		c.batches++;
		if (c.batchDurations.length < MAX_BATCH_DURATIONS) {
			c.batchDurations.push(durationMs);
		} else {
			c.batchDurations[c.batches % MAX_BATCH_DURATIONS] = durationMs;
		}
	}

	private counters(endpoint: string): EndpointCounters {
		let c = this.endpoints.get(endpoint);
		if (!c) {
			c = { received: 0, emitted: 0, batches: 0, batchDurations: [] };
			this.endpoints.set(endpoint, c);
		}
		return c;
	}

	private report(): void {
		const elapsedS = REPORT_INTERVAL_MS / 1000;

		for (const [name, c] of this.endpoints) {
			if (c.received === 0 && c.emitted === 0 && c.batches === 0) continue;

			const stats = batchStats(c.batchDurations);
			this.logger.info(
				`[perf] opcua endpoint=${name} received=${rate(c.received, elapsedS)}/s` +
				` emitted=${rate(c.emitted, elapsedS)}/s batches=${c.batches}` +
				` p95=${stats.p95}ms p99=${stats.p99}ms max=${stats.max}ms`,
			);

			c.received = 0;
			c.emitted = 0;
			c.batches = 0;
			c.batchDurations.length = 0;
		}

		const h = this.histogram;
		const currentELU = performance.eventLoopUtilization();
		const delta = performance.eventLoopUtilization(currentELU, this.previousELU);
		this.previousELU = currentELU;

		const utilPct = isFinite(delta.utilization) ? Math.round(delta.utilization * 100) : 0;
		const meanMs = h && h.mean > 0 && isFinite(h.mean) ? Math.round(h.mean / NS_PER_MS) : 0;
		const p95Ms = h && h.min > 0 ? Math.round(h.percentile(95) / NS_PER_MS) : 0;
		const p99Ms = h && h.min > 0 ? Math.round(h.percentile(99) / NS_PER_MS) : 0;
		const maxMs = h && h.max > 0 && isFinite(h.max) ? Math.round(h.max / NS_PER_MS) : 0;

		this.logger.info(
			`[perf] event-loop utilization=${utilPct}%` +
			` delay_mean=${meanMs}ms delay_p95=${p95Ms}ms delay_p99=${p99Ms}ms delay_max=${maxMs}ms`,
		);

		h?.reset();
	}
}

function rate(count: number, seconds: number): number {
	return seconds > 0 ? Math.round(count / seconds) : 0;
}

function batchStats(durations: number[]): { p95: number; p99: number; max: number } {
	if (durations.length === 0) return { p95: 0, p99: 0, max: 0 };
	const sorted = durations.slice().sort((a, b) => a - b);
	return {
		p95: Math.round(sorted[Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1)]),
		p99: Math.round(sorted[Math.min(Math.ceil(sorted.length * 0.99) - 1, sorted.length - 1)]),
		max: Math.round(sorted[sorted.length - 1]),
	};
}
