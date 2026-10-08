<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { message } from 'ant-design-vue'
import type { TableColumnType } from 'ant-design-vue'
import {
  SaveOutlined, ReloadOutlined, LinkOutlined, CheckCircleOutlined, WifiOutlined, EditOutlined,
  SafetyCertificateOutlined, BellOutlined, DatabaseOutlined, BranchesOutlined, QuestionCircleOutlined,
} from '@ant-design/icons-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import SettingsSection from '@/components/settings/SettingsSection.vue'
import SettingsField from '@/components/settings/SettingsField.vue'
import { useAuth } from '@/composables/useAuth'
import { settingsApi } from '@/api/settings'
import { client as apiClient } from '@/api/client'
import { dockerConfigApi } from '@/api/containers'
import type { DockerConfig } from '@/api/containers'
import type { AgentSettings, AnomalyConfig, Destination } from '@/types'
import { dashboardApi, type CanonicalUnit, type CustomUnitAlias } from '@/api/dashboard'
import { anomalyApi, type DriftOptions, type DriftAlertType } from '@/api/anomaly'
import { destinationsApi } from '@/api/destinations'

const route = useRoute()
const { hasRole } = useAuth()

const VALID_TABS = ['agent', 'features', 'logging', 'intervals', 'docker', 'mqtt-monitor', 'units', 'alerts']
const activeTab = ref(
  typeof route.query.tab === 'string' && VALID_TABS.includes(route.query.tab) ? route.query.tab : 'agent'
)

const loading = ref(false)
const saving = ref(false)
const saved = ref(false)
const loadError = ref<string | null>(null)

const settings = ref<AgentSettings>({})

// Deep clone for "discard changes" reset
let lastSaved: AgentSettings = {}

onMounted(() => { load(); loadDockerConfig(); loadCustomAliases(); loadAlertConfig(); loadAlertDrift() })

