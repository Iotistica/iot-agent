import { client } from './client'
import type { AgentEvent, AgentIncident, AgentAlert } from '@/types'

export type ResolutionReason = 'false_positive' | 'true_positive' | 'expected' | 'accepted'

export const RESOLUTION_REASON_LABELS: Record<ResolutionReason, string> = {
  false_positive: 'False positive',
  true_positive: 'True positive',
  expected: 'Expected behavior',
  accepted: 'Accepted risk',
}

export const eventsApi = {
  getEvents(params?: { source?: string; severity?: string; limit?: number; offset?: number }): Promise<{ events: AgentEvent[]; total: number }> {
    return client.get<{ events: AgentEvent[]; total: number }>('/v1/events', { params }).then((r) => r.data)
  },

  getIncidents(params?: { source?: string; status?: string; severity?: string; limit?: number; offset?: number }): Promise<{ incidents: AgentIncident[]; total: number }> {
    return client.get<{ incidents: AgentIncident[]; total: number }>('/v1/incidents', { params }).then((r) => r.data)
  },

  resolveIncident(incidentId: string, reason?: ResolutionReason, notes?: string): Promise<void> {
    return client.patch(`/v1/incidents/${incidentId}/resolve`, { reason, notes }).then(() => undefined)
  },

  getAlerts(params?: { source?: string; severity?: string; limit?: number; offset?: number }): Promise<{ alerts: AgentAlert[]; total: number }> {
    return client.get<{ alerts: AgentAlert[]; total: number }>('/v1/alerts', { params }).then((r) => r.data)
  },
}
