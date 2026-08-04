/**
 * Tests the standardized point-name projection in mapTagPayload()/
 * attachMlEnrichment(): `name` becomes the normalized point name when
 * available (falling back to the raw protocol identifier), with the raw
 * value always preserved as `rawName`. Mirrors build-payload-quality.unit.spec.ts's
 * approach of exercising these pure sibling methods directly off the prototype
 * rather than constructing a full PublishManager.
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

describe('mapTagPayload() standardized point-name projection', () => {
	it('"tags"/"ecp" payloads use the normalized name as `name`, carry the raw identifier as `rawName`, and provisionalPointId — never pointId, sourceAddress, rulesVersion, or provenance', () => {
		const instance = makeInstance();
		const tag = instance.mapTagPayload(message, 0, 'tags', false);

		expect(tag.name).toBe('ahu_1_sat');
		expect(tag.rawName).toBe('AHU-1 SAT');
		expect(tag.provisionalPointId).toBe(pointIdentity.provisionalPointId);

		expect(tag.pointId).toBeUndefined();
		expect(tag.normalizedName).toBeUndefined(); // no longer duplicated — `name` already is it
		expect(tag.sourceAddress).toBeUndefined();
		expect(tag.rulesVersion).toBeUndefined();
		expect(tag.provenance).toBeUndefined();
	});

	it('falls back to the raw protocol identifier as `name` when the message has no pointIdentity (interceptor never ran / threw) — rawName still present', () => {
		const instance = makeInstance();
		const { pointIdentity: _omit, ...noIdentity } = message;
		const tag = instance.mapTagPayload(noIdentity, 0, 'tags', false);

		expect(tag.name).toBe('AHU-1 SAT');
		expect(tag.rawName).toBe('AHU-1 SAT');
		expect(tag.provisionalPointId).toBeUndefined();
	});

	it('"ecp" format carries the same standardized fields as "tags"', () => {
		const instance = makeInstance();
		const tag = instance.mapTagPayload(message, 0, 'ecp', false);
		expect(tag.name).toBe('ahu_1_sat');
		expect(tag.rawName).toBe('AHU-1 SAT');
		expect(tag.provisionalPointId).toBe(pointIdentity.provisionalPointId);
	});

	it('ECP dedup-by-name now dedupes on the normalized name, not the raw identifier', () => {
		// Two readings whose raw metric differs but normalize to the same name (e.g. a
		// rename mid-batch) should collapse to one ECP tag, keeping the last value —
		// same dedup semantics as before, now keyed on the standardized `name`.
		const instance = makeInstance();
		const a = instance.mapTagPayload({ metric: 'AHU-1 SAT', value: 1, pointIdentity: { normalizedName: 'ahu_1_sat' } }, 0, 'ecp', false);
		const b = instance.mapTagPayload({ metric: 'AHU 1 SAT', value: 2, pointIdentity: { normalizedName: 'ahu_1_sat' } }, 1, 'ecp', false);
		expect(a.name).toBe(b.name);
		expect(a.rawName).not.toBe(b.rawName);
	});
});

describe('mapMlFeaturePayload() standardized point-name projection', () => {
	it('uses the normalized name as `name`, carries the raw identifier as `rawName`', () => {
		const instance = makeInstance();
		const feature = instance.mapMlFeaturePayload(message, 0);
		expect(feature.name).toBe('ahu_1_sat');
		expect(feature.rawName).toBe('AHU-1 SAT');
		expect(feature.provisionalPointId).toBe(pointIdentity.provisionalPointId);
	});

	it('falls back to the raw identifier as `name` with no pointIdentity', () => {
		const instance = makeInstance();
		const { pointIdentity: _omit, ...noIdentity } = message;
		const feature = instance.mapMlFeaturePayload(noIdentity, 0);
		expect(feature.name).toBe('AHU-1 SAT');
		expect(feature.rawName).toBe('AHU-1 SAT');
	});
});

describe('attachMlEnrichment() standardized point-name projection', () => {
	it('carries provisionalPointId only, never normalizedName or pointId — the ML feature\'s own `name` (set by mapMlFeaturePayload) already carries the normalized value', () => {
		const instance = makeInstance();
		const feature: any = { name: 'ahu_1_sat', rawName: 'AHU-1 SAT', value: 21.5, dtype: 'float', quality: 'GOOD' };
		instance.attachMlEnrichment(feature, message);

		expect(feature.provisionalPointId).toBe(pointIdentity.provisionalPointId);
		expect(feature.pointId).toBeUndefined();
		expect(feature.normalizedName).toBeUndefined();
		expect(feature.provenance).toBeUndefined();
	});
});
