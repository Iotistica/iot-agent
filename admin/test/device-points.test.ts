import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { getDevicePoints } from '../src/utils/device-points.ts'
import type { PointCatalogEntry } from '../src/api/point-catalog.ts'

const point = (overrides: Partial<PointCatalogEntry>): PointCatalogEntry => ({
  sourceSystem: 'modbus',
  endpointName: 'modbus-pipe',
  deviceKey: 'device-1',
  rawName: 'Temperature',
  normalizedName: 'temperature',
  pointKey: 'point-1',
  ...overrides,
})

test('only includes points belonging to resolved devices', () => {
  const devicePoint = point({})
  const otherPoint = point({ deviceKey: 'device-2', pointKey: 'point-2', sourceSystem: 'mqtt' })
  const points = [
    devicePoint,
    otherPoint,
    point({ deviceKey: '', pointKey: 'empty' }),
    point({ deviceKey: 'unknown', pointKey: 'unknown' }),
    point({ deviceKey: undefined, pointKey: 'missing' }),
  ]

  assert.deepEqual(getDevicePoints(points, new Map([
    ['device-1', 'Boiler'],
    ['device-2', 'mqtt_factory_sim-001'],
  ])), [
    { point: devicePoint, deviceName: 'Boiler' },
    { point: otherPoint, deviceName: 'mqtt_factory_sim-001' },
  ])
})

test('does not expose endpoints while device names are unavailable', () => {
  assert.deepEqual(getDevicePoints([point({})], new Map()), [])
})
