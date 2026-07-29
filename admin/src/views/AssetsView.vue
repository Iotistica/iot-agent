<script setup lang="ts">
import { ref } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { PlusOutlined, DeleteOutlined, BellOutlined } from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import AssetDrawer from '@/components/assets/AssetDrawer.vue'
import MaintenanceRuleDrawer from '@/components/maintenance/MaintenanceRuleDrawer.vue'
import EnergyRuleDrawer from '@/components/energy/EnergyRuleDrawer.vue'
import SettingsSection from '@/components/settings/SettingsSection.vue'
import SettingsField from '@/components/settings/SettingsField.vue'
import { useProStatus } from '@/composables/useProStatus'
import type {
  Asset,
  MaintenanceRule, MaintenanceRecommendation,
  EnergyRule, EnergyRecommendation,
  RecommendationStatus, RecommendationPublishSettings, Destination,
} from '@/types'
import { assetsApi } from '@/api/assets'
import { maintenanceApi } from '@/api/maintenance'
import { energyApi } from '@/api/energy'
import { destinationsApi } from '@/api/destinations'

const { proInstalled } = useProStatus()

// Shared across the Maintenance and Energy tabs — identical taxonomy in both.
const CRITICALITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }
const CRITICALITY_TAG_COLOR: Record<string, string> = { critical: 'red', high: 'orange', medium: 'blue', low: 'default' }
const STATUS_TAG_COLOR: Record<string, string> = { open: 'processing', scheduled: 'gold', completed: 'success', dismissed: 'default' }

// ── Top-level tabs (Assets | Maintenance | Energy — consolidated from three
// separate sidebar pages so each of the three areas is now one tab instead
// of its own menu entry). Maintenance/Energy still load lazily on first
// visit, same as before. ──────────────────────────────────────────────────
const activeTopTab = ref('assets')

function onTopTabChange(key: string) {
  activeTopTab.value = key
  if (key === 'maintenance' && !maintLoadedOnce.value) { maintLoadedOnce.value = true; loadMaintRules() }
  if (key === 'energy' && !energyLoadedOnce.value) { energyLoadedOnce.value = true; loadEnergyRules() }
}

const maintLoadedOnce = ref(false)
const energyLoadedOnce = ref(false)

// ══ Assets tab ═══════════════════════════════════════════════════════════

const ASSET_CRITICALITY_TAG_COLOR = CRITICALITY_TAG_COLOR

const assetRows = ref<Asset[]>([])
const assetsLoading = ref(false)
const assetsError = ref<string | null>(null)
const assetDrawerOpen = ref(false)
const assetEditing = ref<Asset | null>(null)

const assetColumns: TableColumnType<Asset>[] = [
  { title: 'Name', dataIndex: 'name', key: 'name', ellipsis: true, minWidth: 160 },
  { title: 'Equipment Type', dataIndex: 'asset_type', key: 'asset_type', width: 130, ellipsis: true },
  { title: 'Criticality', key: 'criticality', width: 100 },
  { title: 'Metrics', key: 'metrics', width: 90 },
  { title: 'Manufacturer / Model', key: 'manufacturer', width: 180, ellipsis: true },
  { title: 'Location', dataIndex: 'location', key: 'location', width: 140, ellipsis: true },
  { title: 'Actions', key: 'actions', width: 120, fixed: 'right' },
]

async function loadAssets() {
  assetsLoading.value = true
  assetsError.value = null
  try {
    assetRows.value = await assetsApi.getAll()
  } catch (err: unknown) {
    const e = err as { message?: string }
    assetsError.value = e?.message ?? 'Failed to load assets'
  } finally {
    assetsLoading.value = false
  }
}

function openCreateAsset() {
  assetEditing.value = null
  assetDrawerOpen.value = true
}

function openEditAsset(row: Asset) {
  assetEditing.value = row
  assetDrawerOpen.value = true
}

function confirmDeleteAsset(row: Asset) {
  Modal.confirm({
    title: `Delete "${row.name}"?`,
    content: row.metrics.length ? `This also removes its ${row.metrics.length} metric binding${row.metrics.length !== 1 ? 's' : ''}.` : undefined,
    okType: 'danger',
    okText: 'Delete',
    async onOk() {
      await assetsApi.remove(row.uuid)
      message.success('Deleted')
      await loadAssets()
    },
  })
}

