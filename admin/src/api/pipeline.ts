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
