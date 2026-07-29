import { client } from './client'
import type { EnergyRule, EnergyRuleFormData, EnergyRecommendation, RecommendationStatus, RecommendationPublishSettings } from '@/types'

const RULES_BASE = '/v1/energy/rules'
const RECS_BASE = '/v1/energy/recommendations'
const PUBLISH_SETTINGS_BASE = '/v1/energy/publish-settings'

export const energyApi = {
  getRules(): Promise<EnergyRule[]> {
    return client.get<{ rules: EnergyRule[] }>(RULES_BASE).then((r) => r.data.rules)
  },

  createRule(data: EnergyRuleFormData): Promise<EnergyRule> {
    return client.post<{ rule: EnergyRule }>(RULES_BASE, data).then((r) => r.data.rule)
  },

  updateRule(id: number, data: Partial<EnergyRuleFormData>): Promise<EnergyRule> {
    return client.patch<{ rule: EnergyRule }>(`${RULES_BASE}/${id}`, data).then((r) => r.data.rule)
  },

  removeRule(id: number): Promise<void> {
    return client.delete(`${RULES_BASE}/${id}`).then(() => undefined)
  },

  getRecommendations(): Promise<EnergyRecommendation[]> {
    return client.get<{ recommendations: EnergyRecommendation[] }>(RECS_BASE).then((r) => r.data.recommendations)
  },

  updateRecommendationStatus(id: number, status: RecommendationStatus): Promise<EnergyRecommendation> {
    return client.patch<{ recommendation: EnergyRecommendation }>(`${RECS_BASE}/${id}`, { status }).then((r) => r.data.recommendation)
  },

  getPublishSettings(): Promise<RecommendationPublishSettings> {
    return client.get<{ settings: RecommendationPublishSettings }>(PUBLISH_SETTINGS_BASE).then((r) => r.data.settings)
  },

  updatePublishSettings(data: Partial<Omit<RecommendationPublishSettings, 'module'>>): Promise<RecommendationPublishSettings> {
    return client.patch<{ settings: RecommendationPublishSettings }>(PUBLISH_SETTINGS_BASE, data).then((r) => r.data.settings)
  },
}
