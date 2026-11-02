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

export const networkApi = {
  getFirewall: () => client.get<FirewallResponse>('/v1/network/firewall').then((r) => r.data),

  addRule: (rule: FirewallRuleInput) => client.post<FirewallRule>('/v1/network/firewall/rules', rule).then((r) => r.data),

  updateRule: (id: number, rule: Partial<FirewallRuleInput>) =>
    client.put<FirewallRule>(`/v1/network/firewall/rules/${id}`, rule).then((r) => r.data),

  deleteRule: (id: number) => client.delete(`/v1/network/firewall/rules/${id}`).then((r) => r.data),

  getPorts: () => client.get<PortsResponse>('/v1/network/ports').then((r) => r.data),
}
