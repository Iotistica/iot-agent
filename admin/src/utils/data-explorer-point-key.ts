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
  sourceEndpointUuid?: string
  deviceUuid?: string
  deviceDisplayName?: string
  pointUuid?: string
  provisionalPointId?: string
  rawPointName?: string
  rawObjectName?: string
  value: unknown
  quality?: string
  unit?: string
  timestamp: string
  _ts?: number
  destinationName: string
}

export function dataExplorerPointName(point: Pick<DataExplorerPointRow, 'protocol' | 'metric' | 'normalizedName' | 'rawPointName' | 'rawObjectName'>): string {
  const rawName = point.rawPointName || point.rawObjectName
  return point.normalizedName || rawName || point.metric
}

export function dataExplorerPoints(events: ActivityEvent[], subscriptions: SubscriptionActivity[]): DataExplorerPointRow[] {
  const byKey = new Map<string, DataExplorerPointRow>()
  function add(row: Omit<DataExplorerPointRow, 'key' | 'legacyKey'>) {
    const key = dataExplorerPointKey(row)
    const legacyKey = dataExplorerPointKey({ ...row, pointIdentityEndpointName: undefined })
    const ts = Date.parse(row.timestamp)
    const previous = byKey.get(key)
    if (!previous || ts > (previous._ts ?? 0)) {
      byKey.set(key, { ...row, key, legacyKey, _ts: ts })
    }
  }
  for (const e of events) {
    add({
      protocol: e.protocol, endpointName: e.endpointName, pointIdentityEndpointName: e.pointIdentityEndpointName,
      sourceEndpointUuid: e.sourceEndpointUuid, deviceUuid: e.deviceUuid, deviceDisplayName: e.deviceDisplayName,
      pointUuid: e.pointUuid, provisionalPointId: e.provisionalPointId,
      metric: e.metric, normalizedName: e.normalizedName, rawPointName: e.rawPointName,
      rawObjectName: e.rawObjectName, value: e.value, quality: e.quality,
      unit: e.unit, timestamp: e.timestamp, destinationName: e.destinationName,
    })
  }
  for (const s of subscriptions) {
    if (!s.lastMetric || !s.lastPublishTime) continue
    add({
      protocol: s.protocol, endpointName: s.endpointName, pointIdentityEndpointName: s.pointIdentityEndpointName,
      sourceEndpointUuid: s.sourceEndpointUuid, deviceUuid: s.deviceUuid, deviceDisplayName: s.deviceDisplayName,
      pointUuid: s.pointUuid, provisionalPointId: s.provisionalPointId,
      metric: s.lastMetric, normalizedName: s.normalizedName, rawPointName: s.rawPointName,
      rawObjectName: s.rawObjectName, value: s.lastValue, quality: s.lastQuality,
      unit: s.lastUnit, timestamp: s.lastPublishTime, destinationName: s.destinationName,
    })
  }
  return [...byKey.values()].sort((a, b) => (b._ts ?? 0) - (a._ts ?? 0))
}

interface ExplorerSource {
  id?: number
  uuid: string
  name: string
  protocol: string
  metadata?: Record<string, unknown>
}

interface ExplorerDevice {
  uuid: string
  endpoint_id: number
  name: string
  protocol: string
  metadata?: Record<string, unknown>
}

export function dataExplorerSourceLookup(sources: ExplorerSource[], devices: ExplorerDevice[]) {
  const byUuid = new Map(sources.map(source => [source.uuid, source]))
  const byId = new Map(sources.filter(source => source.id !== undefined).map(source => [source.id, source]))
  const byDeviceUuid = new Map(devices.map(device => [device.uuid, byId.get(device.endpoint_id)]))
  const byName = new Map<string, ExplorerSource | null>()
  for (const device of devices) {
    const source = byId.get(device.endpoint_id)
    if (!source) continue
    const friendly = typeof device.metadata?.objectName === 'string' ? device.metadata.objectName : device.name
    for (const name of new Set([device.name, friendly, `${friendly}-${device.uuid.slice(0, 8)}`])) {
      const key = JSON.stringify([device.protocol, name])
      const existing = byName.get(key)
      byName.set(key, existing === undefined || existing?.uuid === source.uuid ? source : null)
    }
  }
  return (point: Pick<DataExplorerPointRow, 'protocol' | 'endpointName' | 'sourceEndpointUuid' | 'deviceUuid'>): ExplorerSource | undefined => {
    const source = point.sourceEndpointUuid
      ? byUuid.get(point.sourceEndpointUuid)
      : point.deviceUuid
        ? byDeviceUuid.get(point.deviceUuid)
        : byName.get(JSON.stringify([point.protocol, point.endpointName]))
    return source && source.protocol === point.protocol ? source : undefined
  }
}

export function dataExplorerSourceName(source: ExplorerSource | undefined): string {
  return (typeof source?.metadata?.objectName === 'string' && source.metadata.objectName) || source?.name || 'Unknown'
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
  const present = new Set<string>()
  for (const p of points) {
    present.add(p.key)
    if (p.legacyKey) present.add(p.legacyKey)
  }
  let missing = 0
  for (const key of keys) {
    if (!present.has(key)) missing++
  }
  return missing
}
