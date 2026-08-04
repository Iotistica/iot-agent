/**
 * Tests the compact point-identity projection added to mapTagPayload()/
 * attachMlEnrichment() — mirrors build-payload-quality.unit.spec.ts's approach
 * of exercising these pure sibling methods directly off the prototype rather
 * than constructing a full PublishManager.
 */
import { PublishManager } from '../../../src/publish/core/manager';

function makeInstance(): any {
	return Object.create(PublishManager.prototype);
}

const pointIdentity = {
	provisionalPointId: '11111111-2222-5333-8444-555555555555',
	normalizedName: 'ahu_1_sat',
	rawName: 'AHU-1 SAT',
	rawDeviceName: 'AHU-1',
	sourceAddress: undefined,
	rulesVersion: 'pn-rules-v1',
	provenance: {
		method: 'algorithmic',
		resolutionSource: 'runtime-generated',
		persistenceState: 'pending',
		sourceFields: ['metric'],
		sourceSystem: 'bacnet',
	},
};

const message = {
	metric: 'AHU-1 SAT',
	value: 21.5,
	quality: 'GOOD',
	pointIdentity,
};

describe('mapTagPayload() compact point-identity projection', () => {
	it('"tags"/"ecp" payloads carry only provisionalPointId/normalizedName — never pointId, rawName, sourceAddress, rulesVersion, or provenance', () => {
		const instance = makeInstance();
		const tag = instance.mapTagPayload(message, 0, 'tags', false);

		expect(tag.provisionalPointId).toBe(pointIdentity.provisionalPointId);
		expect(tag.normalizedName).toBe('ahu_1_sat');

		expect(tag.pointId).toBeUndefined();
		expect(tag.rawName).toBeUndefined();
		expect(tag.sourceAddress).toBeUndefined();
		expect(tag.rulesVersion).toBeUndefined();
		expect(tag.provenance).toBeUndefined();
	});

	it('omits provisionalPointId/normalizedName when the message has no pointIdentity (interceptor never ran / threw)', () => {
		const instance = makeInstance();
		const { pointIdentity: _omit, ...noIdentity } = message;
		const tag = instance.mapTagPayload(noIdentity, 0, 'tags', false);

		expect(tag.provisionalPointId).toBeUndefined();
		expect(tag.normalizedName).toBeUndefined();
	});

	it('"ecp" format carries the same compact fields as "tags"', () => {
		const instance = makeInstance();
		const tag = instance.mapTagPayload(message, 0, 'ecp', false);
		expect(tag.provisionalPointId).toBe(pointIdentity.provisionalPointId);
		expect(tag.normalizedName).toBe('ahu_1_sat');
	});
});

describe('attachMlEnrichment() compact point-identity projection', () => {
	it('"ml" feature payloads carry only provisionalPointId/normalizedName, never pointId', () => {
		const instance = makeInstance();
		const feature: any = { name: 'AHU-1 SAT', value: 21.5, dtype: 'float', quality: 'GOOD' };
		instance.attachMlEnrichment(feature, message);

		expect(feature.provisionalPointId).toBe(pointIdentity.provisionalPointId);
		expect(feature.normalizedName).toBe('ahu_1_sat');
		expect(feature.pointId).toBeUndefined();
		expect(feature.provenance).toBeUndefined();
	});
});
