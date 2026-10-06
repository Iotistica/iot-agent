import { EventEmitter } from 'events';
import { SocketServer } from '../../../src/core/socket-server';
import { SocketOutput } from '../../../src/plugins/types';

/** Minimal net.Socket-like stub for exercising sendToSocket()'s backpressure
 *  handling without a real OS socket — write()/destroy() are jest.fn()s,
 *  'drain' is a real EventEmitter event so socket.once('drain', ...) works. */
function makeFakeSocket(writeReturns: boolean) {
  const socket = new EventEmitter() as any;
  socket.write = jest.fn().mockReturnValue(writeReturns);
  socket.destroy = jest.fn();
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

  // Regression coverage for the fix to a real production bug: write() returning
  // false (kernel buffer full — normal for a large payload like an OPC-UA
  // batch) used to be counted as a "failure" and the socket destroyed after 4
  // such events, discarding whatever was still mid-write and corrupting the
  // message for the client (observed live as "JSON parse failed for
  // 'opcua-pipe'" immediately after "Removing IPC client (persistent
  // backpressure...)"). Now it waits for the kernel's own 'drain' event and
  // only removes a socket that never drains within DRAIN_TIMEOUT_MS.
  describe('sendToSocket backpressure handling', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('a single backpressured write (write() returns false) does not remove the client', () => {
      const server = new SocketServer(config, mockLogger);
      const removeClientSpy = jest.spyOn(server as any, 'removeClient');
      const socket = makeFakeSocket(false);
      const sentTo = new Set<any>();

      const sent = (server as any).sendToSocket(socket, 'data\n', 'opcua', sentTo);

      expect(sent).toBe(false);
      expect(removeClientSpy).not.toHaveBeenCalled();
      expect(sentTo.has(socket)).toBe(false);
    });

    it('does not remove the client if it drains before the timeout', () => {
      const server = new SocketServer(config, mockLogger);
      const removeClientSpy = jest.spyOn(server as any, 'removeClient');
      const socket = makeFakeSocket(false);

      (server as any).sendToSocket(socket, 'data\n', 'opcua', new Set());

      jest.advanceTimersByTime(1000);
      socket.emit('drain');
      jest.advanceTimersByTime(10_000); // well past DRAIN_TIMEOUT_MS

      expect(removeClientSpy).not.toHaveBeenCalled();
    });

    it('removes the client only after it fails to drain within DRAIN_TIMEOUT_MS', () => {
      const server = new SocketServer(config, mockLogger);
      const removeClientSpy = jest.spyOn(server as any, 'removeClient');
      const socket = makeFakeSocket(false);

      (server as any).sendToSocket(socket, 'data\n', 'opcua', new Set());

      jest.advanceTimersByTime(4999);
      expect(removeClientSpy).not.toHaveBeenCalled();

      jest.advanceTimersByTime(2);
      expect(removeClientSpy).toHaveBeenCalledWith(socket);
    });

    it('a second backpressured write while already waiting does not reset or duplicate the removal timer', () => {
      const server = new SocketServer(config, mockLogger);
      const removeClientSpy = jest.spyOn(server as any, 'removeClient');
      const socket = makeFakeSocket(false);

      (server as any).sendToSocket(socket, 'first\n', 'opcua', new Set());
      jest.advanceTimersByTime(4000);
      (server as any).sendToSocket(socket, 'second\n', 'opcua', new Set()); // still backpressured

      // If this second call had started a fresh timer, the client would
      // survive past the original 5000ms deadline — it must not.
      jest.advanceTimersByTime(1000);
      expect(removeClientSpy).toHaveBeenCalledTimes(1);
    });

    it('a successful write (write() returns true) sends immediately with no timer', () => {
      const server = new SocketServer(config, mockLogger);
      const socket = makeFakeSocket(true);
      const sentTo = new Set<any>();

      const sent = (server as any).sendToSocket(socket, 'data\n', 'opcua', sentTo);

      expect(sent).toBe(true);
      expect(sentTo.has(socket)).toBe(true);
      jest.advanceTimersByTime(10_000);
      expect(socket.destroy).not.toHaveBeenCalled();
    });
  });
});
