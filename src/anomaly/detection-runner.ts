import type { AgentLogger } from '../shared/types.js';
import { getDetector } from './detectors.js';
import { detectWithFusion } from './fusion.js';
import type {
	AnomalyAlert,
	DetectionMethod,
	DetectorBaseline,
	MetricConfig,
	StatisticalBuffer,
} from './types.js';

export interface RunDetectionMethodsInput {
	metric: string;
	value: number;
	buffer: StatisticalBuffer;
	metricConfig: MetricConfig;
	detectorBaseline?: DetectorBaseline;
	minConfidence: number;
	logger?: AgentLogger;
	createAlert: (method: DetectionMethod, baselineSource: 'buffer' | 'database' | undefined, confidence: number, deviation: number, expectedRange: [number, number], message: string) => AnomalyAlert;
}

export interface RunDetectionMethodsResult {
	methodsToRun: DetectionMethod[];
	alerts: AnomalyAlert[];
	maxConfidence: number;
}

export function getMethodsToRun(metricConfig: MetricConfig): DetectionMethod[] {
	const methodsToRun = [...metricConfig.methods];
	if (metricConfig.expectedRange && !methodsToRun.includes('expected_range')) {
		methodsToRun.unshift('expected_range');
	}
	return methodsToRun;
}

export function runDetectionMethods(input: RunDetectionMethodsInput): RunDetectionMethodsResult {
	const methodsToRun = getMethodsToRun(input.metricConfig);

	input.logger?.debugSync('Running detection methods', {
		component: 'Anomaly',
		metric: input.metric,
		value: input.value,
		methods: methodsToRun.join(','),
		hasDbBaseline: !!input.detectorBaseline,
		bufferSize: input.buffer.size,
	});

	// 'fusion' runs every registered detector internally and combines them into one
	// weighted verdict (see fusion.ts) — running it alongside individually-selected
	// methods would double-count the same underlying signals, so it takes over
	// entirely when selected rather than running as one more method in the loop.
	if (methodsToRun.includes('fusion')) {
		return runFusionDetection(input);
	}

	return runIndividualDetectors(input, methodsToRun);
}

function runFusionDetection(input: RunDetectionMethodsInput): RunDetectionMethodsResult {
	const alerts: AnomalyAlert[] = [];

	const result = detectWithFusion(
		input.value,
		input.buffer,
		input.metricConfig,
		input.detectorBaseline,
		input.metricConfig.fusion,
	);

	input.logger?.debugSync('Detector result: fusion', {
		component: 'Anomaly',
		metric: input.metric,
		isAnomaly: result.isAnomaly,
		confidence: result.confidence?.toFixed(3) ?? 'N/A',
		deviation: result.deviation?.toFixed(3) ?? 'N/A',
		expectedRange: `[${result.expectedRange?.[0]?.toFixed(2) ?? 'N/A'}, ${result.expectedRange?.[1]?.toFixed(2) ?? 'N/A'}]`,
		triggeredBy: result.triggeredBy?.join(',') ?? 'none',
		message: result.message,
	});

	if (result.isAnomaly && result.confidence >= input.minConfidence) {
		input.logger?.infoSync('Creating alert (confidence threshold met)', {
			component: 'Anomaly',
			metric: input.metric,
			method: 'fusion',
			confidence: result.confidence?.toFixed(3) ?? 'N/A',
			minConfidence: input.minConfidence?.toFixed(3) ?? 'N/A',
		});

		alerts.push(
			input.createAlert(
				'fusion',
				result.baselineSource,
				result.confidence,
				result.deviation,
				result.expectedRange,
				result.message,
			),
		);
	} else if (result.isAnomaly) {
		input.logger?.debugSync('Anomaly detected but confidence below threshold', {
			component: 'Anomaly',
			metric: input.metric,
			method: 'fusion',
			confidence: result.confidence?.toFixed(3) ?? 'N/A',
			minConfidence: input.minConfidence?.toFixed(3) ?? 'N/A',
		});
	}

	return {
		methodsToRun: ['fusion'],
		alerts,
		maxConfidence: result.confidence,
	};
}

function runIndividualDetectors(
	input: RunDetectionMethodsInput,
	methodsToRun: DetectionMethod[],
): RunDetectionMethodsResult {
	const alerts: AnomalyAlert[] = [];
	let maxConfidence = 0;

	for (const method of methodsToRun) {
		const detector = getDetector(method);
		if (!detector) {
			input.logger?.warnSync(`Unknown detection method: ${method}`, {
				component: 'Anomaly',
			});
			continue;
		}

		const result = detector.detect(
			input.value,
			input.buffer,
			input.metricConfig,
			input.detectorBaseline,
		);

		input.logger?.debugSync(`Detector result: ${method}`, {
			component: 'Anomaly',
			metric: input.metric,
			method,
			isAnomaly: result.isAnomaly,
			confidence: result.confidence?.toFixed(3) ?? 'N/A',
			deviation: result.deviation?.toFixed(3) ?? 'N/A',
			expectedRange: `[${result.expectedRange?.[0]?.toFixed(2) ?? 'N/A'}, ${result.expectedRange?.[1]?.toFixed(2) ?? 'N/A'}]`,
			baselineSource: result.baselineSource || 'N/A',
			message: result.message,
		});

		if (result.confidence > maxConfidence) {
			maxConfidence = result.confidence;
		}

		if (result.isAnomaly && result.confidence >= input.minConfidence) {
			input.logger?.infoSync('Creating alert (confidence threshold met)', {
				component: 'Anomaly',
				metric: input.metric,
				method,
				confidence: result.confidence?.toFixed(3) ?? 'N/A',
				minConfidence: input.minConfidence?.toFixed(3) ?? 'N/A',
			});

			alerts.push(
				input.createAlert(
					method,
					result.baselineSource,
					result.confidence,
					result.deviation,
					result.expectedRange,
					result.message,
				),
			);
		} else if (result.isAnomaly) {
			input.logger?.debugSync('Anomaly detected but confidence below threshold', {
				component: 'Anomaly',
				metric: input.metric,
				method,
				confidence: result.confidence?.toFixed(3) ?? 'N/A',
				minConfidence: input.minConfidence?.toFixed(3) ?? 'N/A',
			});
		}
	}

	return {
		methodsToRun,
		alerts,
		maxConfidence,
	};
}
