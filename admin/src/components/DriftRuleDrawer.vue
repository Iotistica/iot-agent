<script lang="ts">
import type { DriftType } from '@/types'

export const DRIFT_TYPE_LABELS: Record<DriftType, string> = {
  'new-field': 'New point',
  'missing-field': 'Missing point',
  'type-drift': 'Type changed',
  'rename-candidate': 'Possible rename',
}

export const DRIFT_TYPE_TAG_COLORS: Record<DriftType, string> = {
  'new-field': 'green',
  'missing-field': 'red',
  'type-drift': 'orange',
  'rename-candidate': 'blue',
}
</script>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { message } from 'ant-design-vue'
import type { DriftRuleConfig, DriftType as DT, DriftSeverity as DS } from '@/types'
import { anomalyApi, driftRulesApi } from '@/api/anomaly'
import { PROTOCOL_LABELS, protocolLabel, protocolColor } from '@/utils/protocol'

const DETECTION_TYPES: Array<{ key: DT; title: string; description: string }> = [
  { key: 'new-field', title: 'New Point', description: 'A previously unseen data point appears on a device' },
  { key: 'missing-field', title: 'Missing Point', description: 'An expected data point stops reporting' },
  { key: 'type-drift', title: 'Type Changed', description: "A data point's value type changes unexpectedly" },
  { key: 'rename-candidate', title: 'Possible Rename', description: 'A point may have been renamed rather than added or removed' },
]

const ALL_DRIFT_TYPES: DT[] = ['new-field', 'missing-field', 'type-drift', 'rename-candidate']
const DRIFT_SEVERITIES: DS[] = ['warning', 'critical']
const KNOWN_PROTOCOLS = Object.keys(PROTOCOL_LABELS)

type ScopeMode = 'all' | 'device' | 'protocol' | 'custom'

const props = defineProps<{
  open: boolean
  editingRule: DriftRuleConfig | null
  prefill?: { fieldPattern?: string; devicePattern?: string; endpointPattern?: string }
}>()

const emit = defineEmits<{
  'update:open': [val: boolean]
  saved: []
}>()

const initializing = ref(false)
const saving = ref(false)

// ── Simplified controls ──────────────────────────────────────────────────────
const scopeMode = ref<ScopeMode>('all')
const selectedDevice = ref('')
const selectedProtocol = ref('')
const selectedDriftTypes = ref<DT[]>([])
const alertSeverity = ref<DS>('warning')
const showMixedSeverities = ref(false)
const isSuppressOnly = ref(false)

// ── Raw form state (source of truth for save) ────────────────────────────────
const name = ref('')
const description = ref('')
const enabled = ref(true)
const priority = ref(0)
const fieldPattern = ref('')
const devicePattern = ref('')
const endpointPattern = ref('')
const suppressDriftTypes = ref<DT[]>([])
const alertOnDriftTypes = ref<DT[]>([])
const severityOverrides = ref<Partial<Record<DT, DS>>>({})
const pinAsBaseline = ref(false)
const allowedTypes = ref<string[]>([])
const consecutiveMissingThreshold = ref<number | undefined>(undefined)
const alertCooldownMs = ref<number | undefined>(undefined)
const adaptivePromotionBatches = ref<number | undefined>(undefined)
const adaptivePromotionMinElapsedMs = ref<number | undefined>(undefined)
const adaptiveRetireBatches = ref<number | undefined>(undefined)
const advancedActiveKey = ref<string[]>([])

// ── Device selector data ─────────────────────────────────────────────────────
const knownDevices = ref<Array<{ name: string; protocol: string }>>([])
const devicesLoading = ref(false)

const isEdit = computed(() => props.editingRule !== null)
const title = computed(() => isEdit.value ? 'Edit rule' : 'Add rule')

const hasScope = computed(() =>
  fieldPattern.value.trim() !== '' ||
  devicePattern.value.trim() !== '' ||
  endpointPattern.value.trim() !== '',
)

const driftTypeOptions = ALL_DRIFT_TYPES.map(t => ({ label: DRIFT_TYPE_LABELS[t], value: t }))

