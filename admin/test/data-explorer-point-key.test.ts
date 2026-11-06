import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  dataExplorerPointKey, dataExplorerPoints, matchesDataExplorerView,
  missingDataExplorerViewPointCount, normalizeDataExplorerPointKey,
} from '../src/utils/data-explorer-point-key.ts'
import type { ActivityEvent, SubscriptionActivity } from '../src/api/pipeline.ts'

test('uses the normalized point name for the saved-view key', () => {
  assert.equal(
    dataExplorerPointKey({
      protocol: 'opcua',
      endpointName: 'AHU-7',
      metric: 'CC-Valve',
      normalizedName: 'ahu_7_cc_valve',
    }),
    JSON.stringify(['opcua', 'AHU-7', 'ahu_7_cc_valve']),
  )
})

test('falls back to the metric when no normalized name is available', () => {
  assert.equal(
    dataExplorerPointKey({ protocol: 'opcua', endpointName: 'AHU-7', metric: 'CC-Valve' }),
    JSON.stringify(['opcua', 'AHU-7', 'CC-Valve']),
  )
})

test('uses the point-identity endpoint instead of the display source when available', () => {
  assert.equal(
    dataExplorerPointKey({
      protocol: 'opcua',
      endpointName: 'AHU-7',
      pointIdentityEndpointName: 'opcua-pipe',
      metric: 'CC-Valve',
      normalizedName: 'ahu_7_cc_valve',
    }),
    JSON.stringify(['opcua', 'opcua-pipe', 'ahu_7_cc_valve']),
  )
})

test('matches saved catalog and legacy keys for events and subscription snapshots', () => {
  const event: ActivityEvent = {
    id: 1, timestamp: '2026-11-06T19:00:00Z', protocol: 'opcua', endpointName: 'AHU-7',
    pointIdentityEndpointName: 'opcua-pipe', metric: 'CC-Valve', normalizedName: 'ahu_7_cc_valve',
    value: 1, subscriptionId: 1, destinationId: 1, destinationName: 'MQTT', pointCount: 1,
  }
  const snapshot: SubscriptionActivity = {
    key: 'subscription', subscriptionId: 1, destinationId: 1, destinationName: 'MQTT',
    destinationType: 'mqtt', protocol: 'opcua', endpointName: 'AHU-7',
    pointIdentityEndpointName: 'opcua-pipe', lastMetric: 'CC-Valve', normalizedName: 'ahu_7_cc_valve',
    lastValue: 2, pointCount: 1, totalBatches: 1, lastPublishTime: '2026-11-06T19:01:00Z',
  }
  const catalogKey = JSON.stringify(['opcua', 'opcua-pipe', 'ahu_7_cc_valve'])
  const legacyKey = JSON.stringify(['opcua', 'AHU-7', 'ahu_7_cc_valve'])
  const unrelatedKey = JSON.stringify(['opcua', 'opcua-pipe', 'other'])

  for (const points of [dataExplorerPoints([event], []), dataExplorerPoints([], [snapshot]), dataExplorerPoints([event], [snapshot])]) {
    assert.equal(points.length, 1)
    assert.equal(points[0].key, catalogKey)
    assert.equal(points[0].legacyKey, legacyKey)
    for (const savedKey of [catalogKey, legacyKey, JSON.stringify(['opcua', 'opcua-pipe', 'ahu_7_cc_valve', 'old-id'])]) {
      const keys = new Set([normalizeDataExplorerPointKey(savedKey), unrelatedKey])
      assert.deepEqual(points.filter(point => matchesDataExplorerView(point, keys)), points)
      assert.equal(missingDataExplorerViewPointCount(points, keys), 1)
    }
    assert.equal(matchesDataExplorerView(points[0], new Set([unrelatedKey])), false)
  }
  assert.equal(dataExplorerPoints([event], [snapshot])[0].value, 2)
})

test('uses display endpoint and metric when identity metadata is unavailable', () => {
  const event: ActivityEvent = {
    id: 1, timestamp: '2026-11-06T19:00:00Z', protocol: 'modbus', endpointName: 'boiler',
    metric: 'temperature', value: 21, subscriptionId: null, destinationId: 1,
    destinationName: 'MQTT', pointCount: 1,
  }
  const points = dataExplorerPoints([event], [])
  const keys = new Set([JSON.stringify(['modbus', 'boiler', 'temperature'])])
  assert.equal(matchesDataExplorerView(points[0], keys), true)
  assert.equal(missingDataExplorerViewPointCount(points, keys), 0)
  assert.equal(normalizeDataExplorerPointKey('invalid'), 'invalid')
})
