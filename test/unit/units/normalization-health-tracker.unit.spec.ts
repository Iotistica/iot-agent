import {
	getNormalizationHealthTracker,
	resetNormalizationHealthTrackerForTests,
} from '../../../src/units/normalization-health-tracker';

beforeEach(() => {
	resetNormalizationHealthTrackerForTests();
});

describe('NormalizationHealthTracker — counting', () => {
	it('recordUnknownUnit() called N times for the same (label, protocol) produces count === N', () => {
		const tracker = getNormalizationHealthTracker();
		for (let i = 0; i < 5; i++) tracker.recordUnknownUnit('furlongs', 'mqtt');

		const { unknownUnits } = tracker.getSummary();
		expect(unknownUnits.count).toBe(1); // one distinct entry
		expect(unknownUnits.items[0]).toMatchObject({ label: 'furlongs', protocol: 'mqtt', count: 5 });
	});

	it('the same label under different protocols counts separately', () => {
		const tracker = getNormalizationHealthTracker();
		tracker.recordUnknownUnit('furlongs', 'mqtt');
		tracker.recordUnknownUnit('furlongs', 'mqtt');
		tracker.recordUnknownUnit('furlongs', 'bacnet');

		const { unknownUnits } = tracker.getSummary();
		expect(unknownUnits.count).toBe(2);
		const mqttEntry = unknownUnits.items.find((i) => i.protocol === 'mqtt');
		const bacnetEntry = unknownUnits.items.find((i) => i.protocol === 'bacnet');
		expect(mqttEntry?.count).toBe(2);
		expect(bacnetEntry?.count).toBe(1);
	});

	it('is case/whitespace-insensitive on protocol (reuses normalizeSourceSystem), but not on the unit label itself', () => {
		const tracker = getNormalizationHealthTracker();
		tracker.recordUnknownUnit('furlongs', 'MQTT');
		tracker.recordUnknownUnit('furlongs', ' mqtt ');

		const { unknownUnits } = tracker.getSummary();
		expect(unknownUnits.count).toBe(1);
		expect(unknownUnits.items[0].count).toBe(2);
	});

	it('conversion failures count independently of unknown units, keyed by "from → to"', () => {
		const tracker = getNormalizationHealthTracker();
		tracker.recordConversionFailure('F', 'kPa', 'mqtt');
		tracker.recordConversionFailure('F', 'kPa', 'mqtt');
		tracker.recordUnknownUnit('furlongs', 'mqtt');

		const { unknownUnits, conversionFailures } = tracker.getSummary();
		expect(unknownUnits.count).toBe(1);
		expect(conversionFailures.count).toBe(1);
		expect(conversionFailures.items[0]).toMatchObject({ label: 'F → kPa', protocol: 'mqtt', count: 2 });
	});

	it('getSummary() sorts items by count descending', () => {
		const tracker = getNormalizationHealthTracker();
		tracker.recordUnknownUnit('rare-unit', 'mqtt');
		for (let i = 0; i < 3; i++) tracker.recordUnknownUnit('common-unit', 'mqtt');

		const { unknownUnits } = tracker.getSummary();
		expect(unknownUnits.items.map((i) => i.label)).toEqual(['common-unit', 'rare-unit']);
	});
});

describe('NormalizationHealthTracker — clearUnknownUnit()', () => {
	it('removes exactly the matching (label, protocol) entry', () => {
		const tracker = getNormalizationHealthTracker();
		tracker.recordUnknownUnit('furlongs', 'mqtt');
		tracker.clearUnknownUnit('furlongs', 'mqtt');

		const { unknownUnits } = tracker.getSummary();
		expect(unknownUnits.count).toBe(0);
	});

	it('leaves other entries untouched — including the same label under a different protocol', () => {
		const tracker = getNormalizationHealthTracker();
		tracker.recordUnknownUnit('furlongs', 'mqtt');
		tracker.recordUnknownUnit('furlongs', 'bacnet');
		tracker.recordUnknownUnit('parsecs', 'mqtt');

		tracker.clearUnknownUnit('furlongs', 'mqtt');

		const { unknownUnits } = tracker.getSummary();
		const labels = unknownUnits.items.map((i) => `${i.label}\0${i.protocol}`);
		expect(labels).not.toContain('furlongs\0mqtt');
		expect(labels).toContain('furlongs\0bacnet');
		expect(labels).toContain('parsecs\0mqtt');
	});

	it('is a safe no-op for a key that was never tracked', () => {
		const tracker = getNormalizationHealthTracker();
		expect(() => tracker.clearUnknownUnit('never-seen', 'mqtt')).not.toThrow();
		expect(tracker.getSummary().unknownUnits.count).toBe(0);
	});

	it('is case/whitespace-insensitive on protocol, matching recordUnknownUnit()\'s own normalization', () => {
		const tracker = getNormalizationHealthTracker();
		tracker.recordUnknownUnit('furlongs', 'MQTT');
		tracker.clearUnknownUnit('furlongs', ' mqtt ');

		expect(tracker.getSummary().unknownUnits.count).toBe(0);
	});

	it('does not touch conversionFailures', () => {
		const tracker = getNormalizationHealthTracker();
		tracker.recordUnknownUnit('furlongs', 'mqtt');
		tracker.recordConversionFailure('F', 'kPa', 'mqtt');

		tracker.clearUnknownUnit('furlongs', 'mqtt');

		const { conversionFailures } = tracker.getSummary();
		expect(conversionFailures.count).toBe(1);
	});
});