function manufacturerModel(row: Asset): string {
  if (row.manufacturer && row.model) return `${row.manufacturer} / ${row.model}`
  return row.manufacturer || row.model || '—'
}

loadAssets()

// ══ Maintenance tab ══════════════════════════════════════════════════════

const maintActiveTab = ref('rules')

const maintPublishSettings = ref<RecommendationPublishSettings | null>(null)
const maintPublishSettingsLoading = ref(false)
const maintPublishSettingsSaving = ref(false)
const maintMqttDestinations = ref<Destination[]>([])

const maintRules = ref<MaintenanceRule[]>([])
const maintRulesLoading = ref(false)
const maintDrawerOpen = ref(false)
const maintEditing = ref<MaintenanceRule | null>(null)

const maintRecommendations = ref<MaintenanceRecommendation[]>([])
const maintRecsLoading = ref(false)

const maintRuleColumns: TableColumnType<MaintenanceRule>[] = [
  { title: 'Asset', key: 'asset', ellipsis: true, minWidth: 140 },
  { title: 'Component', dataIndex: 'component', key: 'component', width: 130, ellipsis: true },
  { title: 'Rule type', key: 'rule_type', width: 150 },
  { title: 'Enabled', key: 'enabled', width: 90 },
  { title: 'Actions', key: 'actions', width: 110, fixed: 'right' },
]

const maintRecColumns: TableColumnType<MaintenanceRecommendation>[] = [
  { title: 'Criticality', key: 'criticality', width: 100 },
  { title: 'Asset', dataIndex: 'asset_name', key: 'asset_name', ellipsis: true, minWidth: 140 },
  { title: 'Component', dataIndex: 'component', key: 'component', width: 130, ellipsis: true },
  { title: 'Message', dataIndex: 'message', key: 'message', ellipsis: true, minWidth: 220 },
  { title: 'Due by', key: 'due_by', width: 140 },
  { title: 'Status', key: 'status', width: 110 },
  { title: 'Actions', key: 'actions', width: 220, fixed: 'right' },
]

function maintRuleTypeLabel(ruleType: string): string {
  return { cumulative_runtime: 'Cumulative runtime', cycle_count: 'Cycle count', threshold_duration: 'Threshold duration' }[ruleType] ?? ruleType
}

function fmtDate(ms: number | null): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString()
}

async function loadMaintRules() {
  maintRulesLoading.value = true
  try {
    maintRules.value = await maintenanceApi.getRules()
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Failed to load maintenance rules')
  } finally {
    maintRulesLoading.value = false
  }
}

async function loadMaintRecommendations() {
  maintRecsLoading.value = true
  try {
    const rows = await maintenanceApi.getRecommendations()
    maintRecommendations.value = rows.sort((a, b) => (CRITICALITY_ORDER[a.criticality] ?? 9) - (CRITICALITY_ORDER[b.criticality] ?? 9))
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Failed to load recommendations')
  } finally {
    maintRecsLoading.value = false
  }
}

async function loadMaintPublishSettings() {
  maintPublishSettingsLoading.value = true
  try {
    const [settings, destinations] = await Promise.all([
      maintenanceApi.getPublishSettings(),
      destinationsApi.getAll(),
    ])
    maintPublishSettings.value = settings
    maintMqttDestinations.value = destinations.filter((d) => d.type === 'mqtt')
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Failed to load alert routing settings')
  } finally {
    maintPublishSettingsLoading.value = false
  }
}

async function saveMaintPublishSettings() {
  if (!maintPublishSettings.value) return
  maintPublishSettingsSaving.value = true
  try {
    maintPublishSettings.value = await maintenanceApi.updatePublishSettings(maintPublishSettings.value)
    message.success('Alert routing saved')
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Save failed')
  } finally {
    maintPublishSettingsSaving.value = false
  }
}

function onMaintTabChange(key: string) {
  maintActiveTab.value = key
  if (key === 'recommendations') loadMaintRecommendations()
  if (key === 'alert-routing' && !maintPublishSettings.value) loadMaintPublishSettings()
}

