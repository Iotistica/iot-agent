/**
 * Tests the compact quality/unit projection added to mapTagPayload()/
 * attachMlEnrichment() this session. These are pure given a message (they
 * only call sibling pure methods — inferEcpType/inferMlDtype/
 * readNormalizedUnit/readQualityFields — no constructor-initialized state),
 * so they're exercised directly off the prototype rather than constructing a
 * full PublishManager (SocketConnection/MessageBatcher/etc. — heavy, and no
 * existing manager.ts test suite establishes a lighter convention yet).
 */
import { PublishManager } from '../../../src/publish/core/manager';

function makeInstance(): any {
	return Object.create(PublishManager.prototype);
}

const dataQuality = {
	checks: {
		source: { status: 'passed' },
		unit: { status: 'warning', confidence: 0, issues: [{ code: 'UNIT_UNRESOLVED', ruleId: 'DQ-UNIT-001', dimension: 'unit', severity: 'warning' }] },
		value: { status: 'passed' },
	},
	status: 'degraded',
	evaluatedAt: '2026-01-01T00:00:00.000Z',
	rulesVersion: 'dq-rules-v1',
	engineVersion: '1.0.0',
};

const message = {
	metric: 'temp', value: 21.5, quality: 'GOOD',
	unitValue: { rawValue: 21.5, rawUnit: '°C', value: 21.5, unit: 'wibbles', normalized: false, converted: false, provenance: { method: 'unresolved' } },
	unit: 'wibbles',
	dataQuality,
};

describe('mapTagPayload() compact quality projection', () => {
	it('"tags"/"ecp" payloads carry only dqStatus/dqUnitConfidence/dqIssueCodes, never checks/ruleId/protocolCode/message/rulesVersion/engineVersion', () => {
		const instance = makeInstance();
		const tag = instance.mapTagPayload(message, 0, 'tags', false);

		expect(tag.dqStatus).toBe('degraded');
		expect(tag.dqUnitConfidence).toBe(0);
		expect(tag.dqIssueCodes).toEqual(['UNIT_UNRESOLVED']);

		expect(tag.checks).toBeUndefined();
		expect(tag.ruleId).toBeUndefined();
		expect(tag.protocolCode).toBeUndefined();
		expect(tag.rulesVersion).toBeUndefined();
		expect(tag.engineVersion).toBeUndefined();
	});

	it('omits dqUnitConfidence when the unit check produced no confidence', () => {
		const instance = makeInstance();
		const noUnitCheck = { ...message, dataQuality: { ...dataQuality, checks: { source: { status: 'passed' } }, status: 'good' } };
		const tag = instance.mapTagPayload(noUnitCheck, 0, 'tags', false);

		expect(tag.dqStatus).toBe('good');
		expect(tag.dqUnitConfidence).toBeUndefined();
		expect(tag.dqIssueCodes).toBeUndefined();
	});

	it('omits all dq* fields when the message has no dataQuality (interceptor never ran / threw)', () => {
		const instance = makeInstance();
		const { dataQuality: _omit, ...noQuality } = message;
		const tag = instance.mapTagPayload(noQuality, 0, 'tags', false);

		expect(tag.dqStatus).toBeUndefined();
		expect(tag.dqUnitConfidence).toBeUndefined();
		expect(tag.dqIssueCodes).toBeUndefined();
	});
});

describe('attachMlEnrichment() compact quality projection', () => {
	it('"ml" feature payloads carry only dqStatus/dqUnitConfidence/dqIssueCodes', () => {
		const instance = makeInstance();
		const feature: any = { name: 'temp', value: 21.5, dtype: 'float', quality: 'GOOD' };
		instance.attachMlEnrichment(feature, message);

		expect(feature.dqStatus).toBe('degraded');
		expect(feature.dqUnitConfidence).toBe(0);
		expect(feature.dqIssueCodes).toEqual(['UNIT_UNRESOLVED']);
		expect(feature.checks).toBeUndefined();
		expect(feature.rulesVersion).toBeUndefined();
		expect(feature.engineVersion).toBeUndefined();
	});
});
