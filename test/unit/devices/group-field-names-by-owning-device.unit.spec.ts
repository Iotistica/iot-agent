import { groupFieldNamesByOwningDevice } from '../../../src/plugins/index';

describe('groupFieldNamesByOwningDevice', () => {
  it('groups a multi-device connection\'s flat data points by each one\'s own device_name', () => {
    // Regression: this is exactly the OPC-UA shape — one connection
    // ("opcua_sim-opcua_4840") whose dataPoints span every AHU, each data
    // point carrying its own device_name. Declaring the whole flat list
    // under the connection's name landed every AHU's fields in a bucket
    // schema drift never actually queries, so nothing showed up as declared.
    const dataPoints = [
      { name: 'cc-valve', device_name: 'AHU-1' },
      { name: 'hc-valve', device_name: 'AHU-1' },
      { name: 'mat', device_name: 'AHU-1' },
      { name: 'cc-valve', device_name: 'AHU-2' },
      { name: 'hc-valve', device_name: 'AHU-2' },
    ];

    const grouped = groupFieldNamesByOwningDevice('opcua_sim-opcua_4840', dataPoints);

    expect([...grouped.keys()].sort()).toEqual(['AHU-1', 'AHU-2']);
    expect(grouped.get('AHU-1')?.fields).toEqual(['cc-valve', 'hc-valve', 'mat']);
    expect(grouped.get('AHU-2')?.fields).toEqual(['cc-valve', 'hc-valve']);
    expect(grouped.has('opcua_sim-opcua_4840')).toBe(false);
  });

  it('falls back to the connection name for data points with no device_name of their own (true single-device sources)', () => {
    const dataPoints = [
      { name: 'temperature' },
      { name: 'pressure' },
    ];

    const grouped = groupFieldNamesByOwningDevice('modbus-plc-1', dataPoints);

    expect([...grouped.keys()]).toEqual(['modbus-plc-1']);
    expect(grouped.get('modbus-plc-1')?.fields).toEqual(['temperature', 'pressure']);
  });

  it('ignores malformed entries without throwing', () => {
    const dataPoints: unknown[] = [null, 42, {}, { name: 123 }, { name: 'valid', device_name: 'AHU-3' }];

    const grouped = groupFieldNamesByOwningDevice('conn', dataPoints);

    expect([...grouped.keys()]).toEqual(['AHU-3']);
    expect(grouped.get('AHU-3')?.fields).toEqual(['valid']);
  });

  it('carries a representative device_uuid through to the group, for telemetry/schema bucket agreement', () => {
    // The whole reason this field exists: resolveEnrichedDeviceName() needs
    // the same sourceDeviceUuid for schema declarations that live telemetry
    // readings for this device already carry, so both land in the same
    // downstream device bucket (see src/plugins/index.ts's device-connected
    // handler).
    const dataPoints = [
      { name: 'temp', device_name: 'Meter-1', device_uuid: 'meter-1' },
      { name: 'power', device_name: 'Meter-1', device_uuid: 'meter-1' },
    ];

    const grouped = groupFieldNamesByOwningDevice('opcua', dataPoints);

    expect(grouped.get('Meter-1')).toEqual({ fields: ['temp', 'power'], deviceUuid: 'meter-1' });
  });

  it('keeps the first device_uuid and reports a conflict when the same owner has contradictory tags', () => {
    // Should be impossible for well-formed discovery output (one DeviceUUID
    // marker per device folder) — if it ever happens, the conflict must be
    // surfaced, not silently resolved either way.
    const dataPoints = [
      { name: 'temp', device_name: 'AHU-1', device_uuid: 'uuid-a' },
      { name: 'pressure', device_name: 'AHU-1', device_uuid: 'uuid-b' },
    ];
    const conflicts: Array<[string, string, string]> = [];

    const grouped = groupFieldNamesByOwningDevice('conn', dataPoints, (owner, keptUuid, ignoredUuid) => {
      conflicts.push([owner, keptUuid, ignoredUuid]);
    });

    expect(grouped.get('AHU-1')?.deviceUuid).toBe('uuid-a');
    expect(conflicts).toEqual([['AHU-1', 'uuid-a', 'uuid-b']]);
  });
});
