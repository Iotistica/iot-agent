import { PublishManager } from '../../../src/publish/core/manager';

function makeManager(): any {
	const manager = Object.create(PublishManager.prototype);
	manager.protocol = 'mqtt';
	manager.endpointName = 'mqtt-pipe';
	return manager;
}

describe('PublishManager source routing', () => {
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