// ── Scope detection ──────────────────────────────────────────────────────────
function detectScopeMode(r: { fieldPattern?: string; devicePattern?: string; endpointPattern?: string }): ScopeMode {
  const hasField = !!r.fieldPattern
  const hasDev = !!r.devicePattern
  const hasEp = !!r.endpointPattern

  if (hasDev && r.devicePattern === '*' && !hasEp && !hasField) return 'all'
  if (hasDev && r.devicePattern !== '*' && !hasEp) return 'device'
  if (hasEp && !hasDev) {
    const m = r.endpointPattern!.match(/^\*(\w+)\*$/)
    if (m && KNOWN_PROTOCOLS.includes(m[1])) return 'protocol'
  }
  if (!hasDev && !hasEp && !hasField) return 'all'
  return 'custom'
}

function extractProtocolFromPattern(pattern: string): string {
  const m = pattern.match(/^\*(\w+)\*$/)
  return m?.[1] ?? ''
}

function detectAlertSeverity(r: DriftRuleConfig): DS {
  if (!r.severityOverrides) return 'warning'
  const vals = Object.values(r.severityOverrides)
  return vals[0] ?? 'warning'
}

function hasMixedSeverityOverrides(r: DriftRuleConfig): boolean {
  if (!r.severityOverrides) return false
  const vals = Object.values(r.severityOverrides)
  return vals.length > 1 && new Set(vals).size > 1
}

// ── Device loading ───────────────────────────────────────────────────────────
async function loadDevices() {
  if (knownDevices.value.length > 0) return
  devicesLoading.value = true
  try {
    const { baselines } = await anomalyApi.getSchemaDriftBaselines()
    const seen = new Set<string>()
    const result: Array<{ name: string; protocol: string }> = []
    for (const row of baselines) {
      if (row.device && !seen.has(row.device)) {
        seen.add(row.device)
        result.push({ name: row.device, protocol: row.protocol })
      }
    }
    knownDevices.value = result.sort((a, b) => a.name.localeCompare(b.name))
  } catch { /* silent */ } finally {
    devicesLoading.value = false
  }
}

// ── Open / reset ─────────────────────────────────────────────────────────────
watch(() => props.open, (open) => {
  if (!open) return

  initializing.value = true
  advancedActiveKey.value = []
  showMixedSeverities.value = false
  isSuppressOnly.value = false

  if (props.editingRule) {
    const r = props.editingRule
    name.value = r.name ?? ''
    description.value = r.description ?? ''
    enabled.value = r.enabled
    priority.value = r.priority
    fieldPattern.value = r.fieldPattern ?? ''
    devicePattern.value = r.devicePattern ?? ''
    endpointPattern.value = r.endpointPattern ?? ''
    suppressDriftTypes.value = r.suppressDriftTypes ? [...r.suppressDriftTypes] : []
    alertOnDriftTypes.value = r.alertOnDriftTypes ? [...r.alertOnDriftTypes] : []
    severityOverrides.value = r.severityOverrides ? { ...r.severityOverrides } : {}
    pinAsBaseline.value = r.pinAsBaseline ?? false
    allowedTypes.value = r.allowedTypes ? [...r.allowedTypes] : []
    consecutiveMissingThreshold.value = r.consecutiveMissingThreshold
    alertCooldownMs.value = r.alertCooldownMs
    adaptivePromotionBatches.value = r.adaptivePromotionBatches
    adaptivePromotionMinElapsedMs.value = r.adaptivePromotionMinElapsedMs
    adaptiveRetireBatches.value = r.adaptiveRetireBatches

    const sm = detectScopeMode(r)
    scopeMode.value = sm
    if (sm === 'device') selectedDevice.value = r.devicePattern ?? ''
    else if (sm === 'protocol') selectedProtocol.value = extractProtocolFromPattern(r.endpointPattern ?? '')
    else { selectedDevice.value = ''; selectedProtocol.value = '' }

    const hasSuppress = (r.suppressDriftTypes?.length ?? 0) > 0
    const hasAlert = (r.alertOnDriftTypes?.length ?? 0) > 0
    isSuppressOnly.value = hasSuppress && !hasAlert

    selectedDriftTypes.value = r.alertOnDriftTypes ? [...r.alertOnDriftTypes] : []
    alertSeverity.value = detectAlertSeverity(r)
    showMixedSeverities.value = hasMixedSeverityOverrides(r)

    if (sm === 'custom' || isSuppressOnly.value || (hasSuppress && hasAlert) || showMixedSeverities.value) {
      advancedActiveKey.value = ['advanced']
    }
  } else {
    resetForm()
    if (props.prefill) {
      fieldPattern.value = props.prefill.fieldPattern ?? ''
      devicePattern.value = props.prefill.devicePattern ?? ''
      endpointPattern.value = props.prefill.endpointPattern ?? ''
      scopeMode.value = detectScopeMode(props.prefill)
      if (scopeMode.value === 'device') selectedDevice.value = props.prefill.devicePattern ?? ''
      else if (scopeMode.value === 'protocol') selectedProtocol.value = extractProtocolFromPattern(props.prefill.endpointPattern ?? '')
    }
  }

  loadDevices()
  initializing.value = false
})

