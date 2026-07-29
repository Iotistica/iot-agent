import { client } from './client'
import type { MaintenanceRule, MaintenanceRuleFormData, MaintenanceRecommendation, RecommendationStatus, RecommendationPublishSettings } from '@/types'

const RULES_BASE = '/v1/maintenance/rules'
const RECS_BASE = '/v1/maintenance/recommendations'
const PUBLISH_SETTINGS_BASE = '/v1/maintenance/publish-settings'

export const maintenanceApi = {
  getRules(): Promise<MaintenanceRule[]> {
    return client.get<{ rules: MaintenanceRule[] }>(RULES_BASE).then((r) => r.data.rules)
  },

  createRule(data: MaintenanceRuleFormData): Promise<MaintenanceRule> {
    return client.post<{ rule: MaintenanceRule }>(RULES_BASE, data).then((r) => r.data.rule)
  },

  updateRule(id: number, data: Partial<MaintenanceRuleFormData>): Promise<MaintenanceRule> {
    return client.patch<{ rule: MaintenanceRule }>(`${RULES_BASE}/${id}`, data).then((r) => r.data.rule)
  },

  removeRule(id: number): Promise<void> {
    return client.delete(`${RULES_BASE}/${id}`).then(() => undefined)
  },

  getRecommendations(): Promise<MaintenanceRecommendation[]> {
    return client.get<{ recommendations: MaintenanceRecommendation[] }>(RECS_BASE).then((r) => r.data.recommendations)
  },

  updateRecommendationStatus(id: number, status: RecommendationStatus): Promise<MaintenanceRecommendation> {
    return client.patch<{ recommendation: MaintenanceRecommendation }>(`${RECS_BASE}/${id}`, { status }).then((r) => r.data.recommendation)
  },

  getPublishSettings(): Promise<RecommendationPublishSettings> {
    return client.get<{ settings: RecommendationPublishSettings }>(PUBLISH_SETTINGS_BASE).then((r) => r.data.settings)
  },

  updatePublishSettings(data: Partial<Omit<RecommendationPublishSettings, 'module'>>): Promise<RecommendationPublishSettings> {
    return client.patch<{ settings: RecommendationPublishSettings }>(PUBLISH_SETTINGS_BASE, data).then((r) => r.data.settings)
  },
}
