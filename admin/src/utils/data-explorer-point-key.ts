import type { ActivityEvent, SubscriptionActivity } from '../api/pipeline'

export interface DataExplorerPointIdentity {
  protocol: string
  endpointName: string
  pointIdentityEndpointName?: string
  metric: string
  normalizedName?: string
}

export function dataExplorerPointKey(point: DataExplorerPointIdentity): string {
  return JSON.stringify([point.protocol, point.pointIdentityEndpointName || point.endpointName, point.normalizedName || point.metric])
}

export interface DataExplorerPointRow extends DataExplorerPointIdentity {
  key: string
  legacyKey?: string
  rawPointName?: string
  rawObjectName?: string
  value: unknown
  quality?: string
  unit?: string
  timestamp: string
  destinationName: string
}

export function dataExplorerPoints(events: ActivityEvent[], subscriptions: SubscriptionActivity[]): DataExplorerPointRow[] {
  const byKey = new Map<string, DataExplorerPointRow>()
  function add(row: Omit<DataExplorerPointRow, 'key' | 'legacyKey'>) {
    const key = dataExplorerPointKey(row)
    const legacyKey = dataExplorerPointKey({ ...row, pointIdentityEndpointName: undefined })
    const previous = byKey.get(key)
    if (!previous || Date.parse(row.timestamp) > Date.parse(previous.timestamp)) {
      byKey.set(key, { ...row, key, legacyKey })
    }
  }
  for (const e of events) {
    add({
      protocol: e.protocol, endpointName: e.endpointName, pointIdentityEndpointName: e.pointIdentityEndpointName,
      metric: e.metric, normalizedName: e.normalizedName, rawPointName: e.rawPointName,
      rawObjectName: e.rawObjectName, value: e.value, quality: e.quality,
      unit: e.unit, timestamp: e.timestamp, destinationName: e.destinationName,
    })
  }
  for (const s of subscriptions) {
    if (!s.lastMetric || !s.lastPublishTime) continue
    add({
      protocol: s.protocol, endpointName: s.endpointName, pointIdentityEndpointName: s.pointIdentityEndpointName,
      metric: s.lastMetric, normalizedName: s.normalizedName, rawPointName: s.rawPointName,
      rawObjectName: s.rawObjectName, value: s.lastValue, quality: s.lastQuality,
      unit: s.lastUnit, timestamp: s.lastPublishTime, destinationName: s.destinationName,
    })
  }
  return [...byKey.values()].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
}

export function normalizeDataExplorerPointKey(key: string): string {
  try {
    const parts = JSON.parse(key)
    if (Array.isArray(parts) && parts.length === 4) return JSON.stringify(parts.slice(0, 3))
  } catch { /* Preserve unrecognized keys. */ }
  return key
}

export function orderDataExplorerViewPoints<T extends { key: string; legacyKey?: string }>(
  points: T[],
  orderedKeys: readonly string[],
): T[] {
  const keyOrder = new Map<string, number>()
  orderedKeys.forEach((key, index) => {
    const normalizedKey = normalizeDataExplorerPointKey(key)
    if (!keyOrder.has(normalizedKey)) keyOrder.set(normalizedKey, index)
  })
  const rank = (point: T) =>
    keyOrder.get(normalizeDataExplorerPointKey(point.key))
      ?? (point.legacyKey ? keyOrder.get(normalizeDataExplorerPointKey(point.legacyKey)) : undefined)
  return [...points].sort((a, b) => {
    const aRank = rank(a)
    const bRank = rank(b)
    if (aRank === undefined) return bRank === undefined ? 0 : 1
    if (bRank === undefined) return -1
    return aRank - bRank
  })
}

export function matchesDataExplorerView(point: DataExplorerPointRow, keys: ReadonlySet<string>): boolean {
  return keys.has(point.key) || (!!point.legacyKey && keys.has(point.legacyKey))
}

export function missingDataExplorerViewPointCount(points: DataExplorerPointRow[], keys: ReadonlySet<string>): number {
  return [...keys].filter(key => !points.some(point => point.key === key || point.legacyKey === key)).length
}
