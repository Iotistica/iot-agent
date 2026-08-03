import { assessUnitConfidence } from '../../../src/quality/confidence-policy';

// The only tests in the codebase that assert these numbers — normalization
// tests must never duplicate this assertion (normalization emits facts only).
describe('assessUnitConfidence', () => {
	it('exact-canonical -> 1.00', () => {
		expect(assessUnitConfidence({ method: 'exact-canonical' })).toBe(1.00);
	});

	it('scoped-alias -> 0.95', () => {
		expect(assessUnitConfidence({ method: 'scoped-alias', sourceSystem: 'bacnet' })).toBe(0.95);
	});

	it('global-alias -> 0.85', () => {
		expect(assessUnitConfidence({ method: 'global-alias', sourceSystem: null })).toBe(0.85);
	});

	it('unresolved -> 0.00', () => {
		expect(assessUnitConfidence({ method: 'unresolved' })).toBe(0.00);
	});
});
