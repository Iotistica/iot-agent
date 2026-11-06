import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { ActivityEvent } from '../src/api/pipeline.ts'
import { dataExplorerPoints } from '../src/utils/data-explorer-point-key.ts'
import { pointHistory } from '../src/utils/point-history.ts'

test('history follows the shared point identity for every protocol and sorts readings', () => {
  for (const protocol of ['bacnet', 'modbus', 'opcua', 'mqtt']) {
    const event: ActivityEvent = {
      id: 1, timestamp: '2026-01-01T00:00:02Z', protocol, endpointName: 'device',
      pointIdentityEndpointName: 'pipe', metric: 'temp', normalizedName: 'temperature',
      value: 12, subscriptionId: 1, destinationId: 1, destinationName: 'out', pointCount: 1,
    }
    const point = dataExplorerPoints([event], [])[0]
    const events = [
      { ...event, id: 3, value: true },
      event,
      { ...event, id: 2, timestamp: '2026-01-01T00:00:01Z', value: '10' },
      { ...event, id: 4, endpointName: 'other', pointIdentityEndpointName: 'other' },
      { ...event, id: 5, normalizedName: 'other' },
      { ...event, id: 6, protocol: 'other' },
      { ...event, id: 7, value: null },
      { ...event, id: 8, value: '' },
      { ...event, id: 9, value: 'not a number' },
      { ...event, id: 10, value: Infinity },
      { ...event, id: 11, timestamp: 'invalid' },
    ]
    assert.deepEqual(pointHistory(events, point).map(p => p.value), [10, 12, 1])
  }
})
