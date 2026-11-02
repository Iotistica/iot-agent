import { client } from './client'

export interface FirewallRule {
  id: number
  port: string
  protocol: string
  interface_name: string | null
  description: string | null
  created_at: string
}

export interface ReservedPort {
  port: number
  service: string
}

export interface FirewallStatus {
  enabled: boolean
  initialized: boolean
  mode: string
  deviceApiPort: number
  mqttPort?: number
}

export interface FirewallResponse {
  available: boolean
  status: FirewallStatus | null
  rules: FirewallRule[]
  reservedPorts: ReservedPort[]
}

export interface PortEntry {
  port: number
  protocol: string
  address: string
  process: string
  source: 'system' | 'docker'
}

export interface PortsResponse {
  ports: PortEntry[]
  reservedPorts: ReservedPort[]
}

export interface FirewallRuleInput {
  port: string
  protocol: string
  interface_name?: string
  description?: string
}

// ── Capture types ──────────────────────────────────────────────────────────

export interface DecodedInfo {
  operation: string
  summary: string
  status: 'ok' | 'error' | 'warning'
  details: Record<string, string | number | boolean>
}

export interface CapturePacket {
  id: number
  timestamp: number
  length: number
  capturedLength: number
  srcIp: string
  dstIp: string
  srcPort: number | null
  dstPort: number | null
  ipProtocol: number
  protocolName: string
  direction: 'inbound' | 'outbound' | 'unknown'
  info: string
  size: number
  decoded?: DecodedInfo
}

export interface CapturePacketDetail extends CapturePacket {
  hexDump: string
}

export interface CaptureCounters {
  seen: number
  stored: number
  dropped: number
  inbound: number
  outbound: number
  bytes: number
}

export interface CaptureStatusData {
  running: boolean
  sessionId: string | null
  startedAt: string | null
  counters: CaptureCounters
  iface: string
  filter: string | null
}

export interface CaptureStatusResponse {
  available: boolean
  status: CaptureStatusData | null
}

export interface CapturePacketsResponse {
  packets: CapturePacket[]
  total: number
  offset: number
  limit: number
}

// ── API ────────────────────────────────────────────────────────────────────

export const networkApi = {
  getFirewall: () => client.get<FirewallResponse>('/v1/network/firewall').then((r) => r.data),

  addRule: (rule: FirewallRuleInput) => client.post<FirewallRule>('/v1/network/firewall/rules', rule).then((r) => r.data),

  updateRule: (id: number, rule: Partial<FirewallRuleInput>) =>
    client.put<FirewallRule>(`/v1/network/firewall/rules/${id}`, rule).then((r) => r.data),

  deleteRule: (id: number) => client.delete(`/v1/network/firewall/rules/${id}`).then((r) => r.data),

  getPorts: () => client.get<PortsResponse>('/v1/network/ports').then((r) => r.data),

  // Capture
  getCaptureStatus: () => client.get<CaptureStatusResponse>('/v1/network/capture/status').then((r) => r.data),

  startCapture: (opts?: { filter?: string; maxPackets?: number }) =>
    client.post('/v1/network/capture/start', opts ?? {}).then((r) => r.data),

  stopCapture: () => client.post('/v1/network/capture/stop').then((r) => r.data),

  clearCapture: () => client.post('/v1/network/capture/clear').then((r) => r.data),

  getCapturePackets: (params?: Record<string, string | number>) =>
    client.get<CapturePacketsResponse>('/v1/network/capture/packets', { params }).then((r) => r.data),

  getCapturePacket: (id: number) =>
    client.get<CapturePacketDetail>(`/v1/network/capture/packets/${id}`).then((r) => r.data),

  getCaptureExportUrl: () => {
    const base = client.defaults.baseURL || ''
    return `${base}/v1/network/capture/export`
  },
}
