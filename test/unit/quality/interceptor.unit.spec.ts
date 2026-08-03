import { createDataQualityInterceptor, buildCompactIssueCodes } from '../../../src/quality/interceptor';
import type { DataQuality } from '../../../src/quality/types';

describe('dataQualityInterceptor', () => {
	const interceptor = createDataQualityInterceptor();

	it('evaluates a flat-shape reading and attaches dataQuality', () => {
		const messages = [{ quality: 'GOOD', value: 21.5, unitValue: { rawValue: 21.5, rawUnit: '°C', value: 21.5, unit: 'degreesCelsius', normalized: true, converted: false, provenance: { method: 'exact-canonical' } } }];
		const result = interceptor(messages, 'endpoint-1') as any[];

		expect(result).toBe(messages); // same array reference
		const dq: DataQuality = result[0].dataQuality;
		expect(dq.status).toBe('good');
		expect(dq.checks.source?.status).toBe('passed');
		expect(dq.checks.unit).toEqual({ status: 'passed', confidence: 1.0 });
		expect(dq.checks.value?.status).toBe('passed');
		expect(dq.rulesVersion).toBe('dq-rules-v1');
		expect(dq.engineVersion).toBe('1.0.0');
	});

	it('evaluates every reading inside a {readings: [...]} wrapper message', () => {
		const messages = [{
			readings: [
				{ quality: 'GOOD', value: 1 },
				{ quality: 'BAD', value: null, qualityCode: 'TIMEOUT' },
			],
		}];
		const result = interceptor(messages, 'endpoint-1') as any[];

		expect(result[0].readings[0].dataQuality.status).toBe('good');
		expect(result[0].readings[1].dataQuality.status).toBe('bad');
	});

	it('handles a mixed array of flat and wrapper messages', () => {
		const messages = [
			{ quality: 'GOOD', value: 1 },
			{ readings: [{ quality: 'GOOD', value: 2 }] },
		];
		const result = interceptor(messages, 'endpoint-1') as any[];

		expect(result[0].dataQuality.status).toBe('good');
		expect(result[1].readings[0].dataQuality.status).toBe('good');
	});

	it('an unresolved unit produces an overall degraded status without being dropped from the batch', () => {
		const messages = [{ quality: 'GOOD', value: 21.5, unitValue: { rawValue: 21.5, rawUnit: 'wibbles', value: 21.5, unit: 'wibbles', normalized: false, converted: false, provenance: { method: 'unresolved' } } }];
		const result = interceptor(messages, 'endpoint-1') as any[];

		expect(result).toHaveLength(1);
		expect(result[0].dataQuality.status).toBe('degraded');
		expect(result[0].dataQuality.checks.unit).toEqual({
			status: 'warning', confidence: 0,
			issues: [{ code: 'UNIT_UNRESOLVED', ruleId: 'DQ-UNIT-001', dimension: 'unit', severity: 'warning' }],
		});
	});

	it('a malformed (non-extensible) reading is skipped without affecting other readings in the same batch', () => {
		const goodReading = { quality: 'GOOD', value: 1 };
		const malformedReading = Object.freeze({ quality: 'GOOD', value: 2 }); // assigning .dataQuality throws in strict mode
		const messages = [{ readings: [malformedReading, goodReading] }];

		expect(() => interceptor(messages, 'endpoint-1')).not.toThrow();
		expect((goodReading as any).dataQuality.status).toBe('good');
		expect((malformedReading as any).dataQuality).toBeUndefined();
	});

	it('a throwing check produces QUALITY_CHECK_ERROR/DQ-ENGINE-001 on only its own dimension, siblings unaffected', () => {
		jest.resetModules();
		jest.doMock('../../../src/quality/checks/unit-check', () => ({
			unitCheck: () => { throw new Error('boom'); },
		}));

		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { createDataQualityInterceptor: createIsolated } = require('../../../src/quality/interceptor');
		const isolatedInterceptor = createIsolated();

		const messages = [{ quality: 'GOOD', value: 1 }];
		const result = isolatedInterceptor(messages, 'endpoint-1') as any[];

		const dq: DataQuality = result[0].dataQuality;
		expect(dq.checks.source?.status).toBe('passed'); // sibling unaffected
		expect(dq.checks.value?.status).toBe('passed');  // sibling unaffected
		expect(dq.checks.unit).toEqual({
			status: 'unknown',
			issues: [{ code: 'QUALITY_CHECK_ERROR', ruleId: 'DQ-ENGINE-001', dimension: 'unit', severity: 'error', message: 'boom' }],
		});

		jest.dontMock('../../../src/quality/checks/unit-check');
		jest.resetModules();
	});
});

describe('buildCompactIssueCodes', () => {
	it('flattens issue codes in canonical source -> unit -> value order, deduplicated', () => {
		const checks: DataQuality['checks'] = {
			value: { status: 'warning', issues: [{ code: 'VALUE_UNCERTAIN', ruleId: 'DQ-VALUE-002', dimension: 'value', severity: 'warning' }] },
			source: { status: 'warning', issues: [{ code: 'SOURCE_UNCERTAIN', ruleId: 'DQ-SOURCE-002', dimension: 'source', severity: 'warning' }] },
			unit: {
				status: 'warning',
				issues: [
					{ code: 'UNIT_UNRESOLVED', ruleId: 'DQ-UNIT-001', dimension: 'unit', severity: 'warning' },
					{ code: 'UNIT_UNRESOLVED', ruleId: 'DQ-UNIT-001', dimension: 'unit', severity: 'warning' }, // duplicate
				],
			},
		};
		expect(buildCompactIssueCodes(checks)).toEqual(['SOURCE_UNCERTAIN', 'UNIT_UNRESOLVED', 'VALUE_UNCERTAIN']);
	});

	it('returns undefined when no checks have issues', () => {
		expect(buildCompactIssueCodes({ source: { status: 'passed' } })).toBeUndefined();
	});
});
