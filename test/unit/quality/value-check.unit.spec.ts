import { valueCheck } from '../../../src/quality/checks/value-check';

describe('valueCheck', () => {
	it('value undefined (key absent) -> omit', () => {
		expect(valueCheck({ metric: 'x' })).toBeUndefined();
	});

	it('value null -> passed (expected member of the value contract)', () => {
		expect(valueCheck({ value: null })).toEqual({ status: 'passed' });
	});

	it('non-finite number -> failed, VALUE_INVALID, DQ-VALUE-001', () => {
		for (const bad of [NaN, Infinity, -Infinity]) {
			const result = valueCheck({ value: bad });
			expect(result?.status).toBe('failed');
			expect(result?.issues?.[0]).toMatchObject({ code: 'VALUE_INVALID', ruleId: 'DQ-VALUE-001', dimension: 'value', severity: 'error' });
		}
	});

	it('finite number -> passed', () => {
		expect(valueCheck({ value: 21.5 })).toEqual({ status: 'passed' });
	});

	it('boolean is never rejected on type grounds', () => {
		expect(valueCheck({ value: true })).toEqual({ status: 'passed' });
		expect(valueCheck({ value: false })).toEqual({ status: 'passed' });
	});

	it('string is never rejected on type grounds', () => {
		expect(valueCheck({ value: 'open' })).toEqual({ status: 'passed' });
	});

	it('object/array/function/symbol/bigint -> failed, VALUE_INVALID (unsupported type)', () => {
		const unsupported: unknown[] = [{ nested: true }, [1, 2, 3], () => {}, Symbol('x'), BigInt(1)];
		for (const value of unsupported) {
			const result = valueCheck({ value });
			expect(result?.status).toBe('failed');
			expect(result?.issues?.[0]).toMatchObject({ code: 'VALUE_INVALID', ruleId: 'DQ-VALUE-001', dimension: 'value', severity: 'error' });
		}
	});

	it('quality UNCERTAIN after type validation -> warning, VALUE_UNCERTAIN, DQ-VALUE-002', () => {
		const result = valueCheck({ value: 21.5, quality: 'UNCERTAIN' });
		expect(result?.status).toBe('warning');
		expect(result?.issues).toEqual([{ code: 'VALUE_UNCERTAIN', ruleId: 'DQ-VALUE-002', dimension: 'value', severity: 'warning' }]);
	});

	it('does not mutate the input reading (purity contract)', () => {
		const reading = Object.freeze({ value: 21.5, quality: 'GOOD' });
		expect(() => valueCheck(reading)).not.toThrow();
	});
});