function openCreateMaintRule() {
  maintEditing.value = null
  maintDrawerOpen.value = true
}

function openEditMaintRule(row: MaintenanceRule) {
  maintEditing.value = row
  maintDrawerOpen.value = true
}

function confirmDeleteMaintRule(row: MaintenanceRule) {
  Modal.confirm({
    title: `Delete rule for "${row.component}"?`,
    okType: 'danger',
    okText: 'Delete',
    async onOk() {
      await maintenanceApi.removeRule(row.id)
      message.success('Deleted')
      await loadMaintRules()
    },
  })
}

async function setMaintStatus(row: MaintenanceRecommendation, status: RecommendationStatus) {
  try {
    await maintenanceApi.updateRecommendationStatus(row.id, status)
    message.success('Updated')
    await loadMaintRecommendations()
  } catch {
    message.error('Failed to update')
  }
}

// ══ Energy tab ═══════════════════════════════════════════════════════════

const energyActiveTab = ref('rules')

const energyPublishSettings = ref<RecommendationPublishSettings | null>(null)
const energyPublishSettingsLoading = ref(false)
const energyPublishSettingsSaving = ref(false)
const energyMqttDestinations = ref<Destination[]>([])

const energyRules = ref<EnergyRule[]>([])
const energyRulesLoading = ref(false)
const energyDrawerOpen = ref(false)
const energyEditing = ref<EnergyRule | null>(null)

const energyRecommendations = ref<EnergyRecommendation[]>([])
const energyRecsLoading = ref(false)

const energyRuleColumns: TableColumnType<EnergyRule>[] = [
  { title: 'Asset', key: 'asset', ellipsis: true, minWidth: 140 },
  { title: 'Metric', dataIndex: 'metric', key: 'metric', width: 150, ellipsis: true },
  { title: 'Rule type', key: 'rule_type', width: 150 },
  { title: 'Enabled', key: 'enabled', width: 90 },
  { title: 'Actions', key: 'actions', width: 110, fixed: 'right' },
]

const energyRecColumns: TableColumnType<EnergyRecommendation>[] = [
  { title: 'Criticality', key: 'criticality', width: 100 },
  { title: 'Asset', dataIndex: 'asset_name', key: 'asset_name', ellipsis: true, minWidth: 140 },
  { title: 'Metric', dataIndex: 'metric', key: 'metric', width: 140, ellipsis: true },
  { title: 'Message', dataIndex: 'message', key: 'message', ellipsis: true, minWidth: 200 },
  { title: 'Est. impact', dataIndex: 'estimated_impact', key: 'estimated_impact', width: 120 },
  { title: 'Status', key: 'status', width: 110 },
  { title: 'Actions', key: 'actions', width: 220, fixed: 'right' },
]

function energyRuleTypeLabel(ruleType: string): string {
  return { standby_waste: 'Standby waste', schedule_mismatch: 'Schedule mismatch', duty_cycle: 'Duty cycle' }[ruleType] ?? ruleType
}

async function loadEnergyRules() {
  energyRulesLoading.value = true
  try {
    energyRules.value = await energyApi.getRules()
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Failed to load energy rules')
  } finally {
    energyRulesLoading.value = false
  }
}

async function loadEnergyRecommendations() {
  energyRecsLoading.value = true
  try {
    const rows = await energyApi.getRecommendations()
    energyRecommendations.value = rows.sort((a, b) => (CRITICALITY_ORDER[a.criticality] ?? 9) - (CRITICALITY_ORDER[b.criticality] ?? 9))
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Failed to load recommendations')
  } finally {
    energyRecsLoading.value = false
  }
}

async function loadEnergyPublishSettings() {
  energyPublishSettingsLoading.value = true
  try {
    const [settings, destinations] = await Promise.all([
      energyApi.getPublishSettings(),
      destinationsApi.getAll(),
    ])
    energyPublishSettings.value = settings
    energyMqttDestinations.value = destinations.filter((d) => d.type === 'mqtt')
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Failed to load alert routing settings')
  } finally {
    energyPublishSettingsLoading.value = false
  }
}

