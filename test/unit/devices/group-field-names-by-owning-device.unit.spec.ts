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
    expect(grouped.get('AHU-1')).toEqual(['cc-valve', 'hc-valve', 'mat']);
    expect(grouped.get('AHU-2')).toEqual(['cc-valve', 'hc-valve']);
    expect(grouped.has('opcua_sim-opcua_4840')).toBe(false);
  });

  it('falls back to the connection name for data points with no device_name of their own (true single-device sources)', () => {
    const dataPoints = [
      { name: 'temperature' },
      { name: 'pressure' },
    ];

    const grouped = groupFieldNamesByOwningDevice('modbus-plc-1', dataPoints);

    expect([...grouped.keys()]).toEqual(['modbus-plc-1']);
    expect(grouped.get('modbus-plc-1')).toEqual(['temperature', 'pressure']);
  });

  it('ignores malformed entries without throwing', () => {
    const dataPoints: unknown[] = [null, 42, {}, { name: 123 }, { name: 'valid', device_name: 'AHU-3' }];

    const grouped = groupFieldNamesByOwningDevice('conn', dataPoints);

    expect([...grouped.keys()]).toEqual(['AHU-3']);
    expect(grouped.get('AHU-3')).toEqual(['valid']);
  });
});
