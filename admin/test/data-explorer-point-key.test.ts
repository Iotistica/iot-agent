import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { dataExplorerPointKey } from '../src/utils/data-explorer-point-key.ts'

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
