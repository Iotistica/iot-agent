import { getRecentValues, getTrend } from './buffer.js';
import type {
	AnomalyAlert,
	AnomalySeverity,
	BaselineInfo,
	CanonicalDeviceState,
	DataPoint,
	DetectionResult,
	MetricConfig,
	StatisticalBuffer,
} from './types.js';

function createId(): string {
	const now = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 12);
	return `${now}-${rand}`;
}

// rate_change's own trigger threshold, mirrored from detectors.ts (config.threshold
// defaults to this when a metric doesn't override it) — used below as the basis for
// its severity breakpoints, since its "deviation" is a percentage, not a z-score/MAD
// multiple, and can't share the fixed 3.0/5.0 bar used by the other methods.
const DEFAULT_RATE_CHANGE_THRESHOLD_PERCENT = 10.0;

export function calculateSeverity(
	confidence: number,
	deviation: number,
	method?: string,
	methodThreshold?: number,
): AnomalySeverity {
	if (method === 'mad') {
		if (confidence >= 0.7 || deviation >= 3.0) {
			return 'warning';
		}
		return 'info';
	}

	if (method === 'rate_change') {
		// deviation here is a percent change (e.g. 45 = 45%) — the fixed 3.0/5.0
		// breakpoints below assume z-score/MAD-multiple units, where single digits
		// are already extreme. Applying them to a percentage means almost any
		// qualifying rate-change event (already >= the detector's own trigger
		// threshold to fire at all) blows past them, leaving no real "warning"
		// tier. Scale relative to the metric's own configured threshold instead.
		const threshold = methodThreshold ?? DEFAULT_RATE_CHANGE_THRESHOLD_PERCENT;
		if (deviation >= threshold * 2) {
			return 'critical';
		}
		if (deviation >= threshold) {
			return 'warning';
		}
		return 'info';
	}

	if (method === 'cusum') {
		// deviation is the cumulative sum score, which routinely reaches 50-200+
		// for sustained drift. The decision interval h (default 5.0) is the
		// trigger threshold — scale severity relative to how far past h the
		// score has accumulated, not by the raw score.
		const h = Math.max(methodThreshold ?? 5.0, 5.0);
		if (deviation >= h * 3) {
			return 'critical';
		}
		if (deviation >= h * 1.5) {
			return 'warning';
		}
		return 'info';
	}

	if (confidence >= 0.85 || deviation >= 5.0) {
		return 'critical';
	}
	if (confidence >= 0.7 || deviation >= 3.0) {
		return 'warning';
	}
	return 'info';
}

export function generateSeverityReason(
	score: number,
	deviation: number,
	severity: AnomalySeverity,
	method?: string,
	methodThreshold?: number,
): string {
	if (method === 'rate_change') {
		const threshold = methodThreshold ?? DEFAULT_RATE_CHANGE_THRESHOLD_PERCENT;
		return `${severity}: rate_change ${deviation.toFixed(1)}% (threshold ${threshold}%, critical at ${(threshold * 2).toFixed(1)}%)`;
	}

	if (method === 'cusum') {
		const h = Math.max(methodThreshold ?? 5.0, 5.0);
		return `${severity}: cusum score ${deviation.toFixed(1)} (threshold ${h}, warning at ${(h * 1.5).toFixed(1)}, critical at ${(h * 3).toFixed(1)})`;
	}

	const reasons: string[] = [];

	if (score >= 0.85) {
		reasons.push('score>=0.85');
	} else if (score >= 0.7) {
		reasons.push('score>=0.7');
	}

	if (deviation >= 5.0) {
		reasons.push('deviation>=5.0');
	} else if (deviation >= 3.0) {
		reasons.push('deviation>=3.0');
	}

	if (reasons.length === 0) {
		reasons.push('score<0.7');
	}

	return `${severity}: ${reasons.join(' || ')}`;
}

export function calculateConfidence(
	anomalyScore: number,
	baseline: BaselineInfo,
): number {
	let confidence = anomalyScore;

	if (baseline.sampleCount < 30) {
		const samplePenalty = baseline.sampleCount / 30;
		confidence *= (0.7 + 0.3 * samplePenalty);
	}

	if (baseline.source === 'database') {
		confidence = Math.min(1.0, confidence * 1.05);
	}

	if (baseline.stdDev > baseline.mean * 0.5) {
		confidence *= 0.9;
	}

	return Math.min(1.0, Math.max(0.0, confidence));
}

export function createAnomalyAlert(
	dataPoint: DataPoint,
	buffer: StatisticalBuffer,
	metricConfig: MetricConfig,
	result: DetectionResult,
	deviceState: CanonicalDeviceState,
): AnomalyAlert {
	const severity = calculateSeverity(result.confidence, result.deviation, result.method, result.effectiveThreshold ?? metricConfig.threshold);

	return {
		id: createId(),
		severity,
		deviceState,
		metric: dataPoint.metric,
		value: dataPoint.value,
		expectedRange: result.expectedRange,
		deviation: result.deviation,
		detectionMethod: result.method,
		timestamp: dataPoint.timestamp,
		confidence: result.confidence,
		context: {
			recent_values: getRecentValues(buffer, 10),
			baseline: buffer.mean,
			trend: getTrend(buffer),
			windowSize: buffer.size,
		},
		message: `${result.message} (state: ${deviceState})`,
		fingerprint: '',
		count: 1,
		cooldownSec: Math.floor((metricConfig.cooldownMs || 30000) / 1000),
		firstSeen: dataPoint.timestamp,
		consecutiveCount: 1,
	};
}
