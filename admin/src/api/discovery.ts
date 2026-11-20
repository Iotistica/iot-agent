import { client } from './client'
import type { BlockedDevice, DiscoveredDevice, DiscoveryRule, DiscoveryRuleFormData, DiscoveryRun } from '@/types'

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
    options?: { prune?: boolean; pruneDryRun?: boolean; forceFullBrowse?: boolean },
  ): Promise<{
    rule: DiscoveryRule
    devices: DiscoveredDevice[]
    prunedCount: number
    prunedDevices?: Array<{ name: string; protocol: string }>
    pruneDryRun?: boolean
  }> {
    return client
      .post(`${RULES_BASE}/${uuid}/run`, options ?? {}, { timeout: 600_000, signal })
      .then((r) => r.data)
  },

  pause(uuid: string): Promise<{ rule: DiscoveryRule }> {
    return client.post(`${RULES_BASE}/${uuid}/pause`).then((r) => r.data)
  },

  getRuns(uuid: string, limit = 50): Promise<DiscoveryRun[]> {
    return client.get<{ runs: DiscoveryRun[] }>(`${RULES_BASE}/${uuid}/runs`, { params: { limit } }).then((r) => r.data.runs)
  },

  getRecentRuns(limit = 20): Promise<DiscoveryRun[]> {
    return client.get<{ runs: DiscoveryRun[] }>('/v1/discovery-runs', { params: { limit } }).then((r) => r.data.runs)
  },
}

const BLOCKLIST_BASE = '/v1/discovery-blocklist'

export const discoveryBlocklistApi = {
  getAll(): Promise<BlockedDevice[]> {
    return client.get<{ blocked: BlockedDevice[] }>(BLOCKLIST_BASE).then((r) => r.data.blocked)
  },

  block(data: { fingerprint: string; protocol: string; name: string }): Promise<BlockedDevice> {
    return client.post<{ blocked: BlockedDevice }>(BLOCKLIST_BASE, data).then((r) => r.data.blocked)
  },

  unblock(fingerprint: string): Promise<void> {
    return client.delete(`${BLOCKLIST_BASE}/${encodeURIComponent(fingerprint)}`).then(() => undefined)
  },
}