describe('NormalizationHealthTracker — bounded memory', () => {
	it('never grows past 500 distinct entries for one kind', () => {
		const tracker = getNormalizationHealthTracker();
		for (let i = 0; i < 600; i++) tracker.recordUnknownUnit(`unit-${i}`, 'mqtt');

		const { unknownUnits } = tracker.getSummary();
		expect(unknownUnits.count).toBe(500);
	});

	it('evicts the lowest-count entry (not the oldest) once a new key arrives past the cap', () => {
		const tracker = getNormalizationHealthTracker();

		// Fill to the cap, giving the very first entry extra observations so
		// it's clearly not the lowest-count one.
		tracker.recordUnknownUnit('unit-0', 'mqtt');
		tracker.recordUnknownUnit('unit-0', 'mqtt');
		tracker.recordUnknownUnit('unit-0', 'mqtt');
		for (let i = 1; i < 500; i++) tracker.recordUnknownUnit(`unit-${i}`, 'mqtt');

		// One more distinct key past the cap — should evict a single-count
		// entry, never the high-count unit-0.
		tracker.recordUnknownUnit('unit-new', 'mqtt');

		const { unknownUnits } = tracker.getSummary();
		expect(unknownUnits.count).toBe(500);
		const labels = unknownUnits.items.map((i) => i.label);
		expect(labels).toContain('unit-0');
		expect(labels).toContain('unit-new');
	});
});

describe('NormalizationHealthTracker — failure isolation', () => {
	it('UnitCatalog.logUnknownUnit() completes normally even if the tracker throws', () => {
		jest.resetModules();
		jest.doMock('../../../src/units/normalization-health-tracker', () => ({
			getNormalizationHealthTracker: () => {
				throw new Error('tracker exploded');
			},
		}));
		jest.doMock('../../../src/db/models/index', () => ({
			UnitDefinitionsModel: { getAll: () => [], upsert: jest.fn() },
			UnitAliasesModel: { getAll: () => [], upsert: jest.fn() },
		}));

		// Re-require after mocking so catalog.ts picks up the throwing mock.
		const { getUnitCatalog } = require('../../../src/units/catalog');
		const catalog = getUnitCatalog();

		expect(() => catalog.logUnknownUnit('furlongs', 'mqtt')).not.toThrow();

		jest.dontMock('../../../src/units/normalization-health-tracker');
		jest.dontMock('../../../src/db/models/index');
		jest.resetModules();
	});

	it('a reading with an unconvertible unit still gets published normally even when the tracker throws (full handleMessage() path)', () => {
		jest.resetModules();
		jest.doMock('../../../src/units/normalization-health-tracker', () => ({
			getNormalizationHealthTracker: () => ({
				recordConversionFailure: () => {
					throw new Error('tracker exploded');
				},
				recordUnknownUnit: () => {
					throw new Error('tracker exploded');
				},
			}),
		}));

		const { MqttAdapter } = require('../../../src/plugins/mqtt/adapter');

		const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
		const config = {
			broker: { host: 'localhost', port: 1883 },
			qos: 1,
			reconnect: { period: 5000, maxAttempts: 10 },
			logging: { level: 'info', enableConsole: false, enableFile: false },
			devices: [
				{
					name: 'test_device',
					enabled: true,
					topic: 'test/topic',
					dataType: 'number',
					metrics: [{ field: 'temperature', metric: 'temperature', unit: 'kPa', type: 'number' }],
				},
			],
		};

		const adapter = new MqttAdapter(config, mockLogger, 'test-device-uuid');
		const dataSpy = jest.fn();
		adapter.on('data', dataSpy);
		(adapter as any).subscriptions.set('test/topic', config.devices[0]);

		// F -> kPa is a cross-dimension, unsupported conversion — exercises
		// the exact catch block the tracker call was added to.
		expect(() => {
			(adapter as any).handleMessage(
				'test/topic',
				Buffer.from(JSON.stringify({ temperature: 77, units: { temperature: 'F' } })),
				false,
			);
		}).not.toThrow();

		// The reading still made it all the way to publish — a throwing
		// tracker never swallowed or dropped it.
		expect(dataSpy).toHaveBeenCalledTimes(1);
		const emittedPoints = dataSpy.mock.calls[0][0];
		expect(emittedPoints[0]).toEqual(expect.objectContaining({ metric: 'temperature', value: 77, unit: 'F' }));

		jest.dontMock('../../../src/units/normalization-health-tracker');
		jest.resetModules();
	});
});
