import { client } from './client'

export interface SubscriptionActivity {
  key: string
  subscriptionId: number | null
  destinationId: number
  destinationName: string
  destinationType: string
  protocol: string
  endpointName: string
  lastMetric: string
  lastValue: unknown
  lastUnit?: string
  lastQuality?: string
  pointCount: number
  totalBatches: number
  lastPublishTime: string
  // From Point Name Normalization — additive/optional, absent for readings the
  // interceptor skipped or predating this feature. provisionalPointId/rulesVersion
  // are carried for future developer tooling; DataFlowView.vue's standard UI only renders normalizedName.
  normalizedName?: string
  provisionalPointId?: string
  rulesVersion?: string
  // True protocol-reported name, when the adapter captured one separately from the
  // sanitized lastMetric identifier (currently BACnet only). Display-only.
  rawObjectName?: string
  rawPointName?: string
}

export interface ActivityEvent {
  id: number
  timestamp: string
  endpointName: string
  protocol: string
  metric: string
  value: unknown
  unit?: string
  quality?: string
  subscriptionId: number | null
  destinationId: number
  destinationName: string
  pointCount: number
  normalizedName?: string
  provisionalPointId?: string
  rulesVersion?: string
  rawObjectName?: string
  rawPointName?: string
}

export const pipelineApi = {
  getSubscriptions(): Promise<SubscriptionActivity[]> {
    return client.get<{ subscriptions: SubscriptionActivity[] }>('/v1/pipeline/subscriptions').then(r => r.data.subscriptions)
  },
  getEvents(limit = 100, protocol?: string): Promise<ActivityEvent[]> {
    const query = protocol ? `?limit=${limit}&protocol=${encodeURIComponent(protocol)}` : `?limit=${limit}`
    return client.get<{ events: ActivityEvent[] }>(`/v1/pipeline/events${query}`).then(r => r.data.events)
  },
  getThroughput(): Promise<Record<string, number>> {
    return client.get<{ counters: Record<string, number> }>('/v1/pipeline/throughput').then(r => r.data.counters)
  },
}
