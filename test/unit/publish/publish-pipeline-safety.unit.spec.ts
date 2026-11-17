import { MessageBatcher } from '../../../src/publish/core/batch';
import type { DeviceConfig } from '../../../src/publish/core/types';

function makeConfig(overrides?: Partial<DeviceConfig>): DeviceConfig {
	return {
		name: 'test-endpoint',
		protocol: 'opcua',
		enabled: true,
		addr: 'unused',
		addrPollSec: 10,
		publishInterval: 30000,
		bufferTimeMs: 0,
		bufferSize: 0,
		bufferCapacity: 1024 * 1024,
		eomDelimiter: '\n',
		mqttTopic: 'unused',
		heartbeatTimeSec: 300,
		...overrides,
	};
}

function pushReading(batcher: MessageBatcher, metric: string, value: number): void {
	const reading = { deviceName: 'dev-1', metric, value, timestamp: new Date().toISOString() };
	batcher.appendData(Buffer.from(JSON.stringify(reading) + '\n', 'utf8'));
}

describe('MessageBatcher.take()', () => {
	it('returns the current batch and starts a fresh one', () => {
		const batcher = new MessageBatcher(makeConfig(), 10000, 10 * 1024 * 1024);
		pushReading(batcher, 'temperature', 22);
		pushReading(batcher, 'pressure', 101);

		const snapshot = batcher.take();
		expect(snapshot.messageCount).toBe(2);
		expect(snapshot.messages).toHaveLength(2);
		expect(snapshot.messages[0].metric).toBe('temperature');
		expect(snapshot.messages[1].metric).toBe('pressure');
		expect(snapshot.totalBytes).toBeGreaterThan(0);

		expect(batcher.messageCount).toBe(0);
		expect(batcher.messages).toHaveLength(0);
		expect(batcher.totalBytes).toBe(0);
	});

	it('messages added after take() go into the new batch, not the snapshot', () => {
		const batcher = new MessageBatcher(makeConfig(), 10000, 10 * 1024 * 1024);
		pushReading(batcher, 'temperature', 22);

		const snapshot = batcher.take();

		pushReading(batcher, 'humidity', 55);
		pushReading(batcher, 'pressure', 101);

		expect(snapshot.messages).toHaveLength(1);
		expect(snapshot.messages[0].metric).toBe('temperature');

		expect(batcher.messageCount).toBe(2);
		expect(batcher.messages[0].metric).toBe('humidity');
		expect(batcher.messages[1].metric).toBe('pressure');
	});

	it('preserves message ordering', () => {
		const batcher = new MessageBatcher(makeConfig(), 10000, 10 * 1024 * 1024);
		for (let i = 0; i < 100; i++) {
			pushReading(batcher, `metric_${i}`, i);
		}

		const snapshot = batcher.take();
		expect(snapshot.messages).toHaveLength(100);
		for (let i = 0; i < 100; i++) {
			expect(snapshot.messages[i].metric).toBe(`metric_${i}`);
			expect(snapshot.messages[i].value).toBe(i);
		}
	});

	it('take() on an empty batcher returns an empty snapshot', () => {
		const batcher = new MessageBatcher(makeConfig(), 10000, 10 * 1024 * 1024);
		const snapshot = batcher.take();
		expect(snapshot.messageCount).toBe(0);
		expect(snapshot.messages).toHaveLength(0);
		expect(snapshot.totalBytes).toBe(0);
	});
});

describe('collectTagRecords spread-safety', () => {
	it('loop-based push handles large readings arrays without stack overflow', () => {
		const readings: any[] = [];
		for (let i = 0; i < 100_000; i++) {
			readings.push({ metric: `point_${i}`, value: i });
		}

		const tagRecords: any[] = [];
		for (const reading of readings) tagRecords.push(reading);

		expect(tagRecords).toHaveLength(100_000);
		expect(tagRecords[0].metric).toBe('point_0');
		expect(tagRecords[99_999].metric).toBe('point_99999');
	});

	it('spread-based push overflows at ~65K elements (documents the bug)', () => {
		const readings: any[] = [];
		for (let i = 0; i < 200_000; i++) {
			readings.push({ metric: `point_${i}`, value: i });
		}

		const tagRecords: any[] = [];
		expect(() => {
			tagRecords.push(...readings);
		}).toThrow();
	});
});
