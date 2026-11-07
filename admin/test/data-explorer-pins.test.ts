import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mergePinnedDataExplorerPoints } from '../src/utils/data-explorer-pins.ts'

test('retains cached pinned points while preferring the latest live rows', () => {
  const current = [{ key: 'live', value: 3 }, { key: 'updated-pin', value: 5 }]
  const cached = new Map([
    ['missing-pin', { key: 'missing-pin', value: 1 }],
    ['updated-pin', { key: 'updated-pin', value: 2 }],
    ['unpinned', { key: 'unpinned', value: 4 }],
  ])

  assert.deepEqual(
    mergePinnedDataExplorerPoints(current, ['missing-pin', 'updated-pin'], cached),
    [
      { key: 'live', value: 3 },
      { key: 'updated-pin', value: 5 },
      { key: 'missing-pin', value: 1 },
    ],
  )
})
