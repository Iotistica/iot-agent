import * as net from 'net';
import { EventEmitter } from 'events';
import { SocketPublishClient, SocketPublishPlugin } from '../../../src/publish/plugins/socket';

jest.mock('net', () => {
	const actual = jest.requireActual('events');
	return {
		createConnection: jest.fn(),
	};
});

function makeMockSocket(): net.Socket & EventEmitter {
	const sock = new EventEmitter() as any;
	sock.write = jest.fn().mockReturnValue(true);
	sock.end = jest.fn();
	sock.destroy = jest.fn();
	sock.removeAllListeners = jest.fn().mockReturnThis();
	return sock;
}

describe('SocketPublishClient', () => {
	let mockSocket: ReturnType<typeof makeMockSocket>;

	beforeEach(() => {
		jest.clearAllMocks();
		jest.useFakeTimers();
		mockSocket = makeMockSocket();
		(net.createConnection as jest.Mock).mockReturnValue(mockSocket);
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('connects to the configured socket path', async () => {
		const client = new SocketPublishClient({
			appId: 1, serviceId: 2,
			socketPath: '/run/agent/sockets/1_2/app.sock',
		});

		await client.connect();

		expect(net.createConnection).toHaveBeenCalledWith({
			path: '/run/agent/sockets/1_2/app.sock',
		});
	});

	it('emits connect and sets isConnected on socket connect', async () => {
		const client = new SocketPublishClient({
			appId: 1, serviceId: 2,
			socketPath: '/test.sock',
		});

		const connectPromise = new Promise<void>((resolve) => client.on('connect', resolve));
		await client.connect();
		mockSocket.emit('connect');

		await connectPromise;
		expect(client.isConnected()).toBe(true);
		expect(client.getPublishMode()).toBe('direct');
	});

	it('publish writes ndjson frame to socket', async () => {
		const client = new SocketPublishClient({
			appId: 1, serviceId: 2,
			socketPath: '/test.sock',
		});

		await client.connect();
		mockSocket.emit('connect');

		mockSocket.write.mockImplementation((_data: any, _enc: any, cb: any) => {
			if (typeof cb === 'function') cb();
			return true;
		});

		await client.publish('modbus/temp', 'payload-data');

		expect(mockSocket.write).toHaveBeenCalled();
		const frame = mockSocket.write.mock.calls[0][0];
		expect(frame).toMatch(/\n$/);
		const parsed = JSON.parse(frame.trim());
		expect(parsed.topic).toBe('modbus/temp');
		expect(parsed.data).toBe('payload-data');
		expect(parsed.ts).toBeDefined();
	});

	it('throws when publishing while disconnected', async () => {
		const client = new SocketPublishClient({
			appId: 1, serviceId: 2,
			socketPath: '/test.sock',
		});

		await expect(client.publish('t', 'p')).rejects.toThrow('Socket not connected');
	});

	it('disconnect clears socket and emits disconnect', async () => {
		const client = new SocketPublishClient({
			appId: 1, serviceId: 2,
			socketPath: '/test.sock',
		});

		await client.connect();
		mockSocket.emit('connect');
		expect(client.isConnected()).toBe(true);

		await client.disconnect();
		expect(client.isConnected()).toBe(false);
		expect(mockSocket.end).toHaveBeenCalled();
		expect(mockSocket.destroy).toHaveBeenCalled();
	});

	it('schedules reconnect on socket close', async () => {
		const client = new SocketPublishClient({
			appId: 1, serviceId: 2,
			socketPath: '/test.sock',
		});

		await client.connect();
		mockSocket.emit('connect');

		const newSocket = makeMockSocket();
		(net.createConnection as jest.Mock).mockReturnValue(newSocket);

		mockSocket.emit('close');
		expect(client.isConnected()).toBe(false);

		jest.advanceTimersByTime(600);
		expect(net.createConnection).toHaveBeenCalledTimes(2);
	});

	it('does not reconnect after explicit disconnect', async () => {
		const client = new SocketPublishClient({
			appId: 1, serviceId: 2,
			socketPath: '/test.sock',
		});

		await client.connect();
		mockSocket.emit('connect');
		await client.disconnect();

		jest.advanceTimersByTime(10000);
		expect(net.createConnection).toHaveBeenCalledTimes(1);
	});

	it('treats ENOENT as transient (debug log, no crash)', async () => {
		const logger = { debug: jest.fn(), error: jest.fn(), info: jest.fn() };
		const client = new SocketPublishClient(
			{ appId: 1, serviceId: 2, socketPath: '/test.sock' },
			logger,
		);

		await client.connect();
		const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		mockSocket.emit('error', err);

		expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('ENOENT'));
		expect(logger.error).not.toHaveBeenCalled();
	});

	it('getPublishMode returns recovering when disconnected', () => {
		const client = new SocketPublishClient({
			appId: 1, serviceId: 2,
			socketPath: '/test.sock',
		});

		expect(client.getPublishMode()).toBe('recovering');
	});
});

describe('SocketPublishPlugin', () => {
	it('fromConfig creates a plugin from valid config', () => {
		const plugin = SocketPublishPlugin.fromConfig({
			appId: 1,
			serviceId: 2,
			socketPath: '/run/agent/sockets/1_2/app.sock',
		});

		expect(plugin).toBeDefined();
		expect(plugin.isRunning()).toBe(false);
	});

	it('fromConfig throws for missing socketPath', () => {
		expect(() => SocketPublishPlugin.fromConfig({})).toThrow('socketPath');
	});

	it('fromConfig throws for null config', () => {
		expect(() => SocketPublishPlugin.fromConfig(null)).toThrow('socketPath');
	});
});