function resetForm() {
  name.value = ''
  description.value = ''
  enabled.value = true
  priority.value = 0
  fieldPattern.value = ''
  devicePattern.value = '*'
  endpointPattern.value = ''
  suppressDriftTypes.value = []
  alertOnDriftTypes.value = []
  severityOverrides.value = {}
  pinAsBaseline.value = false
  allowedTypes.value = []
  consecutiveMissingThreshold.value = undefined
  alertCooldownMs.value = undefined
  adaptivePromotionBatches.value = undefined
  adaptivePromotionMinElapsedMs.value = undefined
  adaptiveRetireBatches.value = undefined
  scopeMode.value = 'all'
  selectedDevice.value = ''
  selectedProtocol.value = ''
  selectedDriftTypes.value = []
  alertSeverity.value = 'warning'
  showMixedSeverities.value = false
  isSuppressOnly.value = false
}

// ── Scope sync ───────────────────────────────────────────────────────────────
function onScopeModeChange() {
  if (initializing.value) return
  syncScopeToRaw()
}

function syncScopeToRaw() {
  if (scopeMode.value === 'all') {
    devicePattern.value = '*'
    endpointPattern.value = ''
  } else if (scopeMode.value === 'device') {
    devicePattern.value = selectedDevice.value
    endpointPattern.value = ''
  } else if (scopeMode.value === 'protocol') {
    devicePattern.value = ''
    endpointPattern.value = selectedProtocol.value ? `*${selectedProtocol.value}*` : ''
  }
}

function onDeviceSelected() {
  if (initializing.value) return
  devicePattern.value = selectedDevice.value
}

function onProtocolSelected() {
  if (initializing.value) return
  endpointPattern.value = selectedProtocol.value ? `*${selectedProtocol.value}*` : ''
}

function onAdvancedPatternChange() {
  if (initializing.value) return
  scopeMode.value = 'custom'
}

// ── Detection type cards ─────────────────────────────────────────────────────
function toggleDetectionType(key: DT) {
  if (initializing.value) return
  const idx = selectedDriftTypes.value.indexOf(key)
  if (idx >= 0) {
    selectedDriftTypes.value.splice(idx, 1)
  } else {
    selectedDriftTypes.value.push(key)
  }
  syncAlertTypesToRaw()
}

function syncAlertTypesToRaw() {
  alertOnDriftTypes.value = [...selectedDriftTypes.value]
  rebuildSeverityOverrides()
}

// ── Severity ─────────────────────────────────────────────────────────────────
function onSeverityChanged() {
  if (initializing.value) return
  showMixedSeverities.value = false
  rebuildSeverityOverrides()
}

function rebuildSeverityOverrides() {
  if (showMixedSeverities.value) return
  const overrides: Partial<Record<DT, DS>> = {}
  for (const dt of selectedDriftTypes.value) {
    overrides[dt] = alertSeverity.value
  }
  severityOverrides.value = overrides
}

