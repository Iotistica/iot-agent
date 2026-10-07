/**
 * Tests the lazy/LRU-capped per-topic message history added to
 * BrokerMonitorService this session (watchTopic/unwatchTopic/getHistory/
 * getHistoryEntry/recordHistory). History is only tracked for topics the
 * admin UI has actually selected, not for every topic the monitor's `#`
 * firehose sees — these tests cover that lazy-start behavior, the
 * ring-buffer/LRU bounds, and that it doesn't disturb the existing
 * topicTree bookkeeping.
 *
 * BrokerMonitorService's constructor is private (singleton) and the new
 * methods rely on class-field-initialized state (watchedTopics/
 * historyByTopic/nextHistoryId) rather than purely-functional sibling
 * methods, so — unlike build-payload-quality.unit.spec.ts's
 * Object.create(prototype) pattern — those three fields are seeded
 * explicitly per instance below instead of relying on the constructor.
 */
import { BrokerMonitorService } from '../../../src/mqtt/broker-monitor';

function makeInstance(): any {
	const instance = Object.create(BrokerMonitorService.prototype);
	instance.watchedTopics = new Map();
	instance.historyByTopic = new Map();
	instance.nextHistoryId = 1;
	instance.topicTree = {};
	instance.sysData = {};
	instance.totalTopics = 0;
	instance.totalMessages = 0;
	return instance;
}

function send(instance: any, topic: string, body: unknown, packet: { qos?: number; retain?: boolean } = {}) {
	instance.handleMessage(topic, Buffer.from(JSON.stringify(body)), packet);
}

