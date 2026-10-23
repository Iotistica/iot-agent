import { DiscoveryService } from '../../../src/discovery/service';

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
});
