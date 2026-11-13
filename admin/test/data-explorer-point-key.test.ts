import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  dataExplorerPointKey, dataExplorerPointName, dataExplorerPoints, dataExplorerSourceLookup, dataExplorerSourceName, matchesDataExplorerView,
  missingDataExplorerViewPointCount, normalizeDataExplorerPointKey, orderDataExplorerViewPoints,
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

test('displays the raw MQTT point name instead of its device-prefixed normalized name', () => {
  assert.equal(
    dataExplorerPointName({
      protocol: 'mqtt',
      metric: 'mqtt_factory_sim_004_status',
      normalizedName: 'mqtt_factory_sim_004_status',
      rawPointName: 'status',
    }),
    'status',
  )
  assert.equal(
    dataExplorerPointName({
      protocol: 'modbus',
      metric: 'temperature',
      normalizedName: 'boiler_temperature',
      rawPointName: 'temperature',
    }),
    'boiler_temperature',
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
    sourceEndpointUuid: 'source-1', deviceUuid: 'device-1', deviceDisplayName: 'plc-001',
    pointIdentityEndpointName: 'opcua-pipe', metric: 'CC-Valve', normalizedName: 'ahu_7_cc_valve',
    value: 1, subscriptionId: 1, destinationId: 1, destinationName: 'MQTT', pointCount: 1,
  }
  const snapshot: SubscriptionActivity = {
    key: 'subscription', subscriptionId: 1, destinationId: 1, destinationName: 'MQTT',
    destinationType: 'mqtt', protocol: 'opcua', endpointName: 'AHU-7',
    sourceEndpointUuid: 'source-1', deviceUuid: 'device-1', deviceDisplayName: 'plc-001',
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
    assert.equal(points[0].sourceEndpointUuid, 'source-1')
    assert.equal(points[0].deviceUuid, 'device-1')
    assert.equal(points[0].deviceDisplayName, 'plc-001')
    for (const savedKey of [catalogKey, legacyKey, JSON.stringify(['opcua', 'opcua-pipe', 'ahu_7_cc_valve', 'old-id'])]) {
      const keys = new Set([normalizeDataExplorerPointKey(savedKey), unrelatedKey])
      assert.deepEqual(points.filter(point => matchesDataExplorerView(point, keys)), points)
      assert.equal(missingDataExplorerViewPointCount(points, keys), 1)
    }
    assert.equal(matchesDataExplorerView(points[0], new Set([unrelatedKey])), false)
  }
  assert.equal(dataExplorerPoints([event], [snapshot])[0].value, 2)
})

test('resolves source grid names by identity and does not guess ambiguous names', () => {
  const sources = [
    { id: 1, uuid: 'source-1', name: 'opcua-server', protocol: 'opcua', metadata: { objectName: 'OPC UA Server' } },
    { id: 2, uuid: 'source-2', name: 'other-server', protocol: 'opcua' },
    { id: 3, uuid: 'source-3', name: 'mqtt-server', protocol: 'mqtt' },
  ]
  const devices = [
    { endpoint_id: 1, uuid: 'device-1', name: 'AHU-7', protocol: 'opcua' },
    { endpoint_id: 2, uuid: 'device-2', name: 'AHU-7', protocol: 'opcua' },
    { endpoint_id: 1, uuid: 'device-3', name: 'pump', protocol: 'opcua' },
  ]
  const resolve = dataExplorerSourceLookup(sources, devices)
  const point = { protocol: 'opcua', endpointName: 'AHU-7' }
  assert.equal(dataExplorerSourceName(resolve({ ...point, deviceUuid: 'device-1' })), 'OPC UA Server')
  assert.equal(dataExplorerSourceName(resolve({ ...point, sourceEndpointUuid: 'source-2', deviceUuid: 'device-1' })), 'other-server')
  assert.equal(dataExplorerSourceName(resolve(point)), 'Unknown')
  assert.equal(dataExplorerSourceName(resolve({ ...point, endpointName: 'pump' })), 'OPC UA Server')
  assert.equal(dataExplorerSourceName(resolve({ ...point, deviceUuid: 'missing' })), 'Unknown')
  assert.equal(dataExplorerSourceName(resolve({ ...point, sourceEndpointUuid: 'source-3' })), 'Unknown')
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

test('orders saved-view points by their stored keys, including legacy keys', () => {
  const points = [
    { key: 'point-b' },
    { key: 'point-a' },
    { key: 'point-c' },
    { key: 'current-key', legacyKey: 'legacy-key' },
  ]

  assert.deepEqual(
    orderDataExplorerViewPoints(points, ['point-a', 'legacy-key', 'point-b']),
    [points[1], points[3], points[0], points[2]],
  )
})

test('normalizes saved-view keys and retains response order for unlisted points', () => {
  const point = { key: '["opcua","ahu","temperature"]' }
  const unlisted = { key: 'unlisted' }

  assert.deepEqual(
    orderDataExplorerViewPoints([unlisted, point], ['["opcua","ahu","temperature","old-id"]']),
    [point, unlisted],
  )
})
