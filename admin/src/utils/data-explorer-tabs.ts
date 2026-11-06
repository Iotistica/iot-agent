const builtInTabs = new Set(['all', 'favorites', 'views', 'datasets'])

export interface DataExplorerTabs {
  activeTab: string
  openViewIds: string[]
}

export function restoreDataExplorerTabs(raw: string | null, savedViewIds: readonly string[]): DataExplorerTabs {
  try {
    const stored: unknown = JSON.parse(raw || 'null')
    if (!stored || typeof stored !== 'object') return { activeTab: 'all', openViewIds: [] }

    const state = stored as { activeTab?: unknown; openViewIds?: unknown }
    const availableViews = new Set(savedViewIds)
    const openViewIds = Array.isArray(state.openViewIds)
      ? [...new Set(state.openViewIds.filter((id): id is string => typeof id === 'string' && availableViews.has(id)))]
      : []
    const activeTab = typeof state.activeTab === 'string'
      && (builtInTabs.has(state.activeTab) || availableViews.has(state.activeTab))
      ? state.activeTab
      : 'all'

    if (availableViews.has(activeTab) && !openViewIds.includes(activeTab)) openViewIds.push(activeTab)
    return { activeTab, openViewIds }
  } catch {
    return { activeTab: 'all', openViewIds: [] }
  }
}
