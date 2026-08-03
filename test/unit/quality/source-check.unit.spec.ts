import { sourceCheck } from '../../../src/quality/checks/source-check';

describe('sourceCheck', () => {
	it('omits the check when no quality/qualityCode/error fields are present', () => {
		expect(sourceCheck({ metric: 'x', value: 5 })).toBeUndefined();
	});

	it('quality GOOD -> passed', () => {
		expect(sourceCheck({ quality: 'GOOD' })).toEqual({ status: 'passed' });
	});

	it('quality UNCERTAIN -> warning, SOURCE_UNCERTAIN, DQ-SOURCE-002', () => {
		const result = sourceCheck({ quality: 'UNCERTAIN' });
		expect(result?.status).toBe('warning');
		expect(result?.issues).toEqual([{ code: 'SOURCE_UNCERTAIN', ruleId: 'DQ-SOURCE-002', dimension: 'source', severity: 'warning' }]);
	});

	it('quality BAD -> failed, SOURCE_BAD, DQ-SOURCE-001, protocolCode/message preserved separately from code', () => {
		const result = sourceCheck({ quality: 'BAD', qualityCode: 'ILLEGAL_FUNCTION', error: 'Modbus exception 1' });
		expect(result?.status).toBe('failed');
		expect(result?.issues).toEqual([{
			code: 'SOURCE_BAD', ruleId: 'DQ-SOURCE-001', dimension: 'source', severity: 'error',
			protocolCode: 'ILLEGAL_FUNCTION', message: 'Modbus exception 1',
		}]);
	});

	it('does not mutate the input reading (purity contract)', () => {
		const reading = Object.freeze({ quality: 'BAD', qualityCode: 'TIMEOUT', error: 'timed out' });
		expect(() => sourceCheck(reading)).not.toThrow();
	});
});
