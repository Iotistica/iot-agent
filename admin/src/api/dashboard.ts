import { client } from './client'

export interface NetworkBandwidth {
  iface: string
  rx_sec: number
  tx_sec: number
  rx_bytes: number
  tx_bytes: number
}

export interface DashboardStats {
  cpu_usage: number
  memory_percent: number
  memory_used: number
  memory_total: number
  storage_percent: number | null
  storage_used: number | null
  storage_total: number | null
  uptime: number
  hostname: string
  network: NetworkBandwidth[]
}

export interface NormalizationIssue {
  label: string
  protocol: string | null
  count: number
  firstSeen: string
  lastSeen: string
}

export interface NormalizationIssueSummary {
  count: number
  items: NormalizationIssue[]
}

export interface NormalizationHealth {
  unknownUnits: NormalizationIssueSummary
  conversionFailures: NormalizationIssueSummary
}

export interface CanonicalUnit {
  canonical_unit: string
  quantity: string
  symbol: string | null
  description: string | null
}

export interface CustomUnitAlias {
  id: number
  source_system: string | null
  alias: string
  canonical_unit: string
}

export const dashboardApi = {
  getStats(): Promise<DashboardStats> {
    return client.get<DashboardStats>('/v1/dashboard/stats').then((r) => r.data)
  },
  getNormalizationHealth(): Promise<NormalizationHealth> {
    return client.get<NormalizationHealth>('/v1/normalization-health').then((r) => r.data)
  },
  getCanonicalUnits(): Promise<CanonicalUnit[]> {
    return client.get<CanonicalUnit[]>('/v1/units/canonical').then((r) => r.data)
  },
  getCustomUnitAliases(): Promise<CustomUnitAlias[]> {
    return client.get<CustomUnitAlias[]>('/v1/units/custom-aliases').then((r) => r.data)
  },
  resolveUnknownUnit(rawUnit: string, sourceSystem: string | null, canonicalUnit: string): Promise<NormalizationHealth> {
    return client
      .post<NormalizationHealth>('/v1/normalization-health/resolve-unit', { rawUnit, sourceSystem, canonicalUnit })
      .then((r) => r.data)
  },
}
