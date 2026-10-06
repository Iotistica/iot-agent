import { MessageBatcher } from '../../../src/publish/core/batch';
import type { DeviceConfig } from '../../../src/publish/core/types';

describe('MessageBatcher control-frame routing', () => {
  function makeConfig(): DeviceConfig {
    return {
      name: 'opcua-pipe',
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
    };
  }

  it('routes a "device-schema" control frame out-of-band instead of into the message batch', () => {
    const batcher = new MessageBatcher(makeConfig(), 1000, 1024 * 1024);
    const received: unknown[] = [];
    batcher.on('device-schema', (payload) => received.push(payload));

    const controlFrame = { __control: 'device-schema', deviceName: 'AHU-1', fields: ['cc_valve', 'hc_valve'] };
    batcher.appendData(Buffer.from(JSON.stringify(controlFrame) + '\n', 'utf8'));

    expect(received).toEqual([controlFrame]);
    expect(batcher.messageCount).toBe(0); // must NOT be treated as a data reading
  });

  it('still treats an ordinary reading as a normal data message', () => {
    const batcher = new MessageBatcher(makeConfig(), 1000, 1024 * 1024);
    const received: unknown[] = [];
    batcher.on('device-schema', (payload) => received.push(payload));

    const reading = { deviceName: 'AHU-1', metric: 'cc_valve', value: 22, timestamp: new Date().toISOString() };
    batcher.appendData(Buffer.from(JSON.stringify(reading) + '\n', 'utf8'));

    expect(received).toEqual([]);
    expect(batcher.messageCount).toBe(1);
    expect(batcher.messages[0]).toEqual(reading);
  });
});

// Regression coverage for a real production bug: when the underlying IPC
// connection drops mid-message (e.g. src/core/socket-server.ts's backpressure
// handling destroying a socket), the partial bytes already received sat in
// readBuffer forever — nothing cleared it. On reconnect, the next complete
// message's bytes got appended onto that stale partial fragment, and the
// first delimiter found terminated a "frame" that was actually
// [stale partial message][fragment of the new message] — which fails to
// parse as JSON (observed live as "JSON parse failed for 'opcua-pipe':
// Expected ',' or '}' after property value...").
describe('MessageBatcher.resetReadBuffer()', () => {
  function makeConfig(): DeviceConfig {
    return {
      name: 'opcua-pipe',
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
    };
  }

  it('demonstrates the bug: a partial frame left over from a dropped connection corrupts the next message if never cleared', () => {
    const batcher = new MessageBatcher(makeConfig(), 1000, 1024 * 1024);

    // A connection dropped mid-message: a frame with no trailing delimiter
    // stays buffered, incomplete — exactly as it would after a destroyed
    // socket cut it off mid-write.
    const partialFrame = '{"deviceName":"AHU-1","metric":"cc_valve","value":22';
    batcher.appendData(Buffer.from(partialFrame, 'utf8'));
    expect(batcher.messageCount).toBe(0); // correctly still buffered, not yet parsed

    // Reconnect happens, a fresh complete message arrives — without a
    // readBuffer reset, it gets appended onto the stale partial bytes.
    const freshReading = { deviceName: 'AHU-1', metric: 'room_temp', value: 21.5 };
    batcher.appendData(Buffer.from(JSON.stringify(freshReading) + '\n', 'utf8'));

    // The concatenation is not valid JSON — the reading is silently lost.
    expect(batcher.messageCount).toBe(0);
  });

  it('fix: resetReadBuffer() clears the stale partial frame, so the next message after reconnect parses correctly', () => {
    const batcher = new MessageBatcher(makeConfig(), 1000, 1024 * 1024);

    const partialFrame = '{"deviceName":"AHU-1","metric":"cc_valve","value":22';
    batcher.appendData(Buffer.from(partialFrame, 'utf8'));
    expect(batcher.messageCount).toBe(0);

    // The disconnect handler now calls this before the next connection's
    // data starts flowing (src/publish/core/manager.ts's onDisconnected).
    batcher.resetReadBuffer();

    const freshReading = { deviceName: 'AHU-1', metric: 'room_temp', value: 21.5 };
    batcher.appendData(Buffer.from(JSON.stringify(freshReading) + '\n', 'utf8'));

    expect(batcher.messageCount).toBe(1);
    expect(batcher.messages[0]).toEqual(freshReading);
  });

  it('does not affect already-parsed messages in the batch (distinct from reset())', () => {
    const batcher = new MessageBatcher(makeConfig(), 1000, 1024 * 1024);

    const reading = { deviceName: 'AHU-1', metric: 'room_temp', value: 21.5 };
    batcher.appendData(Buffer.from(JSON.stringify(reading) + '\n', 'utf8'));
    expect(batcher.messageCount).toBe(1);

    batcher.resetReadBuffer();

    expect(batcher.messageCount).toBe(1); // untouched — only reset() clears parsed messages
    expect(batcher.messages[0]).toEqual(reading);
  });
});
