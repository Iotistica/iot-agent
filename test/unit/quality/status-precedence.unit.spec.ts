import { deriveOverallStatus } from '../../../src/quality/status-precedence';
import type { QualityCheck } from '../../../src/quality/types';

const check = (status: QualityCheck['status']): QualityCheck => ({ status });

describe('deriveOverallStatus', () => {
	it('any failed -> bad, regardless of other statuses present', () => {
		expect(deriveOverallStatus([check('passed'), check('warning'), check('failed')])).toBe('bad');
	});

	it('warning without failed -> degraded', () => {
		expect(deriveOverallStatus([check('passed'), check('warning')])).toBe('degraded');
	});

	it('unknown without warning/failed -> unknown', () => {
		expect(deriveOverallStatus([check('passed'), check('unknown')])).toBe('unknown');
	});

	it('all passed -> good', () => {
		expect(deriveOverallStatus([check('passed'), check('passed')])).toBe('good');
	});

	it('no checks -> status omitted (undefined)', () => {
		expect(deriveOverallStatus([])).toBeUndefined();
	});

	it('single failed check -> bad', () => {
		expect(deriveOverallStatus([check('failed')])).toBe('bad');
	});
});