// ── Build payload + save ─────────────────────────────────────────────────────
function buildPayload(): Omit<DriftRuleConfig, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    enabled: enabled.value,
    priority: priority.value,
    name: name.value || undefined,
    description: description.value || undefined,
    fieldPattern: fieldPattern.value || undefined,
    devicePattern: devicePattern.value || undefined,
    endpointPattern: endpointPattern.value || undefined,
    suppressDriftTypes: suppressDriftTypes.value.length > 0 ? suppressDriftTypes.value : undefined,
    alertOnDriftTypes: alertOnDriftTypes.value.length > 0 ? alertOnDriftTypes.value : undefined,
    severityOverrides: Object.keys(severityOverrides.value).length > 0 ? severityOverrides.value : undefined,
    pinAsBaseline: pinAsBaseline.value || undefined,
    allowedTypes: allowedTypes.value.length > 0 ? allowedTypes.value : undefined,
    consecutiveMissingThreshold: consecutiveMissingThreshold.value,
    alertCooldownMs: alertCooldownMs.value,
    adaptivePromotionBatches: adaptivePromotionBatches.value,
    adaptivePromotionMinElapsedMs: adaptivePromotionMinElapsedMs.value,
    adaptiveRetireBatches: adaptiveRetireBatches.value,
  }
}

async function handleSave() {
  if (!name.value.trim()) {
    message.warning('Rule name is required')
    return
  }
  if (!hasScope.value) {
    message.warning('At least one scope pattern is required')
    return
  }
  if (!isSuppressOnly.value && selectedDriftTypes.value.length === 0 && suppressDriftTypes.value.length === 0) {
    message.warning('Select at least one detection type')
    return
  }
  saving.value = true
  try {
    const payload = buildPayload()
    if (isEdit.value && props.editingRule?.id) {
      await driftRulesApi.updateRule(props.editingRule.id, payload)
      message.success('Rule updated')
    } else {
      await driftRulesApi.createRule(payload)
      message.success('Rule created')
    }
    emit('update:open', false)
    emit('saved')
  } catch (err: any) {
    message.error(err?.response?.data?.error ?? err?.message ?? 'Failed to save rule')
  } finally {
    saving.value = false
  }
}

