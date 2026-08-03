import type { UnitValue } from '../../normalization/types.js';
import type { QualityCheck } from '../types.js';
import { RULE_IDS } from '../rule-ids.js';
import { assessUnitConfidence } from '../confidence-policy.js';
import type { CheckFn } from './types.js';

/**
 * Consumes reading.unitValue.provenance exactly as normalization emitted it
 * — never reconstructs alias-resolution logic. Confidence comes exclusively
 * from confidence-policy.ts's assessUnitConfidence(), not recomputed here.
 */
export const unitCheck: CheckFn = (reading): QualityCheck | undefined => {
	const unitValue = reading.unitValue as UnitValue | undefined;
	if (!unitValue) return undefined;

	const confidence = assessUnitConfidence(unitValue.provenance);

	if (unitValue.provenance.method === 'unresolved') {
		return {
			status: 'warning',
			confidence,
			issues: [{ code: 'UNIT_UNRESOLVED', ruleId: RULE_IDS.UNIT_UNRESOLVED, dimension: 'unit', severity: 'warning' }],
		};
	}

	return { status: 'passed', confidence };
};
