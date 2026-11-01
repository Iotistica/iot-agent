import { activityMonitor } from '../../../src/publish/core/activity-monitor';

describe('ActivityMonitor latest point snapshots', () => {
	it('keeps the latest reading for every point beyond the recent event limit', () => {
		const protocol = `snapshot-test-${Date.now()}`;
		const record = (metric: string, value: number) => activityMonitor.record({
			subscriptionId: 1,
			destinationId: 1,
			destinationName: 'test',
			destinationType: 'test',
			protocol,
			endpointName: 'source',
			metric,
			value,
			pointCount: 1,
		});

		for (let i = 0; i < 1001; i++) record(`point-${i}`, i);
		record('point-0', 1001);

		expect(activityMonitor.getRecentEvents(1000, protocol)).toHaveLength(1000);
		const points = activityMonitor.getLatestPoints().filter(point => point.protocol === protocol);
		expect(points).toHaveLength(1001);
		expect(points.find(point => point.metric === 'point-0')?.value).toBe(1001);
	});
});
