import { Pool } from 'pg';
import { TimescaleDbPublishPlugin } from '../../../src/publish/plugins/timescaledb';
import type { PublishBatchItem } from '../../../src/publish/core/types';

/**
 * Runs against the real TimescaleDB container (iotistica-postgres-1) started by the
 * iotistica repo's docker-compose, using the same `readings` table/schema the cloud
 * ingestion service writes to. Rows are scoped to a dedicated test agent_uuid and
 * cleaned up afterwards so this never touches real device data.
 */
const TEST_AGENT_UUID = '00000000-0000-4000-8000-000000000001';

const DB_CONFIG = {
	host: 'localhost',
	port: 5432,
	database: 'iotistica',
	user: 'postgres',
	password: 'postgres',
};

function makeLogger() {
	return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeItem(payload: unknown, topic = `i/tenant/a/${TEST_AGENT_UUID}/mqtt`): PublishBatchItem {
	return { topic, payload: JSON.stringify(payload) };
}

describe('TimescaleDbPublishPlugin (integration)', () => {
	let adminPool: Pool;
	let plugin: TimescaleDbPublishPlugin;

	beforeAll(async () => {
		adminPool = new Pool(DB_CONFIG);
		await adminPool.query('DELETE FROM readings WHERE agent_uuid = $1', [TEST_AGENT_UUID]);
	});

	afterAll(async () => {
		await adminPool.query('DELETE FROM readings WHERE agent_uuid = $1', [TEST_AGENT_UUID]);
		await adminPool.end();
	});

	beforeEach(async () => {
		plugin = TimescaleDbPublishPlugin.fromConfig(DB_CONFIG, makeLogger(), TEST_AGENT_UUID);
		await plugin.start();
	});

	afterEach(async () => {
		await plugin.stop();
		await adminPool.query('DELETE FROM readings WHERE agent_uuid = $1', [TEST_AGENT_UUID]);
	});

	it('writes a custom-payload batch into readings with the expected column values', async () => {
		await plugin.publishBatch([
			makeItem({
				timestamp: 1700000000000,
				protocol: 'modbus',
				messages: [{ metric: 'temperature', value: 21.5, quality: 'good', unit: 'C' }],
			}),
		]);

		const { rows } = await adminPool.query(
			'SELECT time, agent_uuid, metric_name, value, quality, unit, protocol, extra FROM readings WHERE agent_uuid = $1',
			[TEST_AGENT_UUID],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			agent_uuid: TEST_AGENT_UUID,
			metric_name: 'temperature',
			value: 21.5,
			quality: 'good',
			unit: 'C',
			protocol: 'modbus',
		});
		expect(new Date(rows[0].time).getTime()).toBe(1700000000000);
		expect(rows[0].extra).toMatchObject({ endpoint_uuid: null, device_uuid: null, device_name: null });
	});

	it('writes a tags-payload batch into readings', async () => {
		await plugin.publishBatch([
			makeItem({ timestamp: 1700000001000, node: 'device-a', group: 'line1', tags: [{ name: 'pressure', value: 3.2 }] }),
		]);

		const { rows } = await adminPool.query(
			'SELECT metric_name, value, extra FROM readings WHERE agent_uuid = $1 AND metric_name = $2',
			[TEST_AGENT_UUID, 'pressure'],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].value).toBe(3.2);
		expect(rows[0].extra).toMatchObject({ device_name: 'device-a', group: 'line1' });
	});

	it('is idempotent under ON CONFLICT DO NOTHING when the same batch is published twice', async () => {
		const batch = [makeItem({ timestamp: 1700000002000, messages: [{ metric: 'humidity', value: 55 }] })];

		await plugin.publishBatch(batch);
		await plugin.publishBatch(batch);

		const { rows } = await adminPool.query(
			'SELECT COUNT(*)::int AS count FROM readings WHERE agent_uuid = $1 AND metric_name = $2',
			[TEST_AGENT_UUID, 'humidity'],
		);
		expect(rows[0].count).toBe(1);
	});

	it('writes multiple rows spanning several metrics in one batch', async () => {
		await plugin.publishBatch([
			makeItem({
				timestamp: 1700000003000,
				messages: [
					{ metric: 'a', value: 1 },
					{ metric: 'b', value: 2 },
					{ metric: 'c', value: 3 },
				],
			}),
		]);

		const { rows } = await adminPool.query(
			'SELECT metric_name, value FROM readings WHERE agent_uuid = $1 AND time = to_timestamp(1700000003.000) ORDER BY metric_name',
			[TEST_AGENT_UUID],
		);
		expect(rows.map((r: { metric_name: string; value: number }) => [r.metric_name, r.value])).toEqual([
			['a', 1], ['b', 2], ['c', 3],
		]);
	});

	it('rejects publishBatch after stop() has closed the pool', async () => {
		await plugin.stop();
		await expect(plugin.publishBatch([makeItem({ messages: [{ metric: 'x', value: 1 }] })]))
			.rejects.toThrow('not started');
	});
});
