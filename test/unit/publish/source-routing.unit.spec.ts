import { PublishManager } from '../../../src/publish/core/manager';
import { activityMonitor } from '../../../src/publish/core/activity-monitor';

function makeManager(): any {
	const manager = Object.create(PublishManager.prototype);
	manager.protocol = 'mqtt';
	manager.endpointName = 'mqtt-pipe';
	return manager;
}

describe('PublishManager source routing', () => {
	it.each([false, true])('forwards source and device identity to activity monitoring (dataset: %s)', async (dataset) => {
		const manager = makeManager();
		const reading = {
			deviceName: 'sensor', metric: 'temperature', value: 21,
			endpoint_uuid: 'source-1', device_uuid: 'device-1',
			deviceDisplayName: 'plc-001',
			pointUuid: 'point-1',
		};
		manager.bindings = [{
			publisher: { id: 1, name: 'test', type: 'noop' },
			subscription: { id: 2, route_json: null },
			plugin: {},
			...(dataset && { datasetPointKeys: new Set([JSON.stringify(['sensor', 'temperature'])]) }),
		}];
		manager.resolvePayloadFormatForBinding = () => 'custom';
		manager.getCompressedPayloadForFormat = async () => ({ payload: '{}' });
		manager.sharedDatasetAccumulators = new Map([[2, {
			features: new Map(), lastFlushedAt: Date.now(), samplingIntervalMs: 60000,
		}]]);
		const record = jest.spyOn(activityMonitor, 'record').mockImplementation(() => {});
		try {
			await manager.collectRouteEntries('topic', new Map(), new Map(), 'mqtt-pipe', [reading]);
			expect(record).toHaveBeenCalledWith(expect.objectContaining({
				endpointName: 'sensor', sourceEndpointUuid: 'source-1', deviceUuid: 'device-1', deviceDisplayName: 'plc-001', pointUuid: 'point-1',
			}));
		} finally {
			record.mockRestore();
		}
	});

	it('allows topic-less noop destinations', () => {
		const manager = makeManager();

		expect((manager as any).resolveDestinationTopic({
			publisher: { id: 1, type: 'noop' },
			subscription: { route_json: null },
		}, 'source/topic')).toBe('');
	});

	it('keeps subscriptions with selected sources on the protocol pipe', () => {
		const manager = makeManager();

		expect(manager.matchesSubscription({
			topics: [],
			route_json: { includeDevices: ['factory-sensor'] },
		})).toBe(true);
	});

	it('filters readings to the selected source without mutating the input batch', () => {
		const manager = makeManager();
		const messages = [{
			timestamp: '2026-11-01T00:00:00.000Z',
			readings: [
				{ deviceName: 'factory-sensor', metric: 'temperature', value: 21 },
				{ deviceName: 'warehouse-sensor', metric: 'temperature', value: 18 },
			],
		}];

		const filtered = manager.filterMessagesForSourceRoute(
			messages,
			{ includeDevices: ['factory-sensor'] },
			'mqtt-pipe',
		);

		expect(filtered).toEqual([{
			...messages[0],
			readings: [messages[0].readings[0]],
		}]);
		expect(messages[0].readings).toHaveLength(2);
	});

	it('matches the selected endpoint when its readings identify a nested device', () => {
		const manager = makeManager();
		const messages = [{
			readings: [
				{ deviceName: 'boiler-room', metric: 'temperature', value: 21 },
			],
		}];

		expect(manager.filterMessagesForSourceRoute(
			messages,
			{ includeDevices: ['opcua-1'] },
			'opcua-1',
		)).toEqual(messages);
	});

	it('matches via sourceEndpointName when deviceName has a UUID suffix', () => {
		const manager = makeManager();
		const messages = [{
			deviceName: 'mqtt_factory_sim-001-a1b2c3d4',
			sourceEndpointName: 'mqtt_factory_sim-001',
			metric: 'temperature',
			value: 21,
		}];

		expect(manager.filterMessagesForSourceRoute(
			messages,
			{ includeDevices: ['mqtt_factory_sim-001'] },
			'mqtt-pipe',
		)).toEqual(messages);
	});

	it('excludes via sourceEndpointName when deviceName has a UUID suffix', () => {
		const manager = makeManager();
		const messages = [
			{ deviceName: 'mqtt_factory_sim-001-a1b2c3d4', sourceEndpointName: 'mqtt_factory_sim-001', metric: 'temperature', value: 21 },
			{ deviceName: 'mqtt_warehouse-002-e5f6g7h8', sourceEndpointName: 'mqtt_warehouse-002', metric: 'temperature', value: 18 },
		];

		expect(manager.filterMessagesForSourceRoute(
			messages,
			{ excludeDevices: ['mqtt_factory_sim-001'] },
			'mqtt-pipe',
		)).toEqual([messages[1]]);
	});

	it('matches sourceEndpointName in batch readings with wrapper', () => {
		const manager = makeManager();
		const messages = [{
			timestamp: '2026-11-01T00:00:00.000Z',
			sourceEndpointName: 'mqtt_factory_sim-001',
			readings: [
				{ deviceName: 'mqtt_factory_sim-001-a1b2c3d4', sourceEndpointName: 'mqtt_factory_sim-001', metric: 'temperature', value: 21 },
				{ deviceName: 'mqtt_warehouse-002-e5f6g7h8', sourceEndpointName: 'mqtt_warehouse-002', metric: 'temperature', value: 18 },
			],
		}];

		const filtered = manager.filterMessagesForSourceRoute(
			messages,
			{ includeDevices: ['mqtt_factory_sim-001'] },
			'mqtt-pipe',
		);

		expect(filtered).toEqual([{
			...messages[0],
			readings: [messages[0].readings[0]],
		}]);
	});

	it('excludes selected sources while retaining other readings', () => {
		const manager = makeManager();
		const messages = [
			{ deviceName: 'factory-sensor', metric: 'temperature', value: 21 },
			{ deviceName: 'warehouse-sensor', metric: 'temperature', value: 18 },
		];

		expect(manager.filterMessagesForSourceRoute(
			messages,
			{ excludeDevices: ['factory-sensor'] },
			'mqtt-pipe',
		)).toEqual([messages[1]]);
	});
});
