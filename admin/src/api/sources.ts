import { client } from './client'
import type { Endpoint, EndpointCreateData, EndpointUpdateData } from '@/types'

const BASE = '/v1/endpoints'

export interface SourceTestRegisterResult {
  name: string
  value: unknown
  unit?: string
  quality: string
  error?: string
}

export interface SourceTestResult {
  ok: boolean
  message?: string
  error?: string
  results?: SourceTestRegisterResult[]
}

export interface OPCUADeviceIdentification {
  rootNodeId: string
  scopeNodeId: string
  deviceTypeNodeId: string
  identifierProperty: string
  identifierPath: string
}

export interface OPCUABrowseNode {
  nodeId: string
  browseName: string
  nodeClass: string
  dataType: string | null
  typeDefinition?: string
  value?: unknown
  valueStatus?: string
}

export const sourcesApi = {
  getAll(protocol?: string): Promise<Endpoint[]> {
    return client
      .get<{ endpoints: Endpoint[] }>(BASE, { params: protocol ? { protocol } : {} })
      .then((r) => r.data.endpoints)
  },

  test(data: { protocol: string; connection: Record<string, unknown>; registers?: unknown[] }): Promise<SourceTestResult> {
    return client.post<SourceTestResult>(`${BASE}/test`, data).then((r) => r.data)
  },

  browseOpcua(connection: Record<string, unknown>, nodeId: string): Promise<OPCUABrowseNode[]> {
    return client.post<{ nodes: OPCUABrowseNode[] }>('/v1/discover/opcua/browse', { ...connection, nodeId }, { timeout: 60_000 })
      .then(r => r.data.nodes)
  },

  create(data: EndpointCreateData): Promise<Endpoint> {
    return client.post<{ endpoint: Endpoint }>(BASE, data, { timeout: data.protocol === 'opcua' && data.connection.deviceIdentification ? 120_000 : 10_000 }).then((r) => r.data.endpoint)
  },

  update(uuid: string, data: EndpointUpdateData): Promise<Endpoint> {
    return client.patch<{ endpoint: Endpoint }>(`${BASE}/${uuid}`, data).then((r) => r.data.endpoint)
  },

  replace(uuid: string, data: EndpointCreateData): Promise<Endpoint> {
    return client.put<{ endpoint: Endpoint }>(`${BASE}/${uuid}`, data, { timeout: data.protocol === 'opcua' && data.connection.deviceIdentification ? 120_000 : 10_000 }).then((r) => r.data.endpoint)
  },

  remove(uuid: string): Promise<void> {
    return client.delete(`${BASE}/${uuid}`).then(() => undefined)
  },

  removeAll(): Promise<{ removed: number }> {
    return client.delete<{ removed: number }>(BASE).then((r) => r.data)
  },
}
