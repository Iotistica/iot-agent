import { DiscoveryService } from '../../../src/discovery/service';
import { ModbusDiscovery } from '../../../src/plugins/modbus/discovery';
import { BACnetDiscovery } from '../../../src/plugins/bacnet/discovery';
import { EventEmitter } from 'events';

describe('DiscoveryService', () => {
  it('propagates protocol scan errors when failOnError is enabled', async () => {
    const failure = new Error('MQTT broker unavailable');
    const logger = {
      debugSync: jest.fn(),
      errorSync: jest.fn(),
    } as any;
    const service = new DiscoveryService(logger);
    const mqttPlugin = {
      isAvailable: jest.fn().mockResolvedValue(true),
      discover: jest.fn().mockRejectedValue(failure),
    };
    (service as any).plugins.set('mqtt', mqttPlugin);

    await expect(service.runDiscovery({
      trigger: 'manual',
      protocols: ['mqtt'],
      forceRun: true,
      failOnError: true,
      optionOverrides: { mqtt: { brokerUrl: 'mqtt://broker', topics: ['devices/#'] } },
    })).rejects.toBe(failure);

    expect(logger.errorSync).toHaveBeenCalledWith(
      'Discovery failed for protocol mqtt',
      failure,
      expect.objectContaining({ component: expect.any(String), traceId: expect.any(String) }),
    );
    expect(service.isDiscoveryRunning()).toBe(false);
  });

  describe('protocol scan status', () => {
    it.each(['failed', 'partial'] as const)('reports a %s Modbus scan conservatively', async mode => {
      const config = {
        getDiscoveryTargets: () => [{
          name: 'bus',
          connection: { type: 'tcp', host: '127.0.0.1', slaveRange: { start: 1, end: 2 } },
          dataPoints: [],
        }],
      };
      const plugin = new ModbusDiscovery(undefined, config as any);
      jest.spyOn(plugin as any, 'openConnection').mockResolvedValue(
        mode === 'failed' ? undefined : { isOpen: true, type: 'tcp' },
      );
      jest.spyOn(plugin as any, 'testSlaveId').mockImplementation(async (_connection, slaveId) =>
        slaveId === 1 ? { name: 'one', method: 'test' } : null,
      );
      jest.spyOn(plugin as any, 'closeConnection').mockResolvedValue(undefined);
      const result = await plugin.discover();
      expect(result).toHaveLength(mode === 'failed' ? 0 : 1);
      expect(result.scanStatus).toEqual({
        successful: mode !== 'failed', complete: false, authoritative: false,
      });
    });

    it.each(['failed', 'partial'] as const)('reports a %s BACnet scan conservatively', async mode => {
      const client = new EventEmitter() as EventEmitter & { whoIs: () => void };
      client.whoIs = () => {
        if (mode === 'failed') throw new Error('Who-Is failed');
        client.emit('iAm', { deviceId: 1, address: '127.0.0.1:47808', vendorId: 1 });
        client.emit('iAm', { deviceId: 2, address: '127.0.0.2:47808', vendorId: 1 });
      };
      const plugin = new BACnetDiscovery();
      jest.spyOn(plugin as any, 'getClient').mockResolvedValue(client);
      jest.spyOn(plugin as any, 'readProperty').mockResolvedValue(undefined);
      const result = await plugin.discover({
        discoveryTargets: ['127.0.0.1'], timeout: 1, maxDevices: 1,
      });
      expect(result).toHaveLength(mode === 'failed' ? 0 : 1);
      expect(result.scanStatus).toEqual({
        successful: mode !== 'failed', complete: false, authoritative: false,
      });
    });
  });
});
