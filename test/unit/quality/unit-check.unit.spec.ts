import { unitCheck } from '../../../src/quality/checks/unit-check';
import { assessUnitConfidence } from '../../../src/quality/confidence-policy';
import type { UnitProvenance } from '../../../src/normalization/types';

function readingWith(provenance: UnitProvenance) {
	return { unitValue: { rawValue: 1, rawUnit: 'x', value: 1, unit: 'degreesCelsius', normalized: provenance.method !== 'unresolved', converted: false, provenance } };
}

describe('unitCheck', () => {
	it('omits the check when no unitValue is present', () => {
		expect(unitCheck({ metric: 'x', value: 5 })).toBeUndefined();
	});

	it('exact-canonical -> passed, confidence sourced from the policy module (not recomputed)', () => {
		const provenance: UnitProvenance = { method: 'exact-canonical' };
		expect(unitCheck(readingWith(provenance))).toEqual({ status: 'passed', confidence: assessUnitConfidence(provenance) });
	});

	it('scoped-alias -> passed, confidence 0.95', () => {
		const provenance: UnitProvenance = { method: 'scoped-alias', sourceSystem: 'bacnet' };
		expect(unitCheck(readingWith(provenance))).toEqual({ status: 'passed', confidence: 0.95 });
	});

	it('global-alias -> passed, confidence 0.85', () => {
		const provenance: UnitProvenance = { method: 'global-alias', sourceSystem: null };
		expect(unitCheck(readingWith(provenance))).toEqual({ status: 'passed', confidence: 0.85 });
	});

	it('unresolved -> warning (not failed), confidence 0, UNIT_UNRESOLVED, DQ-UNIT-001', () => {
		const provenance: UnitProvenance = { method: 'unresolved' };
		const result = unitCheck(readingWith(provenance));
		expect(result?.status).toBe('warning');
		expect(result?.confidence).toBe(0);
		expect(result?.issues).toEqual([{ code: 'UNIT_UNRESOLVED', ruleId: 'DQ-UNIT-001', dimension: 'unit', severity: 'warning' }]);
	});

	it('does not mutate the input reading (purity contract)', () => {
		const reading = Object.freeze(readingWith({ method: 'exact-canonical' }));
		expect(() => unitCheck(reading)).not.toThrow();
	});
});