describe('BrokerMonitorService topic history', () => {
	it('tracks nothing for a topic that was never watched, even after messages arrive', () => {
		const instance = makeInstance();
		send(instance, 'sensors/test_1', { value: 1 });
		expect(instance.getHistory('sensors/test_1')).toEqual([]);
	});

	it('records a message once the topic is watched', () => {
		const instance = makeInstance();
		instance.watchTopic('sensors/test_1');
		send(instance, 'sensors/test_1', { value: 1 }, { qos: 1, retain: true });

		const history = instance.getHistory('sensors/test_1');
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({
			qos: 1,
			retain: true,
			messageType: 'json',
			truncated: false,
		});
		expect(typeof history[0].id).toBe('number');
		expect(typeof history[0].ts).toBe('number');
	});

	it('returns entries newest-first', () => {
		const instance = makeInstance();
		instance.watchTopic('sensors/test_1');
		send(instance, 'sensors/test_1', { seq: 1 });
		send(instance, 'sensors/test_1', { seq: 2 });
		send(instance, 'sensors/test_1', { seq: 3 });

		const history = instance.getHistory('sensors/test_1');
		expect(history.map((e: any) => JSON.parse(e.text).seq)).toEqual([3, 2, 1]);
	});

	it('caps the ring buffer at MAX_HISTORY_PER_TOPIC, dropping the oldest entries', () => {
		const instance = makeInstance();
		instance.watchTopic('sensors/test_1');
		for (let i = 0; i < 151; i++) send(instance, 'sensors/test_1', { seq: i });

		const history = instance.getHistory('sensors/test_1');
		expect(history).toHaveLength(150);
		// Oldest surviving entry is seq=1 (seq=0 was evicted), newest is seq=150.
		expect(JSON.parse(history[history.length - 1].text).seq).toBe(1);
		expect(JSON.parse(history[0].text).seq).toBe(150);
	});

	it('truncates an oversized entry and still reports the full original byte size', () => {
		const instance = makeInstance();
		instance.watchTopic('sensors/test_1');
		const bigValue = 'x'.repeat(64 * 1024); // forces payload well past the 32KB history cap
		send(instance, 'sensors/test_1', { bigValue });

		const [entry] = instance.getHistory('sensors/test_1');
		expect(entry.truncated).toBe(true);
		expect(entry.text.length).toBe(32 * 1024);
		expect(entry.bytes).toBeGreaterThan(32 * 1024);
	});

	it('getHistoryEntry() returns the full entry (including text) by id', () => {
		const instance = makeInstance();
		instance.watchTopic('sensors/test_1');
		send(instance, 'sensors/test_1', { value: 42 });

		const [{ id }] = instance.getHistory('sensors/test_1');
		const entry = instance.getHistoryEntry('sensors/test_1', id);
		expect(entry).toBeDefined();
		expect(JSON.parse(entry.text)).toEqual({ value: 42 });
	});

	it('getHistoryEntry() returns undefined for an id evicted by ring-buffer rollover', () => {
		const instance = makeInstance();
		instance.watchTopic('sensors/test_1');
		send(instance, 'sensors/test_1', { seq: 0 }); // id=1, will be evicted
		for (let i = 1; i < 151; i++) send(instance, 'sensors/test_1', { seq: i });

		expect(instance.getHistoryEntry('sensors/test_1', 1)).toBeUndefined();
	});

	it('evicts the least-recently-used watched topic beyond MAX_WATCHED_TOPICS', () => {
		const instance = makeInstance();
		for (let i = 0; i < 20; i++) instance.watchTopic(`topic/${i}`);
		send(instance, 'topic/0', { v: 1 });
		expect(instance.getHistory('topic/0')).toHaveLength(1);

		instance.watchTopic('topic/20'); // 21st distinct watch — evicts topic/0 (oldest)

		expect(instance.getHistory('topic/0')).toEqual([]);
		send(instance, 'topic/0', { v: 2 });
		expect(instance.getHistory('topic/0')).toEqual([]); // not re-recorded until re-watched
	});

	it('re-watching an already-watched topic bumps its recency, protecting it from eviction', () => {
		const instance = makeInstance();
		for (let i = 0; i < 20; i++) instance.watchTopic(`topic/${i}`);
		instance.watchTopic('topic/0'); // bump topic/0 to most-recently-used
		instance.watchTopic('topic/20'); // should now evict topic/1, not topic/0

		send(instance, 'topic/0', { v: 1 });
		expect(instance.getHistory('topic/0')).toHaveLength(1);
		expect(instance.getHistory('topic/1')).toEqual([]);
	});

	it('unwatchTopic() clears tracking and history immediately', () => {
		const instance = makeInstance();
		instance.watchTopic('sensors/test_1');
		send(instance, 'sensors/test_1', { value: 1 });
		expect(instance.getHistory('sensors/test_1')).toHaveLength(1);

		instance.unwatchTopic('sensors/test_1');
		expect(instance.getHistory('sensors/test_1')).toEqual([]);

		send(instance, 'sensors/test_1', { value: 2 });
		expect(instance.getHistory('sensors/test_1')).toEqual([]);
	});

	it('never records $SYS/ or other $-prefixed topics, even if coincidentally watched', () => {
		const instance = makeInstance();
		instance.watchTopic('$SYS/broker/uptime');
		instance.watchTopic('$share/group/sensors/test_1');
		instance.handleMessage('$SYS/broker/uptime', Buffer.from('123'), {});
		instance.handleMessage('$share/group/sensors/test_1', Buffer.from('{}'), {});

		expect(instance.getHistory('$SYS/broker/uptime')).toEqual([]);
		expect(instance.getHistory('$share/group/sensors/test_1')).toEqual([]);
	});

	it('does not alter upsertTopic()/topicTree bookkeeping whether or not the topic is watched', () => {
		const watched = makeInstance();
		watched.watchTopic('sensors/test_1');
		send(watched, 'sensors/test_1', { value: 1 });

		const unwatched = makeInstance();
		send(unwatched, 'sensors/test_1', { value: 1 });

		const watchedNode = watched.getTopicTree().sensors.children.test_1;
		const unwatchedNode = unwatched.getTopicTree().sensors.children.test_1;
		expect(watchedNode.count).toBe(unwatchedNode.count);
		expect(watchedNode.lastMessage).toBe(unwatchedNode.lastMessage);
		expect(watchedNode.bytes).toBe(unwatchedNode.bytes);
	});
});