async function saveEnergyPublishSettings() {
  if (!energyPublishSettings.value) return
  energyPublishSettingsSaving.value = true
  try {
    energyPublishSettings.value = await energyApi.updatePublishSettings(energyPublishSettings.value)
    message.success('Alert routing saved')
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Save failed')
  } finally {
    energyPublishSettingsSaving.value = false
  }
}

function onEnergyTabChange(key: string) {
  energyActiveTab.value = key
  if (key === 'recommendations') loadEnergyRecommendations()
  if (key === 'alert-routing' && !energyPublishSettings.value) loadEnergyPublishSettings()
}

function openCreateEnergyRule() {
  energyEditing.value = null
  energyDrawerOpen.value = true
}

function openEditEnergyRule(row: EnergyRule) {
  energyEditing.value = row
  energyDrawerOpen.value = true
}

function confirmDeleteEnergyRule(row: EnergyRule) {
  Modal.confirm({
    title: `Delete rule for "${row.metric}"?`,
    okType: 'danger',
    okText: 'Delete',
    async onOk() {
      await energyApi.removeRule(row.id)
      message.success('Deleted')
      await loadEnergyRules()
    },
  })
}

async function setEnergyStatus(row: EnergyRecommendation, status: RecommendationStatus) {
  try {
    await energyApi.updateRecommendationStatus(row.id, status)
    message.success('Updated')
    await loadEnergyRecommendations()
  } catch {
    message.error('Failed to update')
  }
}
</script>

