<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { PlusOutlined, DeleteOutlined, BellOutlined } from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import MaintenanceRuleDrawer from '@/components/maintenance/MaintenanceRuleDrawer.vue'
import SettingsSection from '@/components/settings/SettingsSection.vue'
import SettingsField from '@/components/settings/SettingsField.vue'
import type { MaintenanceRule, MaintenanceRecommendation, RecommendationStatus, RecommendationPublishSettings, Destination } from '@/types'
import { maintenanceApi } from '@/api/maintenance'
import { destinationsApi } from '@/api/destinations'

const CRITICALITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
const CRITICALITY_TAG_COLOR: Record<string, string> = { critical: 'red', high: 'orange', medium: 'blue', low: 'default' }
const STATUS_TAG_COLOR: Record<string, string> = { open: 'processing', scheduled: 'gold', completed: 'success', dismissed: 'default' }

const activeTab = ref('rules')

const publishSettings = ref<RecommendationPublishSettings | null>(null)
const publishSettingsLoading = ref(false)
const publishSettingsSaving = ref(false)
const mqttDestinations = ref<Destination[]>([])

const rules = ref<MaintenanceRule[]>([])
const rulesLoading = ref(false)
const drawerOpen = ref(false)
const editing = ref<MaintenanceRule | null>(null)

const recommendations = ref<MaintenanceRecommendation[]>([])
const recsLoading = ref(false)

const ruleColumns: TableColumnType<MaintenanceRule>[] = [
  { title: 'Asset', key: 'asset', ellipsis: true, minWidth: 140 },
  { title: 'Component', dataIndex: 'component', key: 'component', width: 130, ellipsis: true },
  { title: 'Rule type', key: 'rule_type', width: 150 },
  { title: 'Enabled', key: 'enabled', width: 90 },
  { title: 'Actions', key: 'actions', width: 110, fixed: 'right' },
]

const recColumns: TableColumnType<MaintenanceRecommendation>[] = [
  { title: 'Criticality', key: 'criticality', width: 100 },
  { title: 'Asset', dataIndex: 'asset_name', key: 'asset_name', ellipsis: true, minWidth: 140 },
  { title: 'Component', dataIndex: 'component', key: 'component', width: 130, ellipsis: true },
  { title: 'Message', dataIndex: 'message', key: 'message', ellipsis: true, minWidth: 220 },
  { title: 'Due by', key: 'due_by', width: 140 },
  { title: 'Status', key: 'status', width: 110 },
  { title: 'Actions', key: 'actions', width: 220, fixed: 'right' },
]

function ruleTypeLabel(ruleType: string): string {
  return { cumulative_runtime: 'Cumulative runtime', cycle_count: 'Cycle count', threshold_duration: 'Threshold duration' }[ruleType] ?? ruleType
}

function fmtDate(ms: number | null): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString()
}

async function loadRules() {
  rulesLoading.value = true
  try {
    rules.value = await maintenanceApi.getRules()
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Failed to load maintenance rules')
  } finally {
    rulesLoading.value = false
  }
}

async function loadRecommendations() {
  recsLoading.value = true
  try {
    const rows = await maintenanceApi.getRecommendations()
    recommendations.value = rows.sort((a, b) => (CRITICALITY_ORDER[a.criticality] ?? 9) - (CRITICALITY_ORDER[b.criticality] ?? 9))
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Failed to load recommendations')
  } finally {
    recsLoading.value = false
  }
}

async function loadPublishSettings() {
  publishSettingsLoading.value = true
  try {
    const [settings, destinations] = await Promise.all([
      maintenanceApi.getPublishSettings(),
      destinationsApi.getAll(),
    ])
    publishSettings.value = settings
    mqttDestinations.value = destinations.filter((d) => d.type === 'mqtt')
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Failed to load alert routing settings')
  } finally {
    publishSettingsLoading.value = false
  }
}

async function savePublishSettings() {
  if (!publishSettings.value) return
  publishSettingsSaving.value = true
  try {
    publishSettings.value = await maintenanceApi.updatePublishSettings(publishSettings.value)
    message.success('Alert routing saved')
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Save failed')
  } finally {
    publishSettingsSaving.value = false
  }
}

function onTabChange(key: string) {
  activeTab.value = key
  if (key === 'recommendations') loadRecommendations()
  if (key === 'alert-routing' && !publishSettings.value) loadPublishSettings()
}

function openCreate() {
  editing.value = null
  drawerOpen.value = true
}

function openEdit(row: MaintenanceRule) {
  editing.value = row
  drawerOpen.value = true
}

function confirmDelete(row: MaintenanceRule) {
  Modal.confirm({
    title: `Delete rule for "${row.component}"?`,
    okType: 'danger',
    okText: 'Delete',
    async onOk() {
      await maintenanceApi.removeRule(row.id)
      message.success('Deleted')
      await loadRules()
    },
  })
}

async function setStatus(row: MaintenanceRecommendation, status: RecommendationStatus) {
  try {
    await maintenanceApi.updateRecommendationStatus(row.id, status)
    message.success('Updated')
    await loadRecommendations()
  } catch {
    message.error('Failed to update')
  }
}

onMounted(loadRules)
</script>

