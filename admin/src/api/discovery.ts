import { client } from './client'
import type { DiscoveredDevice, DiscoveryRule, DiscoveryRuleFormData, DiscoveryRun } from '@/types'

export interface DiscoveryOptions {
  protocols?: string[]
  validate?: boolean
  forceRun?: boolean
  overrides?: Record<string, Record<string, unknown>>
}

export const discoveryApi = {
  run(options: DiscoveryOptions = {}, signal?: AbortSignal): Promise<DiscoveredDevice[]> {
    return client
      .post<{ devices: DiscoveredDevice[] }>('/v1/discover', options, { timeout: 60_000, signal })
      .then((r) => r.data.devices)
  },
}

const RULES_BASE = '/v1/discovery-rules'

export const discoveryRulesApi = {
  getAll(): Promise<DiscoveryRule[]> {
    return client.get<{ rules: DiscoveryRule[] }>(RULES_BASE).then((r) => r.data.rules)
  },

  create(data: DiscoveryRuleFormData): Promise<DiscoveryRule> {
    return client.post<{ rule: DiscoveryRule }>(RULES_BASE, data).then((r) => r.data.rule)
  },

  update(uuid: string, data: Partial<DiscoveryRuleFormData>): Promise<DiscoveryRule> {
    return client.patch<{ rule: DiscoveryRule }>(`${RULES_BASE}/${uuid}`, data).then((r) => r.data.rule)
  },

  remove(uuid: string): Promise<void> {
    return client.delete(`${RULES_BASE}/${uuid}`).then(() => undefined)
  },

  run(
    uuid: string,
    signal?: AbortSignal,
    pruneOptions?: { prune?: boolean; pruneDryRun?: boolean },
  ): Promise<{
    rule: DiscoveryRule
    devices: DiscoveredDevice[]
    prunedCount: number
    prunedDevices?: Array<{ name: string; protocol: string }>
    pruneDryRun?: boolean
  }> {
    // A full scan+validate+reconcile pass scales with device count — at a few
    // hundred devices this can comfortably exceed a minute, so this needs real
    // headroom rather than a timeout tuned for small test rigs.
    return client
      .post(`${RULES_BASE}/${uuid}/run`, pruneOptions ?? {}, { timeout: 600_000, signal })
      .then((r) => r.data)
  },

  getRuns(uuid: string, limit = 50): Promise<DiscoveryRun[]> {
    return client.get<{ runs: DiscoveryRun[] }>(`${RULES_BASE}/${uuid}/runs`, { params: { limit } }).then((r) => r.data.runs)
  },

  getRecentRuns(limit = 20): Promise<DiscoveryRun[]> {
    return client.get<{ runs: DiscoveryRun[] }>('/v1/discovery-runs', { params: { limit } }).then((r) => r.data.runs)
  },
}
