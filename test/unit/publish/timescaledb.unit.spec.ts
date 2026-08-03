/**
 * Unit tests for the TimescaleDB direct-write publish plugin.
 */

const mockQuery = jest.fn();
const mockEnd = jest.fn();
const mockPoolOn = jest.fn();

jest.mock('pg', () => {
	return {
		Pool: jest.fn().mockImplementation(() => ({
			query: mockQuery,
			end: mockEnd,
			on: mockPoolOn,
		})),
	};
});

import { TimescaleDbPublishPlugin } from '../../../src/publish/plugins/timescaledb';
import type { PublishBatchItem } from '../../../src/publish/core/types';
import { toDeviceUuid } from '../../../src/db/models/device.model';

function makeLogger() {
	return {
		debug: jest.fn(),
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
	};
}

function makeItem(payload: unknown, topic = 'i/tenant/a/agent-1/mqtt'): PublishBatchItem {
	return { topic, payload: JSON.stringify(payload) };
}

describe('TimescaleDbPublishPlugin', () => {
	let logger: ReturnType<typeof makeLogger>;

	beforeEach(() => {
		jest.clearAllMocks();
		mockQuery.mockResolvedValue({ rows: [] });
		logger = makeLogger();
	});

	describe('fromConfig / loadConfig validation', () => {
		it('throws when config is missing entirely', () => {
			expect(() => TimescaleDbPublishPlugin.fromConfig(null, logger, 'agent-1'))
				.toThrow('TimescaleDB destination requires configuration');
		});

		it('throws when host is missing', () => {
			expect(() => TimescaleDbPublishPlugin.fromConfig({ database: 'db', user: 'u' }, logger, 'agent-1'))
				.toThrow('missing required field: host');
		});

		it('throws when database is missing', () => {
			expect(() => TimescaleDbPublishPlugin.fromConfig({ host: 'h', user: 'u' }, logger, 'agent-1'))
				.toThrow('missing required field: database');
		});

		it('throws when user is missing', () => {
			expect(() => TimescaleDbPublishPlugin.fromConfig({ host: 'h', database: 'db' }, logger, 'agent-1'))
				.toThrow('missing required field: user');
		});

		it('warns but does not throw when password is missing', () => {
			expect(() => TimescaleDbPublishPlugin.fromConfig({ host: 'h', database: 'db', user: 'u' }, logger, 'agent-1'))
				.not.toThrow();
			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no password'));
		});

		it('applies sensible defaults for optional fields', async () => {
			const plugin = TimescaleDbPublishPlugin.fromConfig({ host: 'h', database: 'db', user: 'u' }, logger, 'agent-1');
			await plugin.start();
			const { Pool } = jest.requireMock('pg') as { Pool: jest.Mock };
			expect(Pool).toHaveBeenCalledWith(expect.objectContaining({
				host: 'h',
				port: 5432,
				database: 'db',
				user: 'u',
				max: 5,
				ssl: false,
			}));
		});
	});

	describe('publishBatch — custom payload mapping', () => {
		let plugin: TimescaleDbPublishPlugin;

		beforeEach(async () => {
			plugin = TimescaleDbPublishPlugin.fromConfig(
				{ host: 'h', database: 'db', user: 'u', password: 'p' }, logger, 'agent-1',
			);
			await plugin.start();
		});

		it('maps metric fallback chain, quality, and protocol from topic', async () => {
			await plugin.publishBatch([
				makeItem({ timestamp: 1700000000000, messages: [{ metric: 'temp', value: 21.5, quality: 'GOOD', unit: 'C' }] }, 'i/t/a/agent-1/opcua_line1'),
			]);

			expect(mockQuery).toHaveBeenCalledTimes(1);
			const [sql, params] = mockQuery.mock.calls[0];
			expect(sql).toContain('INSERT INTO readings');
			expect(sql).toContain('ON CONFLICT (agent_uuid, metric_name, time) DO NOTHING');
			expect(params[0]).toEqual(new Date(1700000000000));
			expect(params[1]).toBe('agent-1');
			expect(params[2]).toBe('temp');
			expect(params[3]).toBe(21.5);
			expect(params[4]).toBe('good');
			expect(params[5]).toBe('C');
			expect(params[6]).toBe('opcua');
			expect(JSON.parse(params[7])).toEqual({
				endpoint_uuid: null, device_uuid: null, device_name: null, ingested_at: expect.any(String),
			});
		});

		it('falls back through metric_name/nodeName/name/tag/id when metric is absent', async () => {
			await plugin.publishBatch([makeItem({ messages: [{ nodeName: 'sensor.a', value: 1 }] })]);
			const [, params] = mockQuery.mock.calls[0];
			expect(params[2]).toBe('sensor.a');
		});

		it('skips nodeType "metadata" messages entirely', async () => {
			await plugin.publishBatch([makeItem({ messages: [{ nodeType: 'metadata', metric: 'x', value: 1 }] })]);
			expect(mockQuery).not.toHaveBeenCalled();
		});

		it('flattens wrapper messages that batch multiple readings under a nested readings[] array', async () => {
			// Reproduces the real OPC-UA batch shape: PublishManager's 'custom' format passes
			// messages straight through unflattened, and some adapters emit one wrapper object
			// per poll cycle containing { readings: [...], timestamp } rather than one flat
			// reading per array element (see manager.ts's collectTagRecords, which has to do
			// the same flattening for the tags/ecp/ml formats).
			await plugin.publishBatch([makeItem({
				messages: [{
					timestamp: 1700000005000,
					readings: [
						{ metric: 'Temperature', value: 21.5, quality: 'GOOD', unit: 'C' },
						{ metric: 'Pressure', value: 3.2, quality: 'GOOD', unit: 'bar' },
					],
				}],
			}, 'i/t/a/agent-1/opcua_line1')]);

			expect(mockQuery).toHaveBeenCalledTimes(1);
			const [, params] = mockQuery.mock.calls[0];
			// Rows are pre-sorted by (agent_uuid, metric_name, time) for deadlock avoidance,
			// so 'Pressure' sorts before 'Temperature' — two rows -> 16 params.
			expect(params[0]).toEqual(new Date(1700000005000));
			expect(params[2]).toBe('Pressure');
			expect(params[3]).toBe(3.2);
			expect(params[4]).toBe('good');
			expect(params[10]).toBe('Temperature');
			expect(params[11]).toBe(21.5);
		});

		it('coerces boolean values to 1/0 and non-numeric/non-boolean values to null', async () => {
			await plugin.publishBatch([makeItem({
				messages: [
					{ metric: 'flag', value: true },
					{ metric: 'label', value: 'not-a-number' },
				],
			})]);
			const [, params] = mockQuery.mock.calls[0];
			// two rows -> 16 params; row1 value at index 3, row2 value at index 11
			expect(params[3]).toBe(1);
			expect(params[11]).toBeNull();
		});

		it('UUID-validates endpoint_uuid, rejecting malformed ids', async () => {
			const validUuid = '123e4567-e89b-42d3-a456-426614174000';
			await plugin.publishBatch([makeItem({
				messages: [{ metric: 'x', value: 1, endpoint_uuid: validUuid, endpointUuid: 'not-a-uuid', deviceName: 'Pump 1' }],
			})]);
			const [, params] = mockQuery.mock.calls[0];
			const extra = JSON.parse(params[7]);
			expect(extra.endpoint_uuid).toBe(validUuid);
			expect(extra.device_name).toBe('Pump 1');
		});

		it('derives a stable UUID from a non-UUID device_uuid tag (e.g. OPC-UA "ahu-1"), matching devices.uuid with no DB lookup', async () => {
			// device.model.ts's DeviceModel.syncFromEndpoint() stores devices.uuid as
			// toDeviceUuid(dp.device_uuid) for exactly this case — the plugin must derive
			// the identical value so extra.device_uuid always correlates with the Devices
			// page's UUID column for the same physical device.
			await plugin.publishBatch([makeItem({ messages: [{ metric: 'x', value: 1, device_uuid: 'ahu-1' }] })]);
			const [, params] = mockQuery.mock.calls[0];
			const extra = JSON.parse(params[7]);
			expect(extra.device_uuid).toBe(toDeviceUuid('ahu-1'));
			expect(extra.device_uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
		});

		it('passes through an already-valid device_uuid unchanged', async () => {
			const validUuid = '123e4567-e89b-42d3-a456-426614174000';
			await plugin.publishBatch([makeItem({ messages: [{ metric: 'x', value: 1, device_uuid: validUuid }] })]);
			const [, params] = mockQuery.mock.calls[0];
			const extra = JSON.parse(params[7]);
			expect(extra.device_uuid).toBe(validUuid);
		});

		it('leaves device_uuid null when absent from the message', async () => {
			await plugin.publishBatch([makeItem({ messages: [{ metric: 'x', value: 1 }] })]);
			const [, params] = mockQuery.mock.calls[0];
			const extra = JSON.parse(params[7]);
			expect(extra.device_uuid).toBeNull();
		});

		it('normalizes an OPC-UA style status-code bitmask quality', async () => {
			await plugin.publishBatch([makeItem({ messages: [{ metric: 'x', value: 1, quality: 0x40000000 }] })]);
			const [, params] = mockQuery.mock.calls[0];
			expect(params[4]).toBe('uncertain');
		});
	});

	describe('publishBatch — tags payload mapping', () => {
		let plugin: TimescaleDbPublishPlugin;

		beforeEach(async () => {
			plugin = TimescaleDbPublishPlugin.fromConfig(
				{ host: 'h', database: 'db', user: 'u', password: 'p' }, logger, 'agent-1',
			);
			await plugin.start();
		});

		it('maps node/group into extra and skips error tags', async () => {
			await plugin.publishBatch([makeItem({
				timestamp: 1700000000000,
				node: 'device-a',
				group: 'line1',
				tags: [
					{ name: 'temp', value: 21.5 },
					{ name: 'broken', value: null, error: 'bad read' },
				],
			})]);

			expect(mockQuery).toHaveBeenCalledTimes(1);
			const [, params] = mockQuery.mock.calls[0];
			expect(params[2]).toBe('temp');
			const extra = JSON.parse(params[7]);
			expect(extra.device_name).toBe('device-a');
			expect(extra.group).toBe('line1');
		});

		it('skips tags with non-numeric/non-boolean values and no error', async () => {
			await plugin.publishBatch([makeItem({ tags: [{ name: 'label', value: 'oops' }] })]);
			expect(mockQuery).not.toHaveBeenCalled();
		});
	});

	describe('chunking', () => {
		it('splits inserts across multiple queries at maxRowsPerInsert', async () => {
			const plugin = TimescaleDbPublishPlugin.fromConfig(
				{ host: 'h', database: 'db', user: 'u', password: 'p', maxRowsPerInsert: 2 }, logger, 'agent-1',
			);
			await plugin.start();

			const messages = Array.from({ length: 5 }, (_, i) => ({ metric: `m${i}`, value: i }));
			await plugin.publishBatch([makeItem({ messages })]);

			expect(mockQuery).toHaveBeenCalledTimes(3); // 2 + 2 + 1
		});
	});

	describe('failure propagation (critical for durable-buffer retry)', () => {
		it('rejects publishBatch when the DB write fails, without swallowing the error', async () => {
			const plugin = TimescaleDbPublishPlugin.fromConfig(
				{ host: 'h', database: 'db', user: 'u', password: 'p' }, logger, 'agent-1',
			);
			await plugin.start();

			mockQuery.mockRejectedValueOnce(Object.assign(new Error('relation "readings" does not exist'), { code: '42P01' }));

			await expect(plugin.publishBatch([makeItem({ messages: [{ metric: 'x', value: 1 }] })]))
				.rejects.toThrow('relation "readings" does not exist');
		});

		it('logs and skips a single malformed JSON item without failing the rest of the batch', async () => {
			const plugin = TimescaleDbPublishPlugin.fromConfig(
				{ host: 'h', database: 'db', user: 'u', password: 'p' }, logger, 'agent-1',
			);
			await plugin.start();

			const goodItem = makeItem({ messages: [{ metric: 'x', value: 1 }] });
			const badItem: PublishBatchItem = { topic: 'i/t/a/agent-1/mqtt', payload: 'not-json' };

			await plugin.publishBatch([badItem, goodItem]);

			expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('failed to process batch item'), expect.any(Error));
			expect(mockQuery).toHaveBeenCalledTimes(1);
		});

		it('throws if publishBatch is called before start()', async () => {
			const plugin = TimescaleDbPublishPlugin.fromConfig(
				{ host: 'h', database: 'db', user: 'u', password: 'p' }, logger, 'agent-1',
			);
			await expect(plugin.publishBatch([makeItem({ messages: [] })])).rejects.toThrow('not started');
		});
	});

	describe('lifecycle', () => {
		it('stop() closes the pool and isConnected() reports false afterward', async () => {
			const plugin = TimescaleDbPublishPlugin.fromConfig(
				{ host: 'h', database: 'db', user: 'u', password: 'p' }, logger, 'agent-1',
			);
			await plugin.start();
			expect(plugin.isRunning()).toBe(true);

			await plugin.stop();
			expect(mockEnd).toHaveBeenCalledTimes(1);
			expect(plugin.isRunning()).toBe(false);
			expect(plugin.isConnected()).toBe(false);
		});

		it('isConnected() is true immediately after start (grace period before any write)', async () => {
			const plugin = TimescaleDbPublishPlugin.fromConfig(
				{ host: 'h', database: 'db', user: 'u', password: 'p' }, logger, 'agent-1',
			);
			await plugin.start();
			expect(plugin.isConnected()).toBe(true);
		});

		it('isConnected() goes false once stale after a successful write', async () => {
			jest.useFakeTimers();
			try {
				const plugin = TimescaleDbPublishPlugin.fromConfig(
					{ host: 'h', database: 'db', user: 'u', password: 'p' }, logger, 'agent-1',
				);
				await plugin.start();
				await plugin.publishBatch([makeItem({ messages: [{ metric: 'x', value: 1 }] })]);
				expect(plugin.isConnected()).toBe(true);

				jest.advanceTimersByTime(61000);
				expect(plugin.isConnected()).toBe(false);
			} finally {
				jest.useRealTimers();
			}
		});
	});
});
