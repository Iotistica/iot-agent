/**
 * Unit tests for MQTT Discovery Plugin
 * Tests core discovery logic without real broker dependencies
 */

import { EventEmitter } from 'events';
import { MqttDiscovery } from '../../../../src/plugins/mqtt/discovery';
import { LogComponents } from '../../../../src/logging/types';

/**
 * Fake MQTT client for testing
 * Extends EventEmitter to simulate mqtt.js event-based API
 */
class FakeMqttClient extends EventEmitter {
  subscribe = jest.fn((topic: string | string[], opts: any, cb?: (err: Error | null) => void) => {
    // Simulate successful subscription
    if (cb) cb(null);
    return this;
  });

  end = jest.fn((force?: boolean, cb?: () => void) => {
    if (cb) cb();
    return this;
  });

  removeAllListeners = jest.fn(() => {
    super.removeAllListeners();
    return this;
  });
}

describe('MqttDiscovery', () => {
  let mockLogger: any;
  let fakeClient: FakeMqttClient;
  let mockFactory: jest.Mock;
  let plugin: MqttDiscovery;

  beforeEach(() => {
    // Mock logger
    mockLogger = {
      debugSync: jest.fn(),
      infoSync: jest.fn(),
      warnSync: jest.fn(),
      errorSync: jest.fn()
    };

    // Create fake MQTT client
    fakeClient = new FakeMqttClient();

    // Mock factory that returns fake client
    mockFactory = jest.fn().mockReturnValue(fakeClient);

    // Create plugin with mocked dependencies
    plugin = new MqttDiscovery(mockLogger, mockFactory);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('inferDataType', () => {
    it('should detect number from plain numeric string', () => {
      const plugin = new MqttDiscovery();
      // Access private method using bracket notation
      const result = (plugin as any).inferDataType('42');
      expect(result).toBe('number');
    });

    it('should detect number from decimal string', () => {
      const plugin = new MqttDiscovery();
      const result = (plugin as any).inferDataType('12.5');
      expect(result).toBe('number');
    });

    it('should detect number with whitespace', () => {
      const plugin = new MqttDiscovery();
      const result = (plugin as any).inferDataType(' 42 ');
      expect(result).toBe('number');
    });

    it('should detect negative numbers', () => {
      const plugin = new MqttDiscovery();
      const result = (plugin as any).inferDataType('-123.45');
      expect(result).toBe('number');
    });

    it('should detect boolean true', () => {
      const plugin = new MqttDiscovery();
      const result = (plugin as any).inferDataType('true');
      expect(result).toBe('boolean');
    });

    it('should detect boolean false', () => {
      const plugin = new MqttDiscovery();
      const result = (plugin as any).inferDataType('false');
      expect(result).toBe('boolean');
    });

    it('should detect boolean case-insensitive', () => {
      const plugin = new MqttDiscovery();
      expect((plugin as any).inferDataType('TRUE')).toBe('boolean');
      expect((plugin as any).inferDataType('False')).toBe('boolean');
    });

    it('should treat NaN as string', () => {
      const plugin = new MqttDiscovery();
      const result = (plugin as any).inferDataType('NaN');
      expect(result).toBe('string');
    });

    it('should treat Infinity as string', () => {
      const plugin = new MqttDiscovery();
      const result = (plugin as any).inferDataType('Infinity');
      expect(result).toBe('string');
    });

    it('should treat leading zeros as number', () => {
      const plugin = new MqttDiscovery();
      // Based on regex ^-?\d+(\.\d+)?$ this should match
      const result = (plugin as any).inferDataType('00123');
      expect(result).toBe('number');
    });

    it('should detect JSON object', () => {
      const plugin = new MqttDiscovery();
      const result = (plugin as any).inferDataType('{"a":1}');
      expect(result).toBe('json');
    });

    it('should detect JSON array', () => {
      const plugin = new MqttDiscovery();
      const result = (plugin as any).inferDataType('[1,2,3]');
      expect(result).toBe('json');
    });

    it('should detect JSON number', () => {
      const plugin = new MqttDiscovery();
      const result = (plugin as any).inferDataType('42');
      expect(result).toBe('number'); // Valid JSON number
    });

    it('should detect JSON boolean', () => {
      const plugin = new MqttDiscovery();
      const result = (plugin as any).inferDataType('true');
      expect(result).toBe('boolean'); // Valid JSON boolean
    });

    it('should treat plain text as string', () => {
      const plugin = new MqttDiscovery();
      const result = (plugin as any).inferDataType('hello world');
      expect(result).toBe('string');
    });

    it('should treat empty string as string', () => {
      const plugin = new MqttDiscovery();
      const result = (plugin as any).inferDataType('');
      expect(result).toBe('string');
    });
  });

  describe('handleMessage', () => {
    it('should track first message received', () => {
      const plugin = new MqttDiscovery();
      const validatedTopics = (plugin as any).validatedTopics;

      (plugin as any).handleMessage('test/topic', '42', false);

      const validation = validatedTopics.get('test/topic');
      expect(validation).toBeDefined();
      expect(validation.messagesReceived).toBe(1);
      expect(validation.firstSeen).toBeInstanceOf(Date);
      expect(validation.firstPayload).toBe('42');
    });

    it('should detect retained message', () => {
      const plugin = new MqttDiscovery();
      const validatedTopics = (plugin as any).validatedTopics;

      (plugin as any).handleMessage('test/topic', '42', true);

      const validation = validatedTopics.get('test/topic');
      expect(validation.hasRetained).toBe(true);
      expect(validation.retainedMessagesReceived).toBe(1);
      expect(validation.hasLive).toBe(false);
    });

    it('should detect live message', () => {
      const plugin = new MqttDiscovery();
      const validatedTopics = (plugin as any).validatedTopics;

      (plugin as any).handleMessage('test/topic', '42', false);

      const validation = validatedTopics.get('test/topic');
      expect(validation.hasLive).toBe(true);
      expect(validation.hasRetained).toBe(false);
      expect(validation.retainedMessagesReceived).toBe(0);
    });

    it('should increment message count', () => {
      const plugin = new MqttDiscovery();
      const validatedTopics = (plugin as any).validatedTopics;

      (plugin as any).handleMessage('test/topic', '1', false);
      (plugin as any).handleMessage('test/topic', '2', false);
      (plugin as any).handleMessage('test/topic', '3', false);

      const validation = validatedTopics.get('test/topic');
      expect(validation.messagesReceived).toBe(3);
    });

    it('should update lastSeen on each message', () => {
      jest.useFakeTimers();
      try {
        const plugin = new MqttDiscovery();
        const validatedTopics = (plugin as any).validatedTopics;

        (plugin as any).handleMessage('test/topic', '1', false);
        const firstSeen = validatedTopics.get('test/topic').lastSeen;

        // Wait a bit
        jest.advanceTimersByTime(100);

        (plugin as any).handleMessage('test/topic', '2', false);
        const secondSeen = validatedTopics.get('test/topic').lastSeen;

        expect(secondSeen).not.toEqual(firstSeen);
      } finally {
        jest.useRealTimers();
      }
    });

    it('should handle both retained and live messages', () => {
      const plugin = new MqttDiscovery();
      const validatedTopics = (plugin as any).validatedTopics;

      (plugin as any).handleMessage('test/topic', '1', true);  // Retained
      (plugin as any).handleMessage('test/topic', '2', false); // Live

      const validation = validatedTopics.get('test/topic');
      expect(validation.hasRetained).toBe(true);
      expect(validation.hasLive).toBe(true);
      expect(validation.retainedMessagesReceived).toBe(1);
      expect(validation.messagesReceived).toBe(2);
    });

    it('should preserve first payload across messages', () => {
      const plugin = new MqttDiscovery();
      const validatedTopics = (plugin as any).validatedTopics;

      (plugin as any).handleMessage('test/topic', 'first', false);
      (plugin as any).handleMessage('test/topic', 'second', false);
      (plugin as any).handleMessage('test/topic', 'third', false);

      const validation = validatedTopics.get('test/topic');
      expect(validation.firstPayload).toBe('first');
      expect(validation.messagesReceived).toBe(3);
    });
  });

  describe('groupTopicsIntoDevices', () => {
    function makeValidation(topic: string, payload = '42'): any {
      return {
        topic,
        messagesReceived: 5,
        retainedMessagesReceived: 0,
        firstPayload: payload,
        firstSeen: new Date(),
        lastSeen: new Date(),
        hasLive: true,
        hasRetained: false,
      };
    }

    it('should group hierarchical topics sharing common sub-topic names into devices', () => {
      const plugin = new MqttDiscovery();
      const topics = [
        makeValidation('factory/sim-001/telemetry'),
        makeValidation('factory/sim-001/status'),
        makeValidation('factory/sim-002/telemetry'),
        makeValidation('factory/sim-002/status'),
      ];

      const groups = (plugin as any).groupTopicsIntoDevices(topics);

      expect(groups).toHaveLength(2);
      const baseTopics = groups.map((g: any) => g.baseTopic).sort();
      expect(baseTopics).toEqual(['factory/sim-001', 'factory/sim-002']);

      const sim001 = groups.find((g: any) => g.baseTopic === 'factory/sim-001');
      expect(sim001.dataPointTopics.size).toBe(2);
      expect(sim001.dataPointTopics.has('telemetry')).toBe(true);
      expect(sim001.dataPointTopics.has('status')).toBe(true);
    });

    it('should keep flat topics as individual devices', () => {
      const plugin = new MqttDiscovery();
      const topics = [
        makeValidation('temperature'),
        makeValidation('humidity'),
      ];

      const groups = (plugin as any).groupTopicsIntoDevices(topics);

      expect(groups).toHaveLength(2);
      expect(groups[0].baseTopic).toBe('temperature');
      expect(groups[1].baseTopic).toBe('humidity');
    });

    it('should strip last segment for deep topics (penultimate-segment fallback)', () => {
      const plugin = new MqttDiscovery();
      const topics = [
        makeValidation('building/floor1/sensor'),
      ];

      const groups = (plugin as any).groupTopicsIntoDevices(topics);

      expect(groups).toHaveLength(1);
      expect(groups[0].baseTopic).toBe('building/floor1');
      expect(groups[0].dataPointTopics.has('sensor')).toBe(true);
    });

    it('should group single-device sub-topics under one device', () => {
      const plugin = new MqttDiscovery();
      const topics = [
        makeValidation('factory/sim-001/telemetry'),
        makeValidation('factory/sim-001/status'),
      ];

      const groups = (plugin as any).groupTopicsIntoDevices(topics);

      expect(groups).toHaveLength(1);
      expect(groups[0].baseTopic).toBe('factory/sim-001');
      expect(groups[0].dataPointTopics.size).toBe(2);
      expect(groups[0].dataPointTopics.has('telemetry')).toBe(true);
      expect(groups[0].dataPointTopics.has('status')).toBe(true);
    });

    it('should use topicPattern when provided', () => {
      const plugin = new MqttDiscovery();
      const topics = [
        makeValidation('factory/sim-001/telemetry'),
        makeValidation('factory/sim-001/status'),
        makeValidation('factory/sim-002/telemetry'),
      ];

      const groups = (plugin as any).groupTopicsIntoDevices(topics, 'factory/{deviceId}/+');

      expect(groups).toHaveLength(2);
      const sim001 = groups.find((g: any) => g.baseTopic === 'factory/sim-001');
      expect(sim001).toBeDefined();
      expect(sim001.deviceId).toBe('sim-001');
      expect(sim001.dataPointTopics.has('telemetry')).toBe(true);
    });

    it('should return empty array for no topics', () => {
      const plugin = new MqttDiscovery();
      const groups = (plugin as any).groupTopicsIntoDevices([]);
      expect(groups).toEqual([]);
    });
  });

  describe('convertGroupsToDevices', () => {
    function makeGroup(baseTopic: string, subTopics: string[]): any {
      const dataPointTopics = new Map();
      for (const sub of subTopics) {
        dataPointTopics.set(sub, {
          topic: `${baseTopic}/${sub}`,
          messagesReceived: 5,
          retainedMessagesReceived: 0,
          firstPayload: JSON.stringify({ value: 42 }),
          firstSeen: new Date('2026-11-01T00:00:00Z'),
          lastSeen: new Date('2026-11-01T00:01:00Z'),
          hasLive: true,
          hasRetained: false,
        });
      }
      return {
        deviceId: baseTopic.split('/').pop(),
        baseTopic,
        dataPointTopics,
      };
    }

    it('should generate stable fingerprint from baseTopic', () => {
      const plugin = new MqttDiscovery();
      const groups = [makeGroup('factory/sim-001', ['telemetry'])];

      const devices = (plugin as any).convertGroupsToDevices(groups);

      expect(devices).toHaveLength(1);
      expect(devices[0].fingerprint).toBeDefined();
      expect(devices[0].fingerprint).toHaveLength(32);

      const devices2 = (plugin as any).convertGroupsToDevices(groups);
      expect(devices2[0].fingerprint).toBe(devices[0].fingerprint);
    });

    it('should truncate long base topic names', () => {
      const plugin = new MqttDiscovery();
      const longBase = 'a/'.repeat(50) + 'device';
      const groups = [makeGroup(longBase, ['value'])];

      const devices = (plugin as any).convertGroupsToDevices(groups);

      expect(devices[0].name).toMatch(/^mqtt_\.\.\./);
      expect(devices[0].name.length).toBeLessThanOrEqual(63);
    });

    it('should set connection.baseTopic and connection.autoMetrics', () => {
      const plugin = new MqttDiscovery();
      const groups = [makeGroup('factory/sim-001', ['telemetry', 'status'])];

      const devices = (plugin as any).convertGroupsToDevices(groups);

      expect(devices[0].connection.baseTopic).toBe('factory/sim-001');
      expect(devices[0].connection.autoMetrics).toBe(true);
    });

    it('should populate dataPoints from sub-topics', () => {
      const plugin = new MqttDiscovery();
      const groups = [makeGroup('factory/sim-001', ['telemetry', 'status'])];

      const devices = (plugin as any).convertGroupsToDevices(groups);

      expect(devices[0].dataPoints).toHaveLength(2);
      const subTopics = devices[0].dataPoints.map((dp: any) => dp.subTopic);
      expect(subTopics).toContain('telemetry');
      expect(subTopics).toContain('status');
    });

    it('should include sampleFields for JSON payloads', () => {
      const plugin = new MqttDiscovery();
      const group = makeGroup('device', ['temp']);
      group.dataPointTopics.get('temp').firstPayload = JSON.stringify({
        temperature: 23.5,
        humidity: 65,
        units: { temperature: 'C' },
      });

      const devices = (plugin as any).convertGroupsToDevices([group]);

      const dp = devices[0].dataPoints[0];
      expect(dp.sampleFields).toContain('temperature');
      expect(dp.sampleFields).toContain('humidity');
    });

    it('should set protocol to mqtt, confidence to high, validated to false', () => {
      const plugin = new MqttDiscovery();
      const groups = [makeGroup('test/device', ['value'])];

      const devices = (plugin as any).convertGroupsToDevices(groups);

      expect(devices[0].protocol).toBe('mqtt');
      expect(devices[0].confidence).toBe('high');
      expect(devices[0].validated).toBe(false);
    });

    it('should include discoveredAt timestamp from earliest seen topic', () => {
      const plugin = new MqttDiscovery();
      const group = makeGroup('test/device', ['value']);
      const earlyDate = new Date('2026-10-01T00:00:00Z');
      group.dataPointTopics.get('value').firstSeen = earlyDate;

      const devices = (plugin as any).convertGroupsToDevices([group]);

      expect(devices[0].discoveredAt).toBeDefined();
      expect(new Date(devices[0].discoveredAt).getTime()).toBe(earlyDate.getTime());
    });
  });

  describe('discover', () => {
    it('should return empty array when no topics provided', async () => {
      const plugin = new MqttDiscovery(mockLogger, mockFactory);
      
      const result = await plugin.discover({ 
        brokerUrl: 'mqtt://test:1883',
        topics: []
      });

      expect(result).toEqual([]);
      expect(mockLogger.warnSync).toHaveBeenCalledWith(
        expect.stringContaining('No topics provided'),
        expect.any(Object)
      );
    });

    it('should use mqtt factory to create client', async () => {
      const plugin = new MqttDiscovery(mockLogger, mockFactory);

      // Simulate connection immediately
      setTimeout(() => {
        fakeClient.emit('connect');
      }, 10);

      const promise = plugin.discover({
        brokerUrl: 'mqtt://test:1883',
        topics: ['test/topic'],
        samplingDurationMs: 100
      });

      // Simulate message after connection
      setTimeout(() => {
        fakeClient.emit('message', 'test/topic', Buffer.from('42'), { retain: false });
      }, 20);

      await promise;

      expect(mockFactory).toHaveBeenCalledWith(
        'mqtt://test:1883',
        expect.objectContaining({
          clientId: expect.stringContaining('iotistic-discovery-'),
          clean: true,
          reconnectPeriod: 0
        })
      );
    });

    it('should pass authentication options to client', async () => {
      const plugin = new MqttDiscovery(mockLogger, mockFactory);

      setTimeout(() => fakeClient.emit('connect'), 10);

      const promise = plugin.discover({
        brokerUrl: 'mqtt://test:1883',
        topics: ['test/topic'],
        username: 'user',
        password: 'pass',
        samplingDurationMs: 100
      });

      setTimeout(() => {
        fakeClient.emit('message', 'test/topic', Buffer.from('42'), { retain: false });
      }, 20);

      await promise;

      expect(mockFactory).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          username: 'user',
          password: 'pass'
        })
      );
    });

    it('should propagate connection errors after cleaning up the client', async () => {
      const plugin = new MqttDiscovery(mockLogger, mockFactory);
      const connectionError = new Error('Connection refused');
      const promise = plugin.discover({
        brokerUrl: 'mqtt://test:1883',
        topics: ['test/topic']
      });

      setTimeout(() => fakeClient.emit('error', connectionError), 10);

      await expect(promise).rejects.toBe(connectionError);

      expect(fakeClient.end).toHaveBeenCalledWith(true);
      expect(mockLogger.errorSync).toHaveBeenCalledWith(
        'MQTT discovery failed',
        connectionError,
        expect.objectContaining({ component: expect.any(String) })
      );
    });
  });

  describe('isAvailable', () => {
    it('should return true (MQTT always available)', async () => {
      const plugin = new MqttDiscovery();
      const result = await plugin.isAvailable();
      expect(result).toBe(true);
    });
  });
});
