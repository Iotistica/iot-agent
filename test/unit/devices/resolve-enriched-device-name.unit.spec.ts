import { resolveEnrichedDeviceName, groupFieldNamesByOwningDevice } from '../../../src/plugins/index';
import { toDeviceUuid } from '../../../src/db/models/device.model';

describe('resolveEnrichedDeviceName', () => {
  it('canonicalizes a source-provided device_uuid through the same toDeviceUuid() conversion DeviceModel.syncFromEndpoint() uses', () => {
    // Identity agreement: a reading's device_uuid must always match what the
    // `devices` table stores as its own uuid column for the same physical
    // device (device.model.ts's syncFromEndpoint() calls toDeviceUuid() on
    // the exact same raw tag) — otherwise telemetry and the Devices admin
    // page would silently diverge on what a device's UUID even is.
    const rawTag = 'meter-1';
    const resolved = resolveEnrichedDeviceName('Meter-1', undefined, rawTag, new Map());

    expect(resolved?.device_uuid).toBe(toDeviceUuid(rawTag));
  });

  it('enriches from source-provided identity even when the endpoint map is empty', () => {
    // This is the exact condition protected by removing
    // enrichWithEndpointUuid()'s `endpointUuidByName.size === 0` guard —
    // endpoint-map availability must not gate source-provided identity.
    const resolved = resolveEnrichedDeviceName('Meter-1', undefined, 'meter-1', new Map());

    expect(resolved).toBeDefined();
    expect(resolved?.device_uuid).toBe(toDeviceUuid('meter-1'));
    expect(resolved?.endpoint_uuid).toBeUndefined();
  });

  it('is unaffected for protocols with no source-provided device identity (BACnet/Modbus shape): uses the endpoint UUID for both fields', () => {
    const endpointUuidByName = new Map([['RTU-1 Controller', 'ep-uuid-1234']]);

    const resolved = resolveEnrichedDeviceName('RTU-1 Controller', undefined, undefined, endpointUuidByName);

    expect(resolved?.device_uuid).toBe('ep-uuid-1234');
    expect(resolved?.endpoint_uuid).toBe('ep-uuid-1234');
  });

  it('returns undefined when there is neither a source-provided device identity nor an endpoint UUID on file', () => {
    const resolved = resolveEnrichedDeviceName('unknown-device', undefined, undefined, new Map());

    expect(resolved).toBeUndefined();
  });

  it('agrees with the schema-declaration path for the same OPC-UA logical device', () => {
    // The exact mismatch found in review: live telemetry (a reading carrying
    // its own device_uuid tag) and schema declarations (built from
    // groupFieldNamesByOwningDevice()'s per-owner deviceUuid) must resolve to
    // the same finalDeviceName for the same physical device, or telemetry and
    // schema drift silently diverge into two different device buckets.
    const dataPoints = [
      { name: 'active-power-kw', device_name: 'Meter-1', device_uuid: 'meter-1' },
      { name: 'voltage-l1', device_name: 'Meter-1', device_uuid: 'meter-1' },
    ];
    const grouped = groupFieldNamesByOwningDevice('opcua', dataPoints);
    const { deviceUuid } = grouped.get('Meter-1')!;

    const schemaResolved = resolveEnrichedDeviceName('Meter-1', undefined, deviceUuid, new Map());
    const telemetryResolved = resolveEnrichedDeviceName('Meter-1', undefined, 'meter-1', new Map());

    expect(schemaResolved?.deviceName).toBe(telemetryResolved?.deviceName);
    expect(schemaResolved?.device_uuid).toBe(telemetryResolved?.device_uuid);
  });
});
