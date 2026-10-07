/**
 * Tests the anomaly-enrichment projection added to mapTagPayload() this
 * session — previously 'ml'-format-only (attachMlEnrichment()), now shared
 * via readAnomalyFields() so 'tags'/'ecp' payloads carry the same fields.
 * Pure given a message (readAnomalyFields() has no constructor-initialized
 * state), so exercised directly off the prototype — same convention as
 * build-payload-quality.unit.spec.ts.
 */
import { PublishManager } from '../../../src/publish/core/manager';

function makeInstance(): any {
	return Object.create(PublishManager.prototype);
}

const message = {
	metric: 'temp',
	value: 21.5,
	quality: 'GOOD',
	anomaly_score: 0.87,
	anomaly_threshold: 0.75,
	baseline_samples: 120,
	detection_methods: ['zscore', 'iqr'],
	trend: 'rising',
	trend_strength: 0.42,
	predicted_next: 22.1,
	forecast_confidence: 0.6,
	device_state: 'occupied',
	state_duration_seconds: 300,
};

describe('mapTagPayload() anomaly-enrichment projection', () => {
	it('"tags" payloads carry the full anomaly field set when present on the message', () => {
		const instance = makeInstance();
		const tag = instance.mapTagPayload(message, 0, 'tags', false);

		expect(tag.anomaly_score).toBe(0.87);
		expect(tag.anomaly_threshold).toBe(0.75);
		expect(tag.baseline_samples).toBe(120);
		expect(tag.detection_methods).toEqual(['zscore', 'iqr']);
		expect(tag.trend).toBe('rising');
		expect(tag.trend_strength).toBe(0.42);
		expect(tag.predicted_next).toBe(22.1);
		expect(tag.forecast_confidence).toBe(0.6);
		expect(tag.device_state).toBe('occupied');
		expect(tag.state_duration_seconds).toBe(300);
	});

	it('"ecp" payloads carry the same anomaly fields', () => {
		const instance = makeInstance();
		const tag = instance.mapTagPayload(message, 0, 'ecp', false);

		expect(tag.anomaly_score).toBe(0.87);
		expect(tag.trend).toBe('rising');
	});

	it('error-branch tags still carry anomaly fields (device_state can be meaningful even on a failed read)', () => {
		const instance = makeInstance();
		const errored = { ...message, value: undefined, error: 'TIMEOUT' };
		const tag = instance.mapTagPayload(errored, 0, 'tags', false);

		expect(tag.error).toBe('TIMEOUT');
		expect(tag.device_state).toBe('occupied');
		expect(tag.anomaly_score).toBe(0.87);
	});

	it('never fabricates anomaly fields when the message has none (anomaly detection not bound / reading not scored)', () => {
		const instance = makeInstance();
		const { anomaly_score: _s, anomaly_threshold: _t, baseline_samples: _b, detection_methods: _d, trend: _tr, trend_strength: _ts, predicted_next: _p, forecast_confidence: _f, device_state: _ds, state_duration_seconds: _sd, ...bare } = message;
		const tag = instance.mapTagPayload(bare, 0, 'tags', false);

		expect(tag.anomaly_score).toBeUndefined();
		expect(tag.anomaly_threshold).toBeUndefined();
		expect(tag.baseline_samples).toBeUndefined();
		expect(tag.detection_methods).toBeUndefined();
		expect(tag.trend).toBeUndefined();
		expect(tag.trend_strength).toBeUndefined();
		expect(tag.predicted_next).toBeUndefined();
		expect(tag.forecast_confidence).toBeUndefined();
		expect(tag.device_state).toBeUndefined();
		expect(tag.state_duration_seconds).toBeUndefined();
	});

	it('ignores wrong-typed anomaly fields on the message rather than passing them through', () => {
		const instance = makeInstance();
		const wrongTypes = { ...message, anomaly_score: 'high', trend_strength: 'strong', detection_methods: 'zscore' };
		const tag = instance.mapTagPayload(wrongTypes, 0, 'tags', false);

		expect(tag.anomaly_score).toBeUndefined();
		expect(tag.trend_strength).toBeUndefined();
		expect(tag.detection_methods).toBeUndefined();
	});
});

describe('attachMlEnrichment() anomaly-enrichment projection (regression — unchanged behavior)', () => {
	it('"ml" feature payloads still carry the full anomaly field set via the shared helper', () => {
		const instance = makeInstance();
		const feature: any = { name: 'temp', value: 21.5, dtype: 'float', quality: 'GOOD' };
		instance.attachMlEnrichment(feature, message);

		expect(feature.anomaly_score).toBe(0.87);
		expect(feature.trend).toBe('rising');
		expect(feature.device_state).toBe('occupied');
		expect(feature.state_duration_seconds).toBe(300);
	});
});