<template>
  <AppLayout title="Maintenance">
    <a-tabs :active-key="activeTab" @change="onTabChange">
      <a-tab-pane key="rules" tab="Rules">
        <div class="toolbar">
          <span style="color: #888; font-size: 13px">Which assets get watched, and by which rule.</span>
          <a-button type="primary" @click="openCreate">
            <template #icon><PlusOutlined /></template>
            New Rule
          </a-button>
        </div>

        <a-table :columns="ruleColumns" :data-source="rules" :loading="rulesLoading" :pagination="false" :scroll="{ x: 'max-content' }" row-key="id" size="middle">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'asset'">
              <span style="font-size: 13px">{{ record.asset_name ?? '—' }}</span>
            </template>
            <template v-else-if="column.key === 'rule_type'">
              <a-tag>{{ ruleTypeLabel(record.rule_type) }}</a-tag>
            </template>
            <template v-else-if="column.key === 'enabled'">
              <a-tag :color="record.enabled ? 'green' : 'default'">{{ record.enabled ? 'yes' : 'no' }}</a-tag>
            </template>
            <template v-else-if="column.key === 'actions'">
              <a-space>
                <a-button size="small" @click="openEdit(record)">Edit</a-button>
                <a-button size="small" danger @click="confirmDelete(record)">
                  <template #icon><DeleteOutlined /></template>
                </a-button>
              </a-space>
            </template>
          </template>
          <template #emptyText>
            <div style="padding: 24px 0; text-align: center; color: #aaa; font-size: 13px">
              No maintenance rules yet — add one against an asset to start getting recommendations.
            </div>
          </template>
        </a-table>
      </a-tab-pane>

      <a-tab-pane key="recommendations" tab="Recommendations">
        <a-table :columns="recColumns" :data-source="recommendations" :loading="recsLoading" :pagination="{ pageSize: 20, showSizeChanger: false }" row-key="id" size="middle">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'criticality'">
              <a-tag :color="CRITICALITY_TAG_COLOR[record.criticality]">{{ record.criticality }}</a-tag>
            </template>
            <template v-else-if="column.key === 'due_by'">
              <span style="font-size: 12px; color: #888">{{ fmtDate(record.due_by) }}</span>
            </template>
            <template v-else-if="column.key === 'status'">
              <a-badge :status="STATUS_TAG_COLOR[record.status] as any" :text="record.status" />
            </template>
            <template v-else-if="column.key === 'actions'">
              <a-space>
                <a-button v-if="record.status === 'open'" size="small" @click="setStatus(record, 'scheduled')">Schedule</a-button>
                <a-button v-if="record.status !== 'completed'" size="small" @click="setStatus(record, 'completed')">Complete</a-button>
                <a-button v-if="record.status !== 'dismissed'" size="small" @click="setStatus(record, 'dismissed')">Dismiss</a-button>
              </a-space>
            </template>
          </template>
          <template #emptyText>
            <div style="padding: 24px 0; text-align: center; color: #aaa; font-size: 13px">
              No open recommendations — nothing has crossed a rule threshold yet.
            </div>
          </template>
        </a-table>
      </a-tab-pane>

      <a-tab-pane key="alert-routing" tab="Alert Routing">
        <a-spin :spinning="publishSettingsLoading">
          <template v-if="publishSettings">
            <SettingsSection title="Alert routing" subtitle="Where new maintenance recommendations get published.">
              <template #icon><BellOutlined /></template>
              <a-row :gutter="[20, 20]">
                <a-col :xs="24" :sm="12" :lg="8">
                  <SettingsField label="Enable MQTT alerts">
                    <a-switch v-model:checked="publishSettings.mqtt" />
                  </SettingsField>
                </a-col>
                <a-col :xs="24" :sm="12" :lg="8">
                  <SettingsField label="MQTT destination" tooltip="Local broker from the Destinations page.">
                    <a-select
                      v-model:value="publishSettings.alert_destination_id"
                      allow-clear
                      :disabled="!publishSettings.mqtt"
                      placeholder="None"
                    >
                      <a-select-option v-for="d in mqttDestinations" :key="d.id" :value="d.id">{{ d.name }}</a-select-option>
                    </a-select>
                  </SettingsField>
                </a-col>
                <a-col :xs="24" :sm="12" :lg="8">
                  <SettingsField label="Alert topic" tooltip="Topic to publish to when a destination is selected.">
                    <a-input
                      v-model:value="publishSettings.alert_topic"
                      :disabled="!publishSettings.mqtt"
                      placeholder="iotistica/alerts/maintenance"
                    />
                  </SettingsField>
                </a-col>
                <a-col :xs="24" :sm="12" :lg="8">
                  <SettingsField label="Publish to cloud">
                    <a-switch v-model:checked="publishSettings.cloud" />
                  </SettingsField>
                </a-col>
              </a-row>
            </SettingsSection>
            <a-button type="primary" :loading="publishSettingsSaving" @click="savePublishSettings">Save</a-button>
          </template>
        </a-spin>
      </a-tab-pane>
    </a-tabs>

    <MaintenanceRuleDrawer v-model:open="drawerOpen" :editing="editing" @saved="loadRules" />
  </AppLayout>
</template>

<style scoped>
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  gap: 8px;
}
</style>
