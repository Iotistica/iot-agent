import type { QualityCheck } from '../types.js';
import { RULE_IDS } from '../rule-ids.js';
import type { CheckFn } from './types.js';

/**
 * Explicit supported-type contract matching DeviceDataPoint.value:
 * number | boolean | string | null. Rejects non-finite numbers and
 * unsupported types (object/array/function/symbol/bigint) without
 * incorrectly rejecting legitimate boolean or string-valued points.
 */
export const valueCheck: CheckFn = (reading): QualityCheck | undefined => {
	const value = reading.value;

	if (value === undefined) return undefined; // nothing to check, per the existing telemetry contract

	if (value === null) {
		return { status: 'passed' }; // an expected value-contract member; `source` independently flags BAD quality
	}

	const type = typeof value;

	if (type === 'number' && !Number.isFinite(value as number)) {
		return {
			status: 'failed',
			issues: [{ code: 'VALUE_INVALID', ruleId: RULE_IDS.VALUE_INVALID, dimension: 'value', severity: 'error', message: 'non-finite numeric value' }],
		};
	}

	if (type !== 'number' && type !== 'boolean' && type !== 'string') {
		return {
			status: 'failed',
			issues: [{ code: 'VALUE_INVALID', ruleId: RULE_IDS.VALUE_INVALID, dimension: 'value', severity: 'error', message: 'unsupported value type' }],
		};
	}

	if (reading.quality === 'UNCERTAIN') {
		return {
			status: 'warning',
			issues: [{ code: 'VALUE_UNCERTAIN', ruleId: RULE_IDS.VALUE_UNCERTAIN, dimension: 'value', severity: 'warning' }],
		};
	}

	return { status: 'passed' };
};
