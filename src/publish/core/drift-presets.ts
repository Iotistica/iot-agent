import type { DriftOptions } from './types.js';

export type SensitivityLevel = 'low' | 'standard' | 'high';

type DriftOptionsInner = NonNullable<DriftOptions>;

export type SensitivityFields = Required<Pick<DriftOptionsInner,
	'consecutiveMissingThreshold' | 'minFieldPresenceRatio' |
	'adaptivePromotionBatches' | 'adaptivePromotionMinElapsedMs' |
	'minTypeDominanceRatio'
>>;

export const SENSITIVITY_PRESETS: Record<SensitivityLevel, SensitivityFields> = {
	low: {
		consecutiveMissingThreshold: 30,
		minFieldPresenceRatio: 0.2,
		adaptivePromotionBatches: 20,
		adaptivePromotionMinElapsedMs: 300_000,
		minTypeDominanceRatio: 0.1,
	},
	standard: {
		consecutiveMissingThreshold: 10,
		minFieldPresenceRatio: 0.5,
		adaptivePromotionBatches: 50,
		adaptivePromotionMinElapsedMs: 600_000,
		minTypeDominanceRatio: 0.15,
	},
	high: {
		consecutiveMissingThreshold: 3,
		minFieldPresenceRatio: 0.8,
		adaptivePromotionBatches: 100,
		adaptivePromotionMinElapsedMs: 1_800_000,
		minTypeDominanceRatio: 0.25,
	},
};

const SENSITIVITY_LEVELS: SensitivityLevel[] = ['low', 'standard', 'high'];

export const ADVANCED_DRIFT_DEFAULTS: Partial<DriftOptionsInner> = {
	warmupBatches: 20,
	adaptiveRetireBatches: 250,
	adaptiveRetireMs: 86_400_000,
	maxTrackedFields: 1000,
	maxTrackedDevices: 2000,
	maxFieldsPerBatch: 500,
	maxTraversalDepth: 5,
	maxRenameCandidates: 20,
	maxRenameFieldLength: 64,
	logSampleSize: 10,
	checkIntervalBatches: 1,
};

export function classifySensitivity(opts: DriftOptionsInner | null | undefined): SensitivityLevel | 'custom' {
	for (const level of SENSITIVITY_LEVELS) {
		const preset = SENSITIVITY_PRESETS[level];
		const matches = (Object.keys(preset) as Array<keyof SensitivityFields>).every(
			(key) => ((opts as any)?.[key] ?? SENSITIVITY_PRESETS.standard[key]) === preset[key],
		);
		if (matches) return level;
	}
	return 'custom';
}