function filterDevice(input: string, option: any) {
  return (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
}
</script>

<template>
  <a-drawer
    :open="open"
    :title="title"
    :width="480"
    @close="emit('update:open', false)"
  >
    <a-form layout="vertical" style="font-size: 13px">
      <!-- ── Rule name ────────────────────────────────────────────────────── -->
      <a-form-item label="Rule name" required>
        <a-input v-model:value="name" placeholder="e.g. Alert on missing BACnet points" />
      </a-form-item>

      <a-form-item label="Description">
        <a-textarea v-model:value="description" :rows="2" placeholder="Optional description" />
      </a-form-item>

      <!-- ── Apply to ─────────────────────────────────────────────────────── -->
      <a-form-item label="Apply to">
        <a-radio-group v-model:value="scopeMode" button-style="solid" size="small" style="margin-bottom: 8px" @change="onScopeModeChange">
          <a-radio-button value="all">All devices</a-radio-button>
          <a-radio-button value="device">Specific device</a-radio-button>
          <a-radio-button value="protocol">Protocol</a-radio-button>
          <a-radio-button v-if="scopeMode === 'custom'" value="custom">Custom</a-radio-button>
        </a-radio-group>

        <a-select
          v-if="scopeMode === 'device'"
          v-model:value="selectedDevice"
          show-search
          placeholder="Select a device"
          :loading="devicesLoading"
          :filter-option="filterDevice"
          style="width: 100%"
          @change="onDeviceSelected"
        >
          <a-select-option v-for="d of knownDevices" :key="d.name" :value="d.name" :label="d.name">
            {{ d.name }}
            <a-tag :color="protocolColor(d.protocol)" style="margin-left: 6px; font-size: 10px">{{ protocolLabel(d.protocol) }}</a-tag>
          </a-select-option>
        </a-select>

        <template v-if="scopeMode === 'protocol'">
          <a-select
            v-model:value="selectedProtocol"
            placeholder="Select a protocol"
            style="width: 100%"
            @change="onProtocolSelected"
          >
            <a-select-option v-for="[key, label] of Object.entries(PROTOCOL_LABELS)" :key="key" :value="key">
              {{ label }}
            </a-select-option>
          </a-select>
          <div v-if="selectedProtocol" style="font-size: 11px; color: #888; margin-top: 4px">
            Matches endpoints named with the {{ protocolLabel(selectedProtocol) }}-… convention
          </div>
        </template>

        <div v-if="scopeMode === 'custom'" style="font-size: 11px; color: #888">
          This rule uses custom scope patterns — edit them in Advanced Settings below.
        </div>
      </a-form-item>

      <!-- ── Detection type (cards) ───────────────────────────────────────── -->
      <a-form-item label="Detection type">
        <div v-if="isSuppressOnly" class="suppress-only-note">
          This rule suppresses detection types. Edit suppression in Advanced Settings.
        </div>
        <div class="detection-category-cards" role="group" aria-label="Detection type">
          <label
            v-for="dt of DETECTION_TYPES"
            :key="dt.key"
            class="detection-category-card"
            :class="{ 'detection-category-card--active': selectedDriftTypes.includes(dt.key) }"
            @click.prevent="toggleDetectionType(dt.key)"
          >
            <a-checkbox
              :checked="selectedDriftTypes.includes(dt.key)"
              @click.stop
              @change="toggleDetectionType(dt.key)"
            />
            <div>
              <div class="detection-category-card__title">{{ dt.title }}</div>
              <div class="detection-category-card__desc">{{ dt.description }}</div>
            </div>
          </label>
        </div>
        <div v-if="!isSuppressOnly && selectedDriftTypes.length === 0 && suppressDriftTypes.length === 0" class="detection-method-warning">
          Select at least one detection type.
        </div>
      </a-form-item>

      <!-- ── Severity ─────────────────────────────────────────────────────── -->
      <a-form-item v-if="selectedDriftTypes.length > 0" label="Severity">
        <a-segmented
          :value="alertSeverity"
          :options="[{ label: 'Warning', value: 'warning' }, { label: 'Critical', value: 'critical' }]"
          @change="(v: any) => { alertSeverity = v; onSeverityChanged() }"
        />
        <div v-if="showMixedSeverities" class="severity-mixed-note">
          This rule has different severities per type — edit in Advanced Settings.
        </div>
      </a-form-item>

      <!-- ── Enabled ──────────────────────────────────────────────────────── -->
      <a-form-item label="Enabled">
        <a-switch v-model:checked="enabled" />
      </a-form-item>

      <!-- ── Advanced Settings ────────────────────────────────────────────── -->
      <a-collapse v-model:activeKey="advancedActiveKey" ghost class="advanced-settings-collapse">
        <a-collapse-panel key="advanced" header="Advanced Settings (Optional)">
          <a-form-item label="Field pattern">
            <a-input v-model:value="fieldPattern" placeholder="e.g. reading:temperature, reading:zone_*" @input="onAdvancedPatternChange" />
          </a-form-item>
          <a-form-item label="Device pattern">
            <a-input v-model:value="devicePattern" placeholder="e.g. ahu_*, vav_f12_a" @input="onAdvancedPatternChange" />
          </a-form-item>
          <a-form-item label="Endpoint pattern">
            <a-input v-model:value="endpointPattern" placeholder="e.g. *bacnet*, *mqtt*" @input="onAdvancedPatternChange" />
          </a-form-item>

          <a-form-item label="Suppress drift types">
            <a-checkbox-group v-model:value="suppressDriftTypes" :options="driftTypeOptions" />
            <div class="advanced-setting-help">Suppressed types are not alerted. Events are still recorded internally.</div>
          </a-form-item>

          <a-form-item v-if="showMixedSeverities || suppressDriftTypes.length > 0" label="Severity overrides">
            <div v-for="dt of ALL_DRIFT_TYPES" :key="dt" style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px">
              <span style="width: 130px; font-size: 12px">{{ DRIFT_TYPE_LABELS[dt] }}</span>
              <a-select
                :value="severityOverrides[dt]"
                placeholder="default"
                allow-clear
                size="small"
                style="width: 120px"
                @change="(v: DS | undefined) => { if (v) severityOverrides[dt] = v; else delete severityOverrides[dt] }"
              >
                <a-select-option v-for="s of DRIFT_SEVERITIES" :key="s" :value="s">{{ s }}</a-select-option>
              </a-select>
            </div>
          </a-form-item>

          <a-form-item>
            <a-checkbox v-model:checked="pinAsBaseline">Pin as baseline (never retire)</a-checkbox>
          </a-form-item>
          <a-form-item label="Allowed types (suppress type-drift for these)">
            <a-select v-model:value="allowedTypes" mode="tags" placeholder="e.g. number, string" style="width: 100%" />
          </a-form-item>

          <a-row :gutter="12">
            <a-col :span="12">
              <a-form-item label="Missing threshold (batches)">
                <a-input-number v-model:value="consecutiveMissingThreshold" :min="1" placeholder="default" style="width: 100%" />
              </a-form-item>
            </a-col>
            <a-col :span="12">
              <a-form-item label="Alert cooldown (ms)">
                <a-input-number v-model:value="alertCooldownMs" :min="0" placeholder="default" style="width: 100%" />
              </a-form-item>
            </a-col>
          </a-row>
          <a-row :gutter="12">
            <a-col :span="12">
              <a-form-item label="Promotion batches">
                <a-input-number v-model:value="adaptivePromotionBatches" :min="1" placeholder="default" style="width: 100%" />
              </a-form-item>
            </a-col>
            <a-col :span="12">
              <a-form-item label="Promotion min elapsed (ms)">
                <a-input-number v-model:value="adaptivePromotionMinElapsedMs" :min="0" placeholder="default" style="width: 100%" />
              </a-form-item>
            </a-col>
          </a-row>
          <a-row :gutter="12">
            <a-col :span="12">
              <a-form-item label="Retire batches">
                <a-input-number v-model:value="adaptiveRetireBatches" :min="1" placeholder="default" style="width: 100%" />
              </a-form-item>
            </a-col>
            <a-col :span="12">
              <a-form-item label="Priority">
                <a-input-number v-model:value="priority" placeholder="0" style="width: 100%" />
                <div class="advanced-setting-help">Higher = evaluated first</div>
              </a-form-item>
            </a-col>
          </a-row>
        </a-collapse-panel>
      </a-collapse>
    </a-form>

    <template #footer>
      <div style="display: flex; justify-content: flex-end; gap: 8px">
        <a-button @click="emit('update:open', false)">Cancel</a-button>
        <a-button type="primary" :loading="saving" @click="handleSave">
          {{ isEdit ? 'Update' : 'Add' }}
        </a-button>
      </div>
    </template>
  </a-drawer>
</template>

<style scoped>
.detection-category-cards { display: flex; flex-direction: column; gap: 8px; }
.detection-category-card {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 12px; border: 1px solid #d9d9d9; border-radius: 6px;
  cursor: pointer; transition: all 0.2s;
}
.detection-category-card:hover { border-color: #1677ff; }
.detection-category-card--active { border-color: #1677ff; background: #e6f4ff; }
.detection-category-card__title { font-weight: 600; font-size: 13px; }
.detection-category-card__desc { font-size: 12px; color: #666; margin-top: 2px; }
.detection-method-warning { margin-top: 8px; color: #cf1322; font-size: 12px; }
.suppress-only-note { margin-bottom: 8px; font-size: 12px; color: #888; }
.severity-mixed-note { margin-top: 6px; font-size: 12px; color: #888; }
.advanced-settings-collapse { margin: 0 -12px 16px; }
.advanced-settings-collapse :deep(.ant-collapse-header) { font-size: 13px; color: #555; padding: 8px 12px !important; }
.advanced-settings-collapse :deep(.ant-collapse-content-box) { padding: 0 12px !important; }
.advanced-setting-help { font-size: 12px; color: #888; margin-top: 4px; }
:deep(.ant-segmented-item-selected) { background: #1677ff !important; color: #fff !important; }
:deep(.ant-segmented-item-selected .ant-segmented-item-label) { color: #fff !important; }
</style>
