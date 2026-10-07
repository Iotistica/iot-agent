import { client } from './client'

export interface TopicNode {
  name: string
  fullTopic: string
  count: number
  bytes: number
  lastMessage: string | null
  lastMessageAt: number | null
  messageType: 'json' | 'string' | 'binary'
  truncated: boolean
  retain: boolean
  qos: number
  children: Record<string, TopicNode>
}

export interface BrokerMetrics {
  connected: boolean
  version: string
  clients: { connected: number; total: number; maximum: number }
  messages: { received: number; sent: number; stored: number }
  bytes: { received: number; sent: number }
  subscriptions: number
  retainedMessages: number
  uptime: number
  messageRateIn: number
  messageRateOut: number
  throughputIn: number
  throughputOut: number
}

export interface BrokerStatus {
  connected: boolean
  topicCount: number
  messageCount: number
  monitoringTopics: string[]
}

export interface FlatTopic {
  name: string
  fullTopic: string
  count: number
  bytes: number
  lastMessage: string | null
  lastMessageAt: number | null
  messageType: 'json' | 'string' | 'binary'
  retain: boolean
  qos: number
}

/** List-row shape — omits `text` so polling the list is cheap. */
export interface HistoryListEntry {
  id: number
  ts: number
  bytes: number
  qos: number
  retain: boolean
  messageType: 'json' | 'string' | 'binary'
  truncated: boolean
}

/** Full entry, fetched one at a time only when a history row is clicked. */
export interface HistoryEntry extends HistoryListEntry {
  text: string
}

/** Latest compression result the publish pipeline recorded for this destination topic, if any. */
export interface CompressionSnapshot {
  topic: string
  method: string
  originalSize: number
  compressedSize: number
  savedBytes: number
  savedPercent: number
  compressionMs: number
  recordedAt: string
}

export const mqttApi = {
  getStatus(): Promise<BrokerStatus> {
    return client.get<BrokerStatus>('/v1/mqtt/broker/status').then(r => r.data)
  },
  getMetrics(): Promise<BrokerMetrics> {
    return client.get<BrokerMetrics>('/v1/mqtt/broker/metrics').then(r => r.data)
  },
  getTopicTree(): Promise<Record<string, TopicNode>> {
    return client.get<Record<string, TopicNode>>('/v1/mqtt/broker/topic-tree').then(r => r.data)
  },
  getTopics(): Promise<FlatTopic[]> {
    return client.get<FlatTopic[]>('/v1/mqtt/topics').then(r => r.data)
  },
  /** Side effect: registers `topic` as watched server-side (lazy/LRU — starts/keeps-alive history tracking). */
  getHistory(topic: string): Promise<{ topic: string; entries: HistoryListEntry[] }> {
    return client.get('/v1/mqtt/broker/history', { params: { topic } }).then(r => r.data)
  },
  getHistoryEntry(topic: string, id: number): Promise<HistoryEntry> {
    return client.get<HistoryEntry>(`/v1/mqtt/broker/history/${id}`, { params: { topic } }).then(r => r.data)
  },
  getCompression(topic: string): Promise<{ topic: string; snapshot: CompressionSnapshot | null }> {
    return client.get('/v1/mqtt/broker/compression', { params: { topic } }).then(r => r.data)
  },
}
