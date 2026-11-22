import { EventEmitter } from 'events';
import { SocketServer } from '../../../src/core/socket-server';
import { SocketOutput } from '../../../src/plugins/types';

/** Minimal net.Socket-like stub for exercising sendToSocket()'s backpressure
 *  handling without a real OS socket — write()/destroy() are jest.fn()s,
 *  'drain' is a real EventEmitter event so socket.once('drain', ...) works. */
function makeFakeSocket(writeReturns: boolean, writableLength = 0) {
  const socket = new EventEmitter() as any;
  socket.write = jest.fn().mockReturnValue(writeReturns);
  socket.destroy = jest.fn();
  socket.writableLength = writableLength;
  return socket;
}

describe('SocketServer', () => {
  let mockLogger: any;
  let config: SocketOutput;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    config = {
      socketPath: '\\\\.\\pipe\\test-sensor-socket',
      dataFormat: 'json',
      delimiter: '\n',
      includeTimestamp: true,
      includeDeviceName: true
    };
  });

  it('should create socket server instance', () => {
    const server = new SocketServer(config, mockLogger);
    expect(server).toBeDefined();
  });

  it('should not be running initially', () => {
    const server = new SocketServer(config, mockLogger);
    expect(server.isRunning()).toBe(false);
  });

  it('should have zero clients initially', () => {
    const server = new SocketServer(config, mockLogger);
    expect(server.getClientCount()).toBe(0);
  });

  it('preserves display-only device names in single and batched readings', () => {
    const server = new SocketServer(config, mockLogger);
    const point = {
      deviceName: 'source-uuid', deviceDisplayName: 'plc-001',
      metric: 'temperature', value: 25, timestamp: '2026-01-01T00:00:00Z', quality: 'GOOD' as const,
    };
    const format = Reflect.get(server, 'formatAsJson').bind(server);
    expect(JSON.parse(format([point]))).toEqual(expect.objectContaining({ deviceName: 'source-uuid', deviceDisplayName: 'plc-001' }));
    expect(JSON.parse(format([point, point])).readings).toEqual([
      expect.objectContaining({ deviceDisplayName: 'plc-001' }),
      expect.objectContaining({ deviceDisplayName: 'plc-001' }),
    ]);
  });

  it('keeps verified point UUIDs in JSON without changing CSV fields', () => {
    const server = new SocketServer(config, mockLogger);
    const point = {
      deviceName: 'plc', metric: 'power', value: 25, timestamp: '2026-01-01T00:00:00Z',
      quality: 'GOOD' as const, protocol: 'opcua', pointUuid: 'permanent-point-uuid',
    };
    const json = Reflect.get(server, 'formatAsJson').bind(server);
    const csv = Reflect.get(server, 'formatAsCsv').bind(server);
    expect(JSON.parse(json([point]))).toMatchObject({ metric: 'power', pointUuid: 'permanent-point-uuid' });
    const { pointUuid: _pointUuid, ...withoutUuid } = point;
    expect(csv([point])).toBe(csv([withoutUuid]));
  });

  it('should not send data when not started', () => {
    const server = new SocketServer(config, mockLogger);
    const dataPoints = [{
      deviceName: 'test',
      metric: 'temp',
      value: 25,
      unit: 'C',
      timestamp: new Date().toISOString(),
      quality: 'GOOD' as const
    }];

    server.sendData(dataPoints);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('should not send a control message when not started', () => {
    const server = new SocketServer(config, mockLogger);
    server.sendControl({ __control: 'device-schema', deviceName: 'AHU-1', fields: ['cc_valve'] });
    // A TEMPORARY [SCHEMA_DECLARE_DIAG] warn is expected here while
    // investigating issue #17 — remove this exception once that's resolved.
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  describe('sendToSocket backpressure handling', () => {
    it('writes succeed and register in sentTo when writableLength is under the cap', () => {
      const server = new SocketServer(config, mockLogger);
      const socket = makeFakeSocket(true, 0);
      const sentTo = new Set<any>();

      const sent = (server as any).sendToSocket(socket, 'data\n', 'opcua', sentTo);

      expect(sent).toBe(true);
      expect(sentTo.has(socket)).toBe(true);
      expect(socket.write).toHaveBeenCalledWith('data\n');
    });

    it('skips the write when socket.writableLength exceeds MAX_WRITE_QUEUE_BYTES', () => {
      const server = new SocketServer(config, mockLogger);
      const socket = makeFakeSocket(true, 33 * 1024 * 1024); // 33MB > 32MB cap

      const sent = (server as any).sendToSocket(socket, 'data\n', 'opcua', new Set());

      expect(sent).toBe(false);
      expect(socket.write).not.toHaveBeenCalled();
    });

    it('writes proceed when writableLength is just under the cap', () => {
      const server = new SocketServer(config, mockLogger);
      const socket = makeFakeSocket(true, 31 * 1024 * 1024); // 31MB < 32MB cap

      const sent = (server as any).sendToSocket(socket, 'data\n', 'opcua', new Set());

      expect(sent).toBe(true);
      expect(socket.write).toHaveBeenCalled();
    });

    it('backpressured write (write returns false) does not remove the client', () => {
      const server = new SocketServer(config, mockLogger);
      const removeClientSpy = jest.spyOn(server as any, 'removeClient');
      const socket = makeFakeSocket(false, 0);

      const sent = (server as any).sendToSocket(socket, 'data\n', 'opcua', new Set());

      expect(sent).toBe(true); // write() was called, data accepted by Node
      expect(removeClientSpy).not.toHaveBeenCalled();
    });

    it('logs backpressure warning at most once per 10s when writes are skipped', () => {
      const server = new SocketServer(config, mockLogger);
      const socket = makeFakeSocket(true, 33 * 1024 * 1024);

      (server as any).sendToSocket(socket, 'a\n', 'opcua', new Set());
      (server as any).sendToSocket(socket, 'b\n', 'opcua', new Set());
      (server as any).sendToSocket(socket, 'c\n', 'opcua', new Set());

      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn.mock.calls[0][0]).toContain('write queue full');
    });
  });
});
