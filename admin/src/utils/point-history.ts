import type { ActivityEvent } from '../api/pipeline'
import { dataExplorerPointKey, type DataExplorerPointRow } from './data-explorer-point-key'

export interface HistorySample { ts: number; value: number }

export function pointHistory(events: ActivityEvent[], point: DataExplorerPointRow): HistorySample[] {
  return events.flatMap(event => {
    if (dataExplorerPointKey(event) !== point.key) return []
    const ts = Date.parse(event.timestamp)
    const raw = event.value
    const value = typeof raw === 'boolean' ? Number(raw)
      : typeof raw === 'number' ? raw
        : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN
    return Number.isFinite(ts) && Number.isFinite(value) ? [{ ts, value, id: event.id }] : []
  }).sort((a, b) => a.ts - b.ts || a.id - b.id).map(({ ts, value }) => ({ ts, value }))
}
