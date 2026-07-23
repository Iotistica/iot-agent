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
  getEvents(limit = 100): Promise<ActivityEvent[]> {
    return client.get<{ events: ActivityEvent[] }>(`/v1/pipeline/events?limit=${limit}`).then(r => r.data.events)
  },
}
