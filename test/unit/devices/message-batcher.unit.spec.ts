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
