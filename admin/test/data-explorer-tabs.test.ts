import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { restoreDataExplorerTabs } from '../src/utils/data-explorer-tabs.ts'

test('restores opened views and the active saved view', () => {
  assert.deepEqual(
    restoreDataExplorerTabs(
      JSON.stringify({ activeTab: 'view-2', openViewIds: ['view-1', 'view-2'] }),
      ['view-1', 'view-2'],
    ),
    { activeTab: 'view-2', openViewIds: ['view-1', 'view-2'] },
  )
})

test('keeps only available, unique saved views and opens the active view', () => {
  assert.deepEqual(
    restoreDataExplorerTabs(
      JSON.stringify({ activeTab: 'view-2', openViewIds: ['view-1', 'view-1', 'deleted-view'] }),
      ['view-1', 'view-2'],
    ),
    { activeTab: 'view-2', openViewIds: ['view-1', 'view-2'] },
  )
})

test('restores built-in tabs and ignores malformed or invalid state', () => {
  assert.deepEqual(
    restoreDataExplorerTabs(
      JSON.stringify({ activeTab: 'datasets', openViewIds: ['deleted-view'] }),
      [],
    ),
    { activeTab: 'datasets', openViewIds: [] },
  )
  assert.deepEqual(restoreDataExplorerTabs('invalid', ['view-1']), { activeTab: 'all', openViewIds: [] })
  assert.deepEqual(restoreDataExplorerTabs(null, ['view-1']), { activeTab: 'all', openViewIds: [] })
})