async function load() {
  loading.value = true
  loadError.value = null
  try {
    settings.value = await settingsApi.get()
    lastSaved = JSON.parse(JSON.stringify(settings.value))
    syncMqttForm()
  } catch (e: any) {
    loadError.value = e?.message ?? 'Failed to load settings'
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  saved.value = false
  try {
    // Omit the read-only `agent` field before sending
    const { agent: _agent, ...patch } = settings.value
    settings.value = await settingsApi.update(patch)
    lastSaved = JSON.parse(JSON.stringify(settings.value))
    saved.value = true
    message.success('Settings saved')
  } catch (e: any) {
    message.error(e?.message ?? 'Save failed')
  } finally {
    saving.value = false
  }
}

function discard() {
  settings.value = JSON.parse(JSON.stringify(lastSaved))
  saved.value = false
  message.info('Changes discarded')
}

// ── target sync toggle ────────────────────────────────────────────────────────

const targetSyncSaving = ref(false)

async function setTargetSync(enabled: boolean) {
  targetSyncSaving.value = true
  try {
    const { data } = await apiClient.patch('/v1/settings/target-sync', { enabled })
    settings.value = data.settings
    lastSaved = JSON.parse(JSON.stringify(settings.value))
    message.success(enabled ? 'Target sync enabled — agent will now pull cloud state' : 'Target sync disabled — agent reports only')
  } catch (e: any) {
    message.error(e?.message ?? 'Failed to update target sync')
  } finally {
    targetSyncSaving.value = false
  }
}

// ── provisioning ───────────────────────────────────────────────────────────────

const provisioning = ref(false)
const provisionForm = ref({ key: '', apiEndpoint: '', deviceName: '' })

async function provision() {
  if (!provisionForm.value.key.trim()) {
    message.error('Provisioning key is required')
    return
  }
  provisioning.value = true
  try {
    await settingsApi.provision({
      provisioningApiKey: provisionForm.value.key.trim(),
      ...(provisionForm.value.apiEndpoint.trim() ? { apiEndpoint: provisionForm.value.apiEndpoint.trim() } : {}),
      ...(provisionForm.value.deviceName.trim() ? { deviceName: provisionForm.value.deviceName.trim() } : {}),
    })
    message.success('Agent provisioned successfully')
    // Reload settings so Agent Info reflects the new provisioned state
    await load()
    provisionForm.value = { key: '', apiEndpoint: '', deviceName: '' }
  } catch (e: any) {
    message.error(e?.response?.data?.message ?? e?.message ?? 'Provisioning failed')
  } finally {
    provisioning.value = false
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────

function msToHuman(ms: number | undefined): string {
  if (ms == null) return ''
  if (ms >= 86_400_000) return `${ms / 86_400_000}d`
  if (ms >= 3_600_000) return `${ms / 3_600_000}h`
  if (ms >= 60_000) return `${ms / 60_000}m`
  return `${ms / 1000}s`
}

function ensureLogging() {
  if (!settings.value.logging) settings.value.logging = {}
}
function ensureFeatures() {
  if (!settings.value.features) settings.value.features = {}
}
function ensureIntervals() {
  if (!settings.value.intervals) settings.value.intervals = {}
  if (!settings.value.intervals.agent) settings.value.intervals.agent = {}
}
function ensureRuntime() {
  if (!settings.value.runtime) settings.value.runtime = {}
  if (!settings.value.runtime.memory) settings.value.runtime.memory = {}
}

// ── Docker daemon config ──────────────────────────────────────────────────────

const dockerConfig = ref<DockerConfig>({ type: 'socket' })
const dockerLoading = ref(false)
const dockerSaving = ref(false)
const dockerTesting = ref(false)
const dockerTestResult = ref<{ version: string; containers: number } | null>(null)
const dockerTestError = ref<string | null>(null)

async function loadDockerConfig() {
  dockerLoading.value = true
  try {
    dockerConfig.value = await dockerConfigApi.get()
  } catch {
    // non-fatal — defaults to socket
  } finally {
    dockerLoading.value = false
  }
}

async function saveDockerConfig() {
  dockerSaving.value = true
  dockerTestResult.value = null
  dockerTestError.value = null
  try {
    await dockerConfigApi.save(dockerConfig.value)
    message.success('Docker configuration saved')
  } catch (e: any) {
    message.error(e?.message ?? 'Failed to save Docker config')
  } finally {
    dockerSaving.value = false
  }
}

async function testDockerConnection() {
  dockerTesting.value = true
  dockerTestResult.value = null
  dockerTestError.value = null
  try {
    dockerTestResult.value = await dockerConfigApi.test(dockerConfig.value)
  } catch (e: any) {
    dockerTestError.value = e?.response?.data?.error ?? e?.message ?? 'Connection failed'
  } finally {
    dockerTesting.value = false
  }
}

function onDockerTypeChange() {
  dockerTestResult.value = null
  dockerTestError.value = null
}

// ── MQTT Broker Monitor config ────────────────────────────────────────────────

const mqttForm = ref({ url: 'mqtt://localhost:1883', username: 'admin', password: '' })
const mqttSaving = ref(false)
const mqttTesting = ref(false)
const mqttTestResult = ref<{ connected: boolean; topicCount: number } | null>(null)
const mqttTestError = ref<string | null>(null)

// Populate from loaded settings
function syncMqttForm() {
  const m = settings.value.mqttMonitor
  if (m?.url) mqttForm.value.url = m.url
  if (m?.username !== undefined) mqttForm.value.username = m.username
  // Never pre-fill password from API
}

async function saveMqttConfig() {
  mqttSaving.value = true
  mqttTestResult.value = null
  mqttTestError.value = null
  try {
    await apiClient.patch('/v1/mqtt/broker/config', {
      url:      mqttForm.value.url.trim(),
      username: mqttForm.value.username,
      password: mqttForm.value.password,
    })
    message.success('MQTT broker configuration saved')
  } catch (e: any) {
    message.error(e?.response?.data?.error ?? e?.message ?? 'Save failed')
  } finally {
    mqttSaving.value = false
  }
}

async function testMqttConnection() {
  mqttTesting.value = true
  mqttTestResult.value = null
  mqttTestError.value = null
  try {
    const { data } = await apiClient.post('/v1/mqtt/broker/test', {
      url:      mqttForm.value.url.trim(),
      username: mqttForm.value.username,
      password: mqttForm.value.password,
    })
    if (data.ok) {
      mqttTestResult.value = { connected: true, topicCount: 0 }
    } else {
      mqttTestError.value = data.error ?? 'Connection failed'
    }
  } catch (e: any) {
    mqttTestError.value = e?.response?.data?.error ?? e?.message ?? 'Test failed'
  } finally {
    mqttTesting.value = false
  }
}

// ── Units: custom unit mappings ─────────────────────────────────────────────
// Admin-created unit aliases (the Dashboard's Normalization Health "Resolve"
// action) — view/edit only here, reusing that same backend infrastructure
// (custom_unit_aliases table, POST /v1/normalization-health/resolve-unit).
// No create/delete in v1 — creating happens via Resolve on the Dashboard.

const customAliasColumns: TableColumnType<CustomUnitAlias>[] = [
  { title: 'Alias', dataIndex: 'alias', key: 'alias', ellipsis: true },
  { title: 'Protocol / Source System', key: 'source_system', width: 180 },
  { title: 'Canonical Unit', dataIndex: 'canonical_unit', key: 'canonical_unit', width: 180 },
  { title: 'Actions', key: 'actions', width: 90 },
]

const customAliases = ref<CustomUnitAlias[]>([])
const customAliasesLoading = ref(false)

async function loadCustomAliases() {
  customAliasesLoading.value = true
  try {
    customAliases.value = await dashboardApi.getCustomUnitAliases()
  } catch (e: any) {
    message.error(e?.message ?? 'Failed to load custom unit mappings')
  } finally {
    customAliasesLoading.value = false
  }
}

const canonicalUnits = ref<CanonicalUnit[]>([])
const canonicalUnitsLoaded = ref(false)
const canonicalUnitOptions = computed(() =>
  canonicalUnits.value.map((u) => ({
    value: u.canonical_unit,
    label: u.symbol ? `${u.canonical_unit} (${u.symbol})` : u.canonical_unit,
  })),
)

function ensureCanonicalUnitsLoaded() {
  if (canonicalUnitsLoaded.value) return
  dashboardApi.getCanonicalUnits()
    .then((units) => {
      canonicalUnits.value = units
      canonicalUnitsLoaded.value = true
    })
    .catch(() => {
      /* the picker will just show no options; not fatal */
    })
}

const editAliasModalOpen = ref(false)
const editAliasTarget = ref<CustomUnitAlias | null>(null)
const editAliasCanonicalUnit = ref<string | undefined>(undefined)
const editAliasSaving = ref(false)

function openEditAlias(row: CustomUnitAlias) {
  ensureCanonicalUnitsLoaded()
  editAliasTarget.value = row
  editAliasCanonicalUnit.value = row.canonical_unit
  editAliasModalOpen.value = true
}

function closeEditAlias() {
  editAliasModalOpen.value = false
  editAliasTarget.value = null
}

async function submitEditAlias() {
  if (!editAliasTarget.value || !editAliasCanonicalUnit.value) return
  editAliasSaving.value = true
  try {
    await dashboardApi.resolveUnknownUnit(editAliasTarget.value.alias, editAliasTarget.value.source_system, editAliasCanonicalUnit.value)
    message.success(`"${editAliasTarget.value.alias}" now maps to ${editAliasCanonicalUnit.value}`)
    closeEditAlias()
    await loadCustomAliases()
  } catch (err: any) {
    message.error(err?.message ?? 'Failed to update mapping')
  } finally {
    editAliasSaving.value = false
  }
}

function setLogging<K extends keyof NonNullable<AgentSettings['logging']>>(
  key: K,
  val: NonNullable<AgentSettings['logging']>[K],
) {
  ensureLogging()
  settings.value.logging![key] = val
}
function setFeature<K extends keyof NonNullable<AgentSettings['features']>>(
  key: K,
  val: NonNullable<AgentSettings['features']>[K],
) {
  ensureFeatures()
  settings.value.features![key] = val
}
function setAgentInterval<K extends keyof NonNullable<NonNullable<AgentSettings['intervals']>['agent']>>(
  key: K,
  val: number,
) {
  ensureIntervals()
  settings.value.intervals!.agent![key] = val
}
function setMemory<K extends keyof NonNullable<NonNullable<AgentSettings['runtime']>['memory']>>(
  key: K,
  val: number,
) {
  ensureRuntime()
  settings.value.runtime!.memory![key] = val
}

// ── Alerts (anomaly detection + schema drift) config ─────────────────────────
const alertConfig = ref<AnomalyConfig | null>(null)
const alertConfigLoading = ref(false)
const alertConfigSaving = ref(false)
const alertMqttDestinations = ref<Destination[]>([])

async function loadAlertConfig() {
  alertConfigLoading.value = true
  try {
    const [cfg, dests] = await Promise.all([
      anomalyApi.getConfig(),
      destinationsApi.getAll(),
    ])
    alertConfig.value = cfg
    alertMqttDestinations.value = dests.filter((d) => d.type === 'mqtt')
  } catch {
    // non-fatal
  } finally {
    alertConfigLoading.value = false
  }
}

function resetAlertDetectionDefaults() {
  if (!alertConfig.value) return
  alertConfig.value.sensitivity = 5
  alertConfig.value.warmupPeriodMs = 900_000
  alertConfig.value.alerts.minConfidence = 0.7
  alertConfig.value.alerts.cooldownMs = 300_000
  alertConfig.value.alerts.maxQueueSize = 1000
}

// ── Schema Drift settings ────────────────────────────────────────────────────
const DRIFT_ALERT_TYPE_OPTIONS: { value: DriftAlertType; label: string; hint: string }[] = [
  { value: 'missing-field', label: 'Missing field', hint: 'A field stopped appearing — usually real breakage.' },
  { value: 'type-drift', label: 'Type drift', hint: "A field's value type changed unexpectedly — usually real breakage." },
  { value: 'new-field', label: 'New field', hint: 'A field appeared that wasn’t in the learned baseline — often just normal growth.' },
  { value: 'rename-candidate', label: 'Rename candidate', hint: 'A missing field and a new field look like they might be the same field renamed.' },
]
const DEFAULT_ALERT_DRIFT_TYPES: DriftAlertType[] = ['missing-field', 'type-drift']

const globalDrift = ref<DriftOptions>({})
const driftLoading = ref(false)


async function loadAlertDrift() {
  driftLoading.value = true
  try {
    const { outputs } = await anomalyApi.getProtocolOutputs()
    const withDrift = outputs.find((o) => o.drift_options)
    globalDrift.value = withDrift?.drift_options ?? {}
  } catch {
    // non-fatal
  } finally {
    driftLoading.value = false
  }
}

function setDrift<K extends keyof DriftOptions>(key: K, val: DriftOptions[K]) {
  globalDrift.value[key] = val
}

// ── Sensitivity presets ──────────────────────────────────────────────────────
type SensitivityLevel = 'low' | 'standard' | 'high'

type SensitivityFields = Required<Pick<DriftOptions,
  'consecutiveMissingThreshold' | 'minFieldPresenceRatio' | 'adaptivePromotionBatches' |
  'adaptivePromotionMinElapsedMs' | 'minTypeDominanceRatio'
>>

const SENSITIVITY_PRESETS: Record<SensitivityLevel, SensitivityFields> = {
  low: {
    consecutiveMissingThreshold: 30,
    minFieldPresenceRatio: 0.2,
    adaptivePromotionBatches: 20,
    adaptivePromotionMinElapsedMs: 300_000,
    minTypeDominanceRatio: 0.1,
  },
  standard: {
    consecutiveMissingThreshold: 10,
    minFieldPresenceRatio: 0.5,
    adaptivePromotionBatches: 50,
    adaptivePromotionMinElapsedMs: 600_000,
    minTypeDominanceRatio: 0.15,
  },
  high: {
    consecutiveMissingThreshold: 3,
    minFieldPresenceRatio: 0.8,
    adaptivePromotionBatches: 100,
    adaptivePromotionMinElapsedMs: 1_800_000,
    minTypeDominanceRatio: 0.25,
  },
}

const SENSITIVITY_LEVELS: SensitivityLevel[] = ['low', 'standard', 'high']

const selectedSensitivity = computed<SensitivityLevel | 'custom'>(() => {
  for (const level of SENSITIVITY_LEVELS) {
    const preset = SENSITIVITY_PRESETS[level]
    const matches = (Object.keys(preset) as Array<keyof SensitivityFields>).every(
      (key) => (globalDrift.value[key] ?? SENSITIVITY_PRESETS.standard[key]) === preset[key],
    )
    if (matches) return level
  }
  return 'custom'
})

function setSensitivityPreset(level: SensitivityLevel) {
  const preset = SENSITIVITY_PRESETS[level]
  for (const key of Object.keys(preset) as Array<keyof SensitivityFields>) {
    setDrift(key, preset[key])
  }
}


const ALERT_FREQUENCY_OPTIONS: { value: number; label: string }[] = [
  { value: 5 * 60_000, label: '5 minutes' },
  { value: 15 * 60_000, label: '15 minutes' },
  { value: 30 * 60_000, label: '30 minutes' },
  { value: 60 * 60_000, label: '1 hour' },
  { value: 6 * 60 * 60_000, label: '6 hours' },
  { value: 24 * 60 * 60_000, label: '24 hours' },
]

function fmtCustomCooldown(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  return minutes < 60 ? `${minutes}m` : `${(minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1)}h`
}

const alertFrequencyOptions = computed(() => {
  const current = globalDrift.value.alertCooldownMs ?? 1_800_000
  if (ALERT_FREQUENCY_OPTIONS.some((o) => o.value === current)) return ALERT_FREQUENCY_OPTIONS
  return [...ALERT_FREQUENCY_OPTIONS, { value: current, label: `Custom (${fmtCustomCooldown(current)})` }]
})

async function saveAllAlertConfig() {
  alertConfigSaving.value = true
  try {
    const tasks: Promise<unknown>[] = [
      anomalyApi.updateDrift(globalDrift.value),
    ]
    if (alertConfig.value) {
      tasks.push(anomalyApi.updateConfig(alertConfig.value).then((c) => { alertConfig.value = c }))
    }
    await Promise.all(tasks)
    message.success('Configuration saved')
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Save failed')
  } finally {
    alertConfigSaving.value = false
  }
}
</script>

<template>
  <AppLayout title="Settings">

    <!-- Global alerts -->
    <a-alert
      v-if="saved"
      type="info"
      show-icon
      message="Settings saved — changes take effect on the next reconciliation cycle (~30 seconds)."
      closable
      style="margin-bottom: 16px"
      @close="saved = false"
    />
    <a-alert
      v-if="loadError"
      type="error"
      show-icon
      :message="loadError"
      style="margin-bottom: 16px"
    >
      <template #action>
        <a-button size="small" @click="load">
          <template #icon><ReloadOutlined /></template>
          Retry
        </a-button>
      </template>
    </a-alert>

    <a-spin :spinning="loading">
      <a-tabs v-model:active-key="activeTab">

        <!-- ══ AGENT ══════════════════════════════════════════════════════════ -->
        <a-tab-pane key="agent" tab="Agent">
          <a-card size="small">
            <a-descriptions :column="2" size="small" bordered>
              <a-descriptions-item label="UUID" :span="2">
                <a-typography-text copyable :content="settings.agent?.uuid ?? '—'">
                  {{ settings.agent?.uuid ?? '—' }}
                </a-typography-text>
              </a-descriptions-item>
              <a-descriptions-item label="Name">{{ settings.agent?.name ?? '—' }}</a-descriptions-item>
              <a-descriptions-item label="Type">{{ settings.agent?.type ?? '—' }}</a-descriptions-item>
              <a-descriptions-item label="Version">
                <a-tag v-if="settings.agent?.version" color="blue">v{{ settings.agent.version }}</a-tag>
                <span v-else>—</span>
              </a-descriptions-item>
              <a-descriptions-item label="Status">
                <a-badge
                  :status="settings.agent?.provisioned ? 'success' : 'default'"
                  :text="settings.agent?.provisioned ? 'Provisioned' : 'Not provisioned'"
                />
              </a-descriptions-item>
              <a-descriptions-item label="Tenant ID">{{ settings.agent?.tenantId ?? '—' }}</a-descriptions-item>
              <a-descriptions-item label="Registered at">
                {{ settings.agent?.registeredAt ? new Date(settings.agent.registeredAt).toLocaleString() : '—' }}
              </a-descriptions-item>
              <template v-if="settings.agent?.macAddress">
                <a-descriptions-item label="MAC address">{{ settings.agent.macAddress }}</a-descriptions-item>
              </template>
              <template v-if="settings.agent?.osVersion">
                <a-descriptions-item label="OS version">{{ settings.agent.osVersion }}</a-descriptions-item>
              </template>
              <template v-if="settings.agent?.provisioned">
                <a-descriptions-item label="API endpoint" :span="2">
                  <a-typography-text copyable :content="settings.agent.apiEndpoint ?? '—'">
                    {{ settings.agent.apiEndpoint ?? '—' }}
                  </a-typography-text>
                </a-descriptions-item>
                <a-descriptions-item label="MQTT broker" :span="2">
                  <a-typography-text copyable :content="settings.agent.mqttBrokerUrl ?? '—'">
                    {{ settings.agent.mqttBrokerUrl ?? '—' }}
                  </a-typography-text>
                </a-descriptions-item>
                <a-descriptions-item label="MQTT username">
                  <a-typography-text copyable :content="settings.agent.mqttUsername ?? '—'">
                    {{ settings.agent.mqttUsername ?? '—' }}
                  </a-typography-text>
                </a-descriptions-item>
                <a-descriptions-item label="MQTT TLS">
                  <a-badge
                    :status="settings.agent.mqttUseTls ? 'success' : 'default'"
                    :text="settings.agent.mqttUseTls === null ? '—' : settings.agent.mqttUseTls ? 'Enabled' : 'Disabled'"
                  />
                </a-descriptions-item>
                <a-descriptions-item label="MQTT client ID prefix" :span="2">
                  <a-typography-text copyable :content="settings.agent.mqttClientIdPrefix ?? '—'">
                    {{ settings.agent.mqttClientIdPrefix ?? '—' }}
                  </a-typography-text>
                </a-descriptions-item>
                <a-descriptions-item label="Cloud target sync" :span="2">
                  <div style="display: flex; align-items: center; gap: 12px">
                    <a-switch
                      :checked="settings.agent.targetSyncEnabled !== false"
                      :loading="targetSyncSaving"
                      @change="(v: boolean) => setTargetSync(v)"
                    />
                    <span style="font-size: 12px; color: rgba(0,0,0,.45)">
                      {{ settings.agent.targetSyncEnabled !== false
                        ? 'Pulling target state from cloud'
                        : 'Report-only — cloud cannot push config changes' }}
                    </span>
                  </div>
                </a-descriptions-item>
              </template>
            </a-descriptions>

            <template v-if="!settings.agent?.provisioned">
              <a-divider style="margin: 16px 0 12px" />
              <p style="margin: 0 0 12px; font-size: 13px; font-weight: 600; color: rgba(0,0,0,.65)">
                Connect to Iotistica
              </p>
              <a-row :gutter="[12, 12]">
                <a-col :span="24">
                  <a-form-item label="Provisioning key" style="margin-bottom: 0" required>
                    <a-input-password
                      v-model:value="provisionForm.key"
                      placeholder="Paste your provisioning key"
                      :disabled="provisioning"
                    />
                  </a-form-item>
                </a-col>
                <a-col :span="12">
                  <a-form-item label="API endpoint" style="margin-bottom: 0">
                    <a-input
                      v-model:value="provisionForm.apiEndpoint"
                      placeholder="https://api.iotistica.com (optional)"
                      :disabled="provisioning"
                    />
                  </a-form-item>
                </a-col>
                <a-col :span="12">
                  <a-form-item label="Device name" style="margin-bottom: 0">
                    <a-input
                      v-model:value="provisionForm.deviceName"
                      placeholder="Optional override"
                      :disabled="provisioning"
                    />
                  </a-form-item>
                </a-col>
                <a-col :span="24" style="display: flex; justify-content: flex-end">
                  <a-button
                    type="primary"
                    :loading="provisioning"
                    :disabled="!provisionForm.key.trim()"
                    @click="provision"
                  >
                    <template #icon><LinkOutlined /></template>
                    {{ provisioning ? 'Connecting…' : 'Connect to Iotistica' }}
                  </a-button>
                </a-col>
              </a-row>
            </template>
          </a-card>
        </a-tab-pane>

        <!-- ══ FEATURES ═══════════════════════════════════════════════════════ -->
        <a-tab-pane key="features" tab="Features">
          <a-card size="small">
            <a-space direction="vertical" style="width: 100%">
              <div class="toggle-row">
                <div>
                  <div class="toggle-label">Data Publishing</div>
                  <div class="toggle-desc">Automatically publish device data to MQTT broker</div>
                </div>
                <a-switch
                  :checked="settings.features?.enableDevicePublish ?? true"
                  @change="(v: boolean) => setFeature('enableDevicePublish', v)"
                />
              </div>
              <a-divider style="margin: 8px 0" />
              <div class="toggle-row">
                <div>
                  <div class="toggle-label">Anomaly Detection</div>
                  <div class="toggle-desc">Enable AI-powered anomaly detection for metrics</div>
                </div>
                <a-switch
                  :checked="settings.features?.enableAnomalyDetection ?? false"
                  @change="(v: boolean) => setFeature('enableAnomalyDetection', v)"
                />
              </div>
              <a-divider style="margin: 8px 0" />
              <div class="toggle-row">
                <div>
                  <div class="toggle-label">Remote Access</div>
                  <div class="toggle-desc">Allow remote terminal access to the agent</div>
                </div>
                <a-switch
                  :checked="settings.features?.enableDeviceRemoteAccess ?? true"
                  @change="(v: boolean) => setFeature('enableDeviceRemoteAccess', v)"
                />
              </div>
              <a-divider style="margin: 8px 0" />
              <div class="toggle-row">
                <div>
                  <div class="toggle-label">Device Jobs</div>
                  <div class="toggle-desc">Enable the job execution engine on the agent</div>
                </div>
                <a-switch
                  :checked="settings.features?.enableDeviceJobs ?? true"
                  @change="(v: boolean) => setFeature('enableDeviceJobs', v)"
                />
              </div>
              <a-divider style="margin: 8px 0" />
              <div class="toggle-row">
                <div>
                  <div class="toggle-label">Unit Normalization</div>
                  <div class="toggle-desc">Resolve raw unit strings to canonical units and track unknown units</div>
                </div>
                <a-switch
                  :checked="settings.features?.enableUnitNormalization ?? true"
                  @change="(v: boolean) => setFeature('enableUnitNormalization', v)"
                />
              </div>
              <a-divider style="margin: 8px 0" />
              <div class="toggle-row">
                <div>
                  <div class="toggle-label">Point-Name Normalization</div>
                  <div class="toggle-desc">Resolve raw point/tag names to canonical, deduplicated identities</div>
                </div>
                <a-switch
                  :checked="settings.features?.enablePointNameNormalization ?? true"
                  @change="(v: boolean) => setFeature('enablePointNameNormalization', v)"
                />
              </div>
            </a-space>
          </a-card>
          <div v-if="hasRole('operator')" class="save-bar">
            <a-button :disabled="saving" @click="discard">Discard</a-button>
            <a-button type="primary" :loading="saving" @click="save">
              <template #icon><SaveOutlined /></template>
              Save
            </a-button>
          </div>
        </a-tab-pane>

        <!-- ══ LOGGING ════════════════════════════════════════════════════════ -->
        <a-tab-pane key="logging" tab="Logging">
          <a-card size="small">
            <a-row :gutter="[16, 16]">
              <a-col :span="6">
                <a-form-item label="Log level" style="margin-bottom: 0">
                  <a-select
                    :value="settings.logging?.level ?? 'info'"
                    style="width: 100%"
                    @change="(v: string) => setLogging('level', v as any)"
                  >
                    <a-select-option value="debug">Debug</a-select-option>
                    <a-select-option value="info">Info</a-select-option>
                    <a-select-option value="warn">Warning</a-select-option>
                    <a-select-option value="error">Error</a-select-option>
                  </a-select>
                </a-form-item>
              </a-col>
              <a-col :span="6">
                <a-form-item label="Max entries" style="margin-bottom: 0">
                  <a-input-number
                    :value="settings.logging?.maxLogs ?? 10000"
                    :min="100"
                    :max="100000"
                    style="width: 100%"
                    @change="(v: number) => setLogging('maxLogs', v)"
                  />
                </a-form-item>
              </a-col>
              <a-col :span="6">
                <a-form-item style="margin-bottom: 0">
                  <template #label>
                    Max age (ms)
                    <a-typography-text type="secondary" style="font-size: 12px; margin-left: 6px">
                      {{ msToHuman(settings.logging?.logMaxAge) }}
                    </a-typography-text>
                  </template>
                  <a-input-number
                    :value="settings.logging?.logMaxAge ?? 86400000"
                    :min="60000"
                    style="width: 100%"
                    @change="(v: number) => setLogging('logMaxAge', v)"
                  />
                </a-form-item>
              </a-col>
              <a-col :span="6">
                <a-form-item label="Max file (bytes)" style="margin-bottom: 0">
                  <a-input-number
                    :value="settings.logging?.maxLogFileSize ?? 52428800"
                    :min="1048576"
                    style="width: 100%"
                    @change="(v: number) => setLogging('maxLogFileSize', v)"
                  />
                </a-form-item>
              </a-col>
            </a-row>
            <a-divider style="margin: 16px 0 12px" />
            <a-space direction="vertical" style="width: 100%">
              <div class="toggle-row">
                <div>
                  <div class="toggle-label">Compression</div>
                  <div class="toggle-desc">Compress log files to save disk space</div>
                </div>
                <a-switch
                  :checked="settings.logging?.enableCompression ?? false"
                  @change="(v: boolean) => setLogging('enableCompression', v)"
                />
              </div>
              <a-divider style="margin: 8px 0" />
              <div class="toggle-row">
                <div>
                  <div class="toggle-label">Remote logging</div>
                  <div class="toggle-desc">Send logs to the cloud API for centralised monitoring</div>
                </div>
                <a-switch
                  :checked="settings.logging?.enableRemoteLogging ?? false"
                  @change="(v: boolean) => setLogging('enableRemoteLogging', v)"
                />
              </div>
              <a-divider style="margin: 8px 0" />
              <div class="toggle-row">
                <div>
                  <div class="toggle-label">File persistence</div>
                  <div class="toggle-desc">Persist logs to disk for local debugging</div>
                </div>
                <a-switch
                  :checked="settings.logging?.enableFilePersistence ?? false"
                  @change="(v: boolean) => setLogging('enableFilePersistence', v)"
                />
              </div>
            </a-space>
          </a-card>
          <div v-if="hasRole('operator')" class="save-bar">
            <a-button :disabled="saving" @click="discard">Discard</a-button>
            <a-button type="primary" :loading="saving" @click="save">
              <template #icon><SaveOutlined /></template>
              Save
            </a-button>
          </div>
        </a-tab-pane>

        <!-- ══ INTERVALS ══════════════════════════════════════════════════════ -->
        <a-tab-pane key="intervals" tab="Intervals">
          <a-card size="small" style="margin-bottom: 12px">
            <template #title>Agent communication</template>
            <a-row :gutter="[16, 16]">
              <a-col :span="6">
                <a-form-item style="margin-bottom: 0">
                  <template #label>
                    Report (ms)
                    <a-typography-text type="secondary" style="font-size: 12px; margin-left: 4px">
                      {{ msToHuman(settings.intervals?.agent?.reportIntervalMs) }}
                    </a-typography-text>
                  </template>
                  <a-input-number
                    :value="settings.intervals?.agent?.reportIntervalMs ?? 60000"
                    :min="5000"
                    style="width: 100%"
                    @change="(v: number) => setAgentInterval('reportIntervalMs', v)"
                  />
                </a-form-item>
              </a-col>
              <a-col :span="6">
                <a-form-item style="margin-bottom: 0">
                  <template #label>
                    Metrics (ms)
                    <a-typography-text type="secondary" style="font-size: 12px; margin-left: 4px">
                      {{ msToHuman(settings.intervals?.agent?.metricsIntervalMs) }}
                    </a-typography-text>
                  </template>
                  <a-input-number
                    :value="settings.intervals?.agent?.metricsIntervalMs ?? 60000"
                    :min="5000"
                    style="width: 100%"
                    @change="(v: number) => setAgentInterval('metricsIntervalMs', v)"
                  />
                </a-form-item>
              </a-col>
              <a-col :span="6">
                <a-form-item style="margin-bottom: 0">
                  <template #label>
                    Reconciliation (ms)
                    <a-typography-text type="secondary" style="font-size: 12px; margin-left: 4px">
                      {{ msToHuman(settings.intervals?.agent?.reconciliationIntervalMs) }}
                    </a-typography-text>
                  </template>
                  <a-input-number
                    :value="settings.intervals?.agent?.reconciliationIntervalMs ?? 30000"
                    :min="5000"
                    style="width: 100%"
                    @change="(v: number) => setAgentInterval('reconciliationIntervalMs', v)"
                  />
                </a-form-item>
              </a-col>
              <a-col :span="6">
                <a-form-item style="margin-bottom: 0">
                  <template #label>
                    Target state poll (ms)
                    <a-typography-text type="secondary" style="font-size: 12px; margin-left: 4px">
                      {{ msToHuman(settings.intervals?.agent?.targetStatePollIntervalMs) }}
                    </a-typography-text>
                  </template>
                  <a-input-number
                    :value="settings.intervals?.agent?.targetStatePollIntervalMs ?? 60000"
                    :min="5000"
                    style="width: 100%"
                    @change="(v: number) => setAgentInterval('targetStatePollIntervalMs', v)"
                  />
                </a-form-item>
              </a-col>
            </a-row>
          </a-card>

          <a-card size="small">
            <template #title>Runtime &amp; Memory</template>
            <a-row :gutter="[16, 16]">
              <a-col :span="6">
                <a-form-item label="Memory threshold (MB)" style="margin-bottom: 0">
                  <a-input-number
                    :value="settings.runtime?.memory?.thresholdMb ?? 30"
                    :min="10"
                    style="width: 100%"
                    @change="(v: number) => setMemory('thresholdMb', v)"
                  />
                </a-form-item>
              </a-col>
              <a-col :span="6">
                <a-form-item style="margin-bottom: 0">
                  <template #label>
                    Check interval (ms)
                    <a-typography-text type="secondary" style="font-size: 12px; margin-left: 4px">
                      {{ msToHuman(settings.runtime?.memory?.checkIntervalMs) }}
                    </a-typography-text>
                  </template>
                  <a-input-number
                    :value="settings.runtime?.memory?.checkIntervalMs ?? 30000"
                    :min="5000"
                    style="width: 100%"
                    @change="(v: number) => setMemory('checkIntervalMs', v)"
                  />
                </a-form-item>
              </a-col>
            </a-row>
          </a-card>

          <div v-if="hasRole('operator')" class="save-bar">
            <a-button :disabled="saving" @click="discard">Discard</a-button>
            <a-button type="primary" :loading="saving" @click="save">
              <template #icon><SaveOutlined /></template>
              Save
            </a-button>
          </div>
        </a-tab-pane>

        <!-- ══ DOCKER ══════════════════════════════════════════════════════════ -->
        <a-tab-pane key="docker" tab="Docker">
          <a-spin :spinning="dockerLoading">
            <a-card size="small" title="Daemon Connection">
              <a-form layout="vertical">

                <a-form-item label="Connection type">
                  <a-radio-group
                    v-model:value="dockerConfig.type"
                    button-style="solid"
                    @change="onDockerTypeChange"
                  >
                    <a-radio-button value="socket">Local socket</a-radio-button>
                    <a-radio-button value="tcp">Remote TCP</a-radio-button>
                    <a-radio-button value="tcp+tls">Remote TCP + TLS</a-radio-button>
                  </a-radio-group>
                  <div style="font-size: 12px; color: #888; margin-top: 6px">
                    <template v-if="dockerConfig.type === 'socket'">
                      Connects to the Docker daemon on this device via a Unix socket or Windows named pipe.
                    </template>
                    <template v-else-if="dockerConfig.type === 'tcp'">
                      Connects to a remote Docker daemon over an unencrypted TCP connection. Only use on trusted networks.
                    </template>
                    <template v-else>
                      Connects to a remote Docker daemon over TLS. Requires CA certificate and client credentials.
                    </template>
                  </div>
                </a-form-item>

                <!-- Socket path -->
                <a-form-item v-if="dockerConfig.type === 'socket'" label="Socket path">
                  <a-input
                    v-model:value="dockerConfig.socketPath"
                    placeholder="/var/run/docker.sock  (Linux/Mac)   or   //./pipe/docker_engine  (Windows)"
                    style="font-family: monospace; font-size: 12px"
                  />
                  <div style="font-size: 12px; color: #888; margin-top: 4px">
                    Leave blank to use the platform default.
                  </div>
                </a-form-item>

                <!-- TCP host + port -->
                <template v-if="dockerConfig.type === 'tcp' || dockerConfig.type === 'tcp+tls'">
                  <div style="display: grid; grid-template-columns: 1fr 140px; gap: 12px">
                    <a-form-item label="Host">
                      <a-input v-model:value="dockerConfig.host" placeholder="192.168.1.100" />
                    </a-form-item>
                    <a-form-item label="Port">
                      <a-input-number
                        v-model:value="dockerConfig.port"
                        :placeholder="dockerConfig.type === 'tcp+tls' ? '2376' : '2375'"
                        style="width: 100%"
                        :min="1"
                        :max="65535"
                      />
                    </a-form-item>
                  </div>
                </template>

                <!-- TLS certificates -->
                <template v-if="dockerConfig.type === 'tcp+tls'">
                  <a-form-item label="CA certificate (PEM)">
                    <a-textarea
                      v-model:value="dockerConfig.ca"
                      placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                      :rows="4"
                      style="font-family: monospace; font-size: 12px"
                    />
                  </a-form-item>
                  <a-form-item label="Client certificate (PEM)">
                    <a-textarea
                      v-model:value="dockerConfig.cert"
                      placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                      :rows="4"
                      style="font-family: monospace; font-size: 12px"
                    />
                  </a-form-item>
                  <a-form-item label="Client key (PEM)">
                    <a-textarea
                      v-model:value="dockerConfig.key"
                      placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                      :rows="4"
                      style="font-family: monospace; font-size: 12px"
                    />
                  </a-form-item>
                </template>

                <!-- Test result -->
                <a-alert
                  v-if="dockerTestResult"
                  type="success"
                  show-icon
                  style="margin-bottom: 12px"
                >
                  <template #icon><CheckCircleOutlined /></template>
                  <template #message>
                    Connected — Docker {{ dockerTestResult.version }},
                    {{ dockerTestResult.containers }} container{{ dockerTestResult.containers !== 1 ? 's' : '' }}
                  </template>
                </a-alert>
                <a-alert
                  v-if="dockerTestError"
                  type="error"
                  :message="dockerTestError"
                  show-icon
                  style="margin-bottom: 12px"
                />

              </a-form>
            </a-card>

            <div class="save-bar">
              <a-button :loading="dockerTesting" @click="testDockerConnection">
                <template #icon><LinkOutlined /></template>
                Test Connection
              </a-button>
              <a-button v-if="hasRole('admin')" type="primary" :loading="dockerSaving" @click="saveDockerConfig">
                <template #icon><SaveOutlined /></template>
                Save
              </a-button>
            </div>
          </a-spin>
        </a-tab-pane>

        <!-- ══ MQTT MONITOR ═══════════════════════════════════════════════════ -->
        <a-tab-pane key="mqtt-monitor" tab="MQTT">
          <p style="margin: 0 0 16px; font-size: 13px; color: #888">
            Connection settings for the local MQTT broker the agent monitors.
            Changes take effect immediately — the monitor reconnects without a restart.
          </p>

          <a-card size="small" title="Local Broker Connection">
            <a-form layout="vertical">
              <a-row :gutter="[16, 0]">
                <a-col :span="14">
                  <a-form-item label="Broker URL" required>
                    <a-input
                      v-model:value="mqttForm.url"
                      placeholder="mqtt://localhost:1883"
                      style="font-family: monospace; font-size: 13px"
                    />
                    <div style="font-size: 12px; color: #888; margin-top: 4px">
                      Use <code>mqtt://</code> for plain TCP or <code>mqtts://</code> for TLS.
                      In Docker deployments use the container hostname (e.g. <code>mqtt://iotistic-mosquitto-agent:1883</code>).
                    </div>
                  </a-form-item>
                </a-col>
              </a-row>

              <a-row :gutter="[16, 0]">
                <a-col :span="7">
                  <a-form-item label="Username">
                    <a-input
                      v-model:value="mqttForm.username"
                      placeholder="admin"
                      autocomplete="off"
                    />
                  </a-form-item>
                </a-col>
                <a-col :span="7">
                  <a-form-item label="Password">
                    <a-input-password
                      v-model:value="mqttForm.password"
                      placeholder="Leave blank to keep current"
                      autocomplete="new-password"
                    />
                  </a-form-item>
                </a-col>
              </a-row>

              <a-alert
                v-if="mqttTestResult?.connected"
                type="success"
                show-icon
                style="margin-bottom: 12px"
              >
                <template #icon><CheckCircleOutlined /></template>
                <template #message>
                  Connection successful
                </template>
              </a-alert>
              <a-alert
                v-else-if="mqttTestError"
                type="error"
                :message="mqttTestError"
                show-icon
                style="margin-bottom: 12px"
              />
            </a-form>
          </a-card>

          <div class="save-bar">
            <a-button :loading="mqttTesting" @click="testMqttConnection">
              <template #icon><WifiOutlined /></template>
              Test Connection
            </a-button>
            <a-button v-if="hasRole('admin')" type="primary" :loading="mqttSaving" :disabled="!mqttForm.url.trim()" @click="saveMqttConfig">
              <template #icon><SaveOutlined /></template>
              Save
            </a-button>
          </div>
        </a-tab-pane>

        <a-tab-pane key="units" tab="Units">
          <p style="margin: 0 0 16px; font-size: 13px; color: #888">
            Admin-created unit mappings — created via the "Resolve" action on the
            Dashboard's Normalization Health section when an incoming reading uses
            a unit the built-in catalog doesn't recognize. You can re-map an
            existing mapping to a different canonical unit here; to add a new one,
            resolve it from the Dashboard.
          </p>

          <a-table
            :columns="customAliasColumns"
            :data-source="customAliases"
            :loading="customAliasesLoading"
            :pagination="{ pageSize: 20, size: 'small' }"
            row-key="id"
            size="small"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'source_system'">
                <span style="font-size: 13px; color: #555">{{ record.source_system ?? '— (global)' }}</span>
              </template>
              <template v-else-if="column.key === 'actions'">
                <a-button size="small" @click="openEditAlias(record)">
                  <template #icon><EditOutlined /></template>
                </a-button>
              </template>
            </template>
            <template #emptyText>
              <div style="padding: 32px 0; text-align: center; color: #888">
                No custom unit mappings yet. Resolve an unknown unit from the Dashboard's
                Normalization Health section to create one.
              </div>
            </template>
          </a-table>
        </a-tab-pane>

        <!-- ══ ALERTS ════════════════════════════════════════════════════════ -->
        <a-tab-pane key="alerts" tab="Alerts">
          <a-spin :spinning="alertConfigLoading">
            <template v-if="alertConfig">
              <div class="settings-page">
                <a-alert
                  type="info"
                  show-icon
                  message="Anomaly detection is enabled or disabled in Settings → Features."
                  style="margin-bottom: 20px"
                />

                <!-- Detection settings -->
                <SettingsSection
                  title="Anomaly detection settings"
                  subtitle="Configure how anomalies are detected and scored."
                >
                  <template #icon><SafetyCertificateOutlined /></template>

                  <a-row :gutter="[20, 20]">
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField label="Sensitivity (1–10)" tooltip="Higher sensitivity flags smaller deviations as anomalies.">
                        <div class="sensitivity-control">
                          <div class="sensitivity-control__row">
                            <a-slider
                              v-model:value="alertConfig.sensitivity"
                              :min="1"
                              :max="10"
                              style="flex: 1"
                            />
                            <a-input-number v-model:value="alertConfig.sensitivity" :min="1" :max="10" style="width: 64px" />
                          </div>
                          <div class="sensitivity-control__scale">
                            <span>1 · Low</span>
                            <span>10 · High</span>
                          </div>
                        </div>
                      </SettingsField>
                    </a-col>
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField
                        label="Warm-up period (ms)"
                        tooltip="Time to collect baseline data before detection starts."
                        helper="Time to collect baseline data before detection starts."
                      >
                        <a-input-number v-model:value="alertConfig.warmupPeriodMs" :min="0" :step="60000" placeholder="900000" />
                      </SettingsField>
                    </a-col>
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField
                        label="Min confidence"
                        tooltip="Minimum confidence score to consider an anomaly."
                        helper="Minimum confidence score to consider an anomaly."
                      >
                        <a-input-number v-model:value="alertConfig.alerts.minConfidence" :min="0" :max="1" :step="0.05" />
                      </SettingsField>
                    </a-col>
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField
                        label="Cooldown (ms)"
                        tooltip="Minimum time between anomaly detections."
                        helper="Minimum time between anomaly detections."
                      >
                        <a-input-number v-model:value="alertConfig.alerts.cooldownMs" :min="0" :step="60000" />
                      </SettingsField>
                    </a-col>
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField
                        label="Max queue size"
                        tooltip="Maximum number of items in the anomaly queue."
                        helper="Maximum number of items in the anomaly queue."
                      >
                        <a-input-number v-model:value="alertConfig.alerts.maxQueueSize" :min="1" />
                      </SettingsField>
                    </a-col>
                  </a-row>
                </SettingsSection>

                <!-- Alert routing -->
                <SettingsSection
                  title="Alert routing"
                  subtitle="Configure how and where alerts are delivered."
                >
                  <template #icon><BellOutlined /></template>

                  <a-row :gutter="[20, 20]">
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField label="Enable MQTT alerts">
                        <a-switch v-model:checked="alertConfig.alerts.mqtt" />
                      </SettingsField>
                    </a-col>
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField
                        label="MQTT destination"
                        tooltip="Local broker from the Destinations page (standalone mode)."
                        helper="Local broker from the Destinations page (standalone mode)."
                      >
                        <a-select
                          :value="alertConfig.alerts.alertDestinationId"
                          allow-clear
                          :disabled="!alertConfig.alerts.mqtt"
                          placeholder="None (use cloud MQTT)"
                          @change="(v: number | null) => { alertConfig!.alerts.alertDestinationId = v ?? undefined }"
                        >
                          <a-select-option v-for="d in alertMqttDestinations" :key="d.id" :value="d.id">
                            {{ d.name }}
                          </a-select-option>
                        </a-select>
                      </SettingsField>
                    </a-col>
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField
                        label="Alert topic"
                        tooltip="Topic to publish to when a destination is selected."
                        helper="Topic to publish to when a destination is selected."
                      >
                        <a-input
                          :value="alertConfig.alerts.alertTopic ?? ''"
                          :disabled="!alertConfig.alerts.mqtt"
                          placeholder="iotistica/alerts/anomaly"
                          @change="(e: Event) => { alertConfig!.alerts.alertTopic = (e.target as HTMLInputElement).value || undefined }"
                        />
                      </SettingsField>
                    </a-col>
                  </a-row>
                </SettingsSection>

                <!-- Storage & retention -->
                <SettingsSection
                  title="Storage & retention"
                  subtitle="Configure how long data is kept."
                >
                  <template #icon><DatabaseOutlined /></template>

                  <a-row :gutter="[20, 20]">
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField label="Baseline retention (days)" helper="How long baselines are kept.">
                        <a-input-number
                          :value="alertConfig.storage?.retention"
                          :min="1"
                          @change="(v: number) => { if (!alertConfig!.storage) alertConfig!.storage = { retention: v }; else alertConfig!.storage.retention = v }"
                        />
                      </SettingsField>
                    </a-col>
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField label="Baseline max age (days)" helper="Maximum age of baselines used for detection.">
                        <a-input-number
                          :value="alertConfig.storage?.baselineMaxAgeDays"
                          :min="1"
                          placeholder="7"
                          @change="(v: number) => { if (!alertConfig!.storage) alertConfig!.storage = { retention: 30, baselineMaxAgeDays: v }; else alertConfig!.storage.baselineMaxAgeDays = v }"
                        />
                      </SettingsField>
                    </a-col>
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField label="Min samples for baseline" helper="Minimum samples required to create a baseline.">
                        <a-input-number
                          :value="alertConfig.storage?.minSamples"
                          :min="1"
                          placeholder="5"
                          @change="(v: number) => { if (!alertConfig!.storage) alertConfig!.storage = { retention: 30, minSamples: v }; else alertConfig!.storage.minSamples = v }"
                        />
                      </SettingsField>
                    </a-col>
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField label="Event retention (days)" helper="How long events are kept.">
                        <a-input-number
                          :value="alertConfig.storage?.eventRetentionDays"
                          :min="1"
                          :placeholder="String(alertConfig.storage?.retention ?? 30)"
                          @change="(v: number) => { if (!alertConfig!.storage) alertConfig!.storage = { retention: 30, eventRetentionDays: v }; else alertConfig!.storage.eventRetentionDays = v }"
                        />
                      </SettingsField>
                    </a-col>
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField label="Incident retention (days)" helper="How long incidents are kept.">
                        <a-input-number
                          :value="alertConfig.storage?.incidentRetentionDays"
                          :min="1"
                          :placeholder="String(alertConfig.storage?.retention ?? 30)"
                          @change="(v: number) => { if (!alertConfig!.storage) alertConfig!.storage = { retention: 30, incidentRetentionDays: v }; else alertConfig!.storage.incidentRetentionDays = v }"
                        />
                      </SettingsField>
                    </a-col>
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField label="Alert retention (days)" helper="How long alerts are kept.">
                        <a-input-number
                          :value="alertConfig.storage?.alertRetentionDays"
                          :min="1"
                          :placeholder="String(alertConfig.storage?.retention ?? 30)"
                          @change="(v: number) => { if (!alertConfig!.storage) alertConfig!.storage = { retention: 30, alertRetentionDays: v }; else alertConfig!.storage.alertRetentionDays = v }"
                        />
                      </SettingsField>
                    </a-col>
                  </a-row>

                  <a-alert
                    type="info"
                    show-icon
                    message="Retention settings control how long data is kept. Items are automatically pruned based on age, regardless of whether they are open/active."
                    class="settings-page__notice"
                  />
                </SettingsSection>

                <!-- Schema drift settings -->
                <SettingsSection
                  title="Schema drift"
                  subtitle="Controls how the agent detects unexpected changes in the fields it publishes. Changes apply immediately."
                >
                  <template #icon><BranchesOutlined /></template>
                  <template #extra>
                    <div class="drift-enabled-toggle">
                      <span class="drift-enabled-toggle__label">Enabled</span>
                      <a-switch
                        :checked="globalDrift.enabled !== false"
                        size="small"
                        @change="(v: boolean) => setDrift('enabled', v)"
                      />
                    </div>
                  </template>

                  <a-spin :spinning="driftLoading">
                    <a-row :gutter="[20, 20]">
                      <a-col :xs="24" :sm="12" :lg="8">
                        <SettingsField
                          label="Detection sensitivity"
                          tooltip="How readily the agent flags a device's fields as changed. Low tolerates fields that only report occasionally (e.g. a Boolean alarm/fault point with a long toggle period) — fewer alerts. High flags sooner, at the cost of more false positives on genuinely variable sources. Standard is the recommended default."
                        >
                          <a-radio-group
                            button-style="solid"
                            :value="selectedSensitivity === 'custom' ? undefined : selectedSensitivity"
                            @change="(e: any) => setSensitivityPreset(e.target.value)"
                          >
                            <a-radio-button value="low">Low</a-radio-button>
                            <a-radio-button value="standard">Standard</a-radio-button>
                            <a-radio-button value="high">High</a-radio-button>
                          </a-radio-group>
                          <div v-if="selectedSensitivity === 'custom'" class="drift-sensitivity-custom">
                            Custom — advanced settings have been hand-tuned away from a preset
                          </div>
                        </SettingsField>
                      </a-col>
                      <a-col :xs="24" :sm="12" :lg="8">
                        <SettingsField
                          label="Alert frequency"
                          tooltip="Minimum time between repeat alerts for the same field on the same device. Prevents a single ongoing drift from spamming repeated alerts."
                        >
                          <a-select
                            :value="globalDrift.alertCooldownMs ?? 1800000"
                            style="width: 100%; max-width: 220px"
                            @change="(v: number) => setDrift('alertCooldownMs', v)"
                          >
                            <a-select-option v-for="opt in alertFrequencyOptions" :key="opt.value" :value="opt.value">
                              {{ opt.label }}
                            </a-select-option>
                          </a-select>
                        </SettingsField>
                      </a-col>
                    </a-row>

                    <div class="drift-alert-on">
                      <div class="drift-alert-on__label">
                        Alert on
                        <a-tooltip title="Every drift type is always logged and shows up in the Schema Drift baseline history regardless of this setting — this only controls which ones also raise an alert (Events/Incidents/Alerts, same pipeline anomalies use).">
                          <QuestionCircleOutlined class="drift-alert-on__info" />
                        </a-tooltip>
                      </div>
                      <a-checkbox-group
                        :value="globalDrift.alertOnDriftTypes ?? DEFAULT_ALERT_DRIFT_TYPES"
                        class="drift-alert-on__group"
                        @change="(v: DriftAlertType[]) => setDrift('alertOnDriftTypes', v)"
                      >
                        <a-checkbox v-for="opt in DRIFT_ALERT_TYPE_OPTIONS" :key="opt.value" :value="opt.value">
                          {{ opt.label }}
                          <a-tooltip :title="opt.hint">
                            <QuestionCircleOutlined class="drift-alert-on__info drift-alert-on__info--sm" />
                          </a-tooltip>
                        </a-checkbox>
                      </a-checkbox-group>
                    </div>

                  </a-spin>
                </SettingsSection>

                <div v-if="hasRole('operator')" class="settings-page__actions">
                  <a-button @click="resetAlertDetectionDefaults">
                    <template #icon><ReloadOutlined /></template>
                    Reset to default
                  </a-button>
                  <a-button type="primary" :loading="alertConfigSaving" @click="saveAllAlertConfig">
                    <template #icon><SaveOutlined /></template>
                    Save configuration
                  </a-button>
                </div>
              </div>
            </template>

            <div v-else-if="!alertConfigLoading" style="color: #888; padding: 48px 0; text-align: center">
              Configuration not available.
            </div>
          </a-spin>
        </a-tab-pane>

      </a-tabs>
    </a-spin>

    <a-modal
      :open="editAliasModalOpen"
      title="Edit unit mapping"
      :confirm-loading="editAliasSaving"
      ok-text="Save mapping"
      :ok-button-props="{ disabled: !editAliasCanonicalUnit }"
      @ok="submitEditAlias"
      @cancel="closeEditAlias"
    >
      <p style="margin-bottom: 16px; color: #888">
        Re-map this alias to a different canonical unit. Future readings using it
        will normalize to the new unit immediately.
      </p>
      <div style="margin-bottom: 12px">
        <div style="font-size: 12px; color: #888">Alias</div>
        <div><code>{{ editAliasTarget?.alias }}</code></div>
      </div>
      <div style="margin-bottom: 16px">
        <div style="font-size: 12px; color: #888">Protocol / Source System</div>
        <div>{{ editAliasTarget?.source_system ?? '— (global)' }}</div>
      </div>
      <div>
        <div style="font-size: 12px; color: #888; margin-bottom: 4px">Canonical unit</div>
        <a-select
          v-model:value="editAliasCanonicalUnit"
          show-search
          placeholder="Select a canonical unit"
          style="width: 100%"
          :options="canonicalUnitOptions"
          :filter-option="(input: string, option: any) => option.label.toLowerCase().includes(input.toLowerCase())"
        />
      </div>
    </a-modal>
  </AppLayout>
</template>

<style scoped>
.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 4px 0;
}
.toggle-label {
  font-size: 14px;
  font-weight: 500;
  color: rgba(0, 0, 0, 0.85);
}
.toggle-desc {
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
  margin-top: 2px;
}
.save-bar {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 16px;
}

.settings-page {
  max-width: 1440px;
  margin: 0;
}

.settings-page__notice {
  margin-top: 20px;
}

.settings-page__actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 4px;
  padding-top: 16px;
  border-top: 1px solid rgba(5, 5, 5, 0.06);
}

.sensitivity-control {
  width: 100%;
  max-width: 320px;
}

.sensitivity-control__row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.sensitivity-control__scale {
  display: flex;
  justify-content: space-between;
  font-size: 12.5px;
  color: #767676;
  margin-top: 5px;
  line-height: 1.5;
}

.drift-enabled-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
}

.drift-enabled-toggle__label {
  font-size: 12.5px;
  color: #767676;
}


.drift-alert-on {
  margin-top: 20px;
}

.drift-alert-on__label {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}

.drift-alert-on__info {
  color: #999;
  font-size: 12px;
  margin-left: 4px;
  cursor: help;
}

.drift-alert-on__info--sm {
  font-size: 11px;
}

.drift-alert-on__group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
}

.drift-alert-on__group :deep(.ant-checkbox-wrapper) {
  margin-inline-start: 0;
}

.drift-sensitivity-custom {
  font-size: 12px;
  color: #d4880c;
  margin-top: 6px;
}

</style>