<template>
  <AppLayout title="Assets">
    <a-tabs :active-key="activeTopTab" @change="onTopTabChange">
      <!-- ══ ASSETS ═══════════════════════════════════════════════════════ -->
      <a-tab-pane key="assets" tab="Assets">
        <div class="toolbar">
          <span style="color: #888; font-size: 13px">
            The equipment behind your metrics — criticality drives how maintenance rules prioritize.
          </span>
          <a-button type="primary" @click="openCreateAsset">
            <template #icon><PlusOutlined /></template>
            New Asset
          </a-button>
        </div>

        <a-alert v-if="assetsError" type="error" :message="assetsError" show-icon style="margin-bottom: 16px" />

        <a-table
          :columns="assetColumns"
          :data-source="assetRows"
          :loading="assetsLoading"
          :pagination="false"
          :scroll="{ x: 'max-content' }"
          row-key="uuid"
          size="middle"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'criticality'">
              <a-tag :color="ASSET_CRITICALITY_TAG_COLOR[record.criticality]">{{ record.criticality }}</a-tag>
            </template>

            <template v-else-if="column.key === 'metrics'">
              <span style="color: #888; font-size: 12px">{{ record.metrics.length }}</span>
            </template>

            <template v-else-if="column.key === 'manufacturer'">
              <span style="font-size: 12px">{{ manufacturerModel(record) }}</span>
            </template>

            <template v-else-if="column.key === 'actions'">
              <a-space>
                <a-button size="small" @click="openEditAsset(record)">Edit</a-button>
                <a-button size="small" danger @click="confirmDeleteAsset(record)">
                  <template #icon><DeleteOutlined /></template>
                </a-button>
              </a-space>
            </template>
          </template>

          <template #emptyText>
            <div style="padding: 24px 0; text-align: center; color: #aaa; font-size: 13px">
              No assets yet — add one to start tying metrics to real equipment.
            </div>
          </template>
        </a-table>
      </a-tab-pane>

      <!-- ══ MAINTENANCE ══════════════════════════════════════════════════ -->
      <a-tab-pane key="maintenance">
        <template #tab>
          Maintenance
          <a-tag v-if="!proInstalled" class="pro-badge">PRO</a-tag>
        </template>

        <a-tabs :active-key="maintActiveTab" @change="onMaintTabChange">
          <a-tab-pane key="rules" tab="Rules">
            <div class="toolbar">
              <span style="color: #888; font-size: 13px">Which assets get watched, and by which rule.</span>
              <a-button type="primary" @click="openCreateMaintRule">
                <template #icon><PlusOutlined /></template>
                New Rule
              </a-button>
            </div>

            <a-table :columns="maintRuleColumns" :data-source="maintRules" :loading="maintRulesLoading" :pagination="false" :scroll="{ x: 'max-content' }" row-key="id" size="middle">
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'asset'">
                  <span style="font-size: 13px">{{ record.asset_name ?? '—' }}</span>
                </template>
                <template v-else-if="column.key === 'rule_type'">
                  <a-tag>{{ maintRuleTypeLabel(record.rule_type) }}</a-tag>
                </template>
                <template v-else-if="column.key === 'enabled'">
                  <a-tag :color="record.enabled ? 'green' : 'default'">{{ record.enabled ? 'yes' : 'no' }}</a-tag>
                </template>
                <template v-else-if="column.key === 'actions'">
                  <a-space>
                    <a-button size="small" @click="openEditMaintRule(record)">Edit</a-button>
                    <a-button size="small" danger @click="confirmDeleteMaintRule(record)">
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
            <a-table :columns="maintRecColumns" :data-source="maintRecommendations" :loading="maintRecsLoading" :pagination="{ pageSize: 20, showSizeChanger: false }" row-key="id" size="middle">
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
                    <a-button v-if="record.status === 'open'" size="small" @click="setMaintStatus(record, 'scheduled')">Schedule</a-button>
                    <a-button v-if="record.status !== 'completed'" size="small" @click="setMaintStatus(record, 'completed')">Complete</a-button>
                    <a-button v-if="record.status !== 'dismissed'" size="small" @click="setMaintStatus(record, 'dismissed')">Dismiss</a-button>
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
            <a-spin :spinning="maintPublishSettingsLoading">
              <template v-if="maintPublishSettings">
                <SettingsSection title="Alert routing" subtitle="Where new maintenance recommendations get published.">
                  <template #icon><BellOutlined /></template>
                  <a-row :gutter="[20, 20]">
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField label="Enable MQTT alerts">
                        <a-switch v-model:checked="maintPublishSettings.mqtt" />
                      </SettingsField>
                    </a-col>
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField label="MQTT destination" tooltip="Local broker from the Destinations page.">
                        <a-select
                          v-model:value="maintPublishSettings.alert_destination_id"
                          allow-clear
                          :disabled="!maintPublishSettings.mqtt"
                          placeholder="None"
                        >
                          <a-select-option v-for="d in maintMqttDestinations" :key="d.id" :value="d.id">{{ d.name }}</a-select-option>
                        </a-select>
                      </SettingsField>
                    </a-col>
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField label="Alert topic" tooltip="Topic to publish to when a destination is selected.">
                        <a-input
                          v-model:value="maintPublishSettings.alert_topic"
                          :disabled="!maintPublishSettings.mqtt"
                          placeholder="iotistica/alerts/maintenance"
                        />
                      </SettingsField>
                    </a-col>
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField label="Publish to cloud">
                        <a-switch v-model:checked="maintPublishSettings.cloud" />
                      </SettingsField>
                    </a-col>
                  </a-row>
                </SettingsSection>
                <a-button type="primary" :loading="maintPublishSettingsSaving" @click="saveMaintPublishSettings">Save</a-button>
              </template>
            </a-spin>
          </a-tab-pane>
        </a-tabs>
      </a-tab-pane>

      <!-- ══ ENERGY ═══════════════════════════════════════════════════════ -->
      <a-tab-pane key="energy">
        <template #tab>
          Energy
          <a-tag v-if="!proInstalled" class="pro-badge">PRO</a-tag>
        </template>

        <a-tabs :active-key="energyActiveTab" @change="onEnergyTabChange">
          <a-tab-pane key="rules" tab="Rules">
            <div class="toolbar">
              <span style="color: #888; font-size: 13px">Which assets get watched for energy waste, and by which rule.</span>
              <a-button type="primary" @click="openCreateEnergyRule">
                <template #icon><PlusOutlined /></template>
                New Rule
              </a-button>
            </div>

            <a-table :columns="energyRuleColumns" :data-source="energyRules" :loading="energyRulesLoading" :pagination="false" :scroll="{ x: 'max-content' }" row-key="id" size="middle">
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'asset'">
                  <span style="font-size: 13px">{{ record.asset_name ?? '—' }}</span>
                </template>
                <template v-else-if="column.key === 'rule_type'">
                  <a-tag>{{ energyRuleTypeLabel(record.rule_type) }}</a-tag>
                </template>
                <template v-else-if="column.key === 'enabled'">
                  <a-tag :color="record.enabled ? 'green' : 'default'">{{ record.enabled ? 'yes' : 'no' }}</a-tag>
                </template>
                <template v-else-if="column.key === 'actions'">
                  <a-space>
                    <a-button size="small" @click="openEditEnergyRule(record)">Edit</a-button>
                    <a-button size="small" danger @click="confirmDeleteEnergyRule(record)">
                      <template #icon><DeleteOutlined /></template>
                    </a-button>
                  </a-space>
                </template>
              </template>
              <template #emptyText>
                <div style="padding: 24px 0; text-align: center; color: #aaa; font-size: 13px">
                  No energy rules yet — add one against an asset to start getting recommendations.
                </div>
              </template>
            </a-table>
          </a-tab-pane>

          <a-tab-pane key="recommendations" tab="Recommendations">
            <a-table :columns="energyRecColumns" :data-source="energyRecommendations" :loading="energyRecsLoading" :pagination="{ pageSize: 20, showSizeChanger: false }" row-key="id" size="middle">
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'criticality'">
                  <a-tag :color="CRITICALITY_TAG_COLOR[record.criticality]">{{ record.criticality }}</a-tag>
                </template>
                <template v-else-if="column.key === 'status'">
                  <a-badge :status="STATUS_TAG_COLOR[record.status] as any" :text="record.status" />
                </template>
                <template v-else-if="column.key === 'actions'">
                  <a-space>
                    <a-button v-if="record.status === 'open'" size="small" @click="setEnergyStatus(record, 'scheduled')">Schedule</a-button>
                    <a-button v-if="record.status !== 'completed'" size="small" @click="setEnergyStatus(record, 'completed')">Complete</a-button>
                    <a-button v-if="record.status !== 'dismissed'" size="small" @click="setEnergyStatus(record, 'dismissed')">Dismiss</a-button>
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
            <a-spin :spinning="energyPublishSettingsLoading">
              <template v-if="energyPublishSettings">
                <SettingsSection title="Alert routing" subtitle="Where new energy recommendations get published.">
                  <template #icon><BellOutlined /></template>
                  <a-row :gutter="[20, 20]">
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField label="Enable MQTT alerts">
                        <a-switch v-model:checked="energyPublishSettings.mqtt" />
                      </SettingsField>
                    </a-col>
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField label="MQTT destination" tooltip="Local broker from the Destinations page.">
                        <a-select
                          v-model:value="energyPublishSettings.alert_destination_id"
                          allow-clear
                          :disabled="!energyPublishSettings.mqtt"
                          placeholder="None"
                        >
                          <a-select-option v-for="d in energyMqttDestinations" :key="d.id" :value="d.id">{{ d.name }}</a-select-option>
                        </a-select>
                      </SettingsField>
                    </a-col>
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField label="Alert topic" tooltip="Topic to publish to when a destination is selected.">
                        <a-input
                          v-model:value="energyPublishSettings.alert_topic"
                          :disabled="!energyPublishSettings.mqtt"
                          placeholder="iotistica/alerts/energy"
                        />
                      </SettingsField>
                    </a-col>
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField label="Publish to cloud">
                        <a-switch v-model:checked="energyPublishSettings.cloud" />
                      </SettingsField>
                    </a-col>
                  </a-row>
                </SettingsSection>
                <a-button type="primary" :loading="energyPublishSettingsSaving" @click="saveEnergyPublishSettings">Save</a-button>
              </template>
            </a-spin>
          </a-tab-pane>
        </a-tabs>
      </a-tab-pane>
    </a-tabs>

    <AssetDrawer v-model:open="assetDrawerOpen" :editing="assetEditing" @saved="loadAssets" />
    <MaintenanceRuleDrawer v-model:open="maintDrawerOpen" :editing="maintEditing" @saved="loadMaintRules" />
    <EnergyRuleDrawer v-model:open="energyDrawerOpen" :editing="energyEditing" @saved="loadEnergyRules" />
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

.pro-badge {
  margin-left: 6px;
  font-size: 10px;
  line-height: 14px;
  padding: 0 4px;
}
</style>
