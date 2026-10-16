<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { message } from 'ant-design-vue'
import { DeleteOutlined, EditOutlined } from '@ant-design/icons-vue'
import { datasetsApi, type MlDataset, type CreateMlDatasetInput, type DatasetDraftState } from '@/api/ml-datasets'
import { protocolColor, protocolLabel } from '@/utils/protocol'

type PointRow = {
  key: string
  protocol: string
  endpointName: string
  metric: string
  normalizedName?: string
  rawPointName?: string
  rawObjectName?: string
  value: unknown
  quality?: string
  unit?: string
  timestamp: string
  destinationName: string
}

const props = defineProps<{
  open: boolean
  pointRows: PointRow[]
  editingDataset: MlDataset | null
}>()

const emit = defineEmits<{
  'update:open': [val: boolean]
  saved: []
  'edit-selection': [draft: DatasetDraftState]
}>()

const SAMPLING_OPTIONS = [
  { value: 1, label: '1s' },
  { value: 5, label: '5s' },
  { value: 10, label: '10s' },
  { value: 30, label: '30s' },
  { value: 60, label: '1 min' },
  { value: 300, label: '5 min' },
  { value: 900, label: '15 min' },
]

const WINDOW_OPTIONS = [
  { value: 300, label: '5 min' },
  { value: 900, label: '15 min' },
  { value: 1800, label: '30 min' },
  { value: 3600, label: '1 hour' },
  { value: 21600, label: '6 hours' },
  { value: 86400, label: '24 hours' },
]

const MISSING_VALUE_OPTIONS = [
  { value: 'keep_null', label: 'Keep null' },
  { value: 'forward_fill', label: 'Forward fill' },
  { value: 'linear_interpolation', label: 'Linear interpolation' },
  { value: 'drop_incomplete', label: 'Drop incomplete rows' },
]

const NORMALIZATION_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'min_max', label: 'Min-max scaling' },
  { value: 'standard', label: 'Standard scaling' },
]

const FORMAT_OPTIONS = [
  { value: 'jsonl', label: 'JSON Lines (.jsonl)' },
  { value: 'csv', label: 'CSV (.csv)' },
]

const name = ref('')
const description = ref('')
const selectedKeys = ref<string[]>([])
const samplingIntervalSecs = ref(60)
const windowSecs = ref(900)
const missingValues = ref('forward_fill')
const normalization = ref('none')
const excludeBadQuality = ref(true)
const removeOutliers = ref(false)
const outlierMethod = ref('iqr')
const outputFormat = ref<string>('jsonl')
const saving = ref(false)
const showAllPoints = ref(false)

const isEdit = computed(() => props.editingDataset !== null)
const VISIBLE_LIMIT = 4

watch(() => props.open, (open) => {
  if (!open) return
  showAllPoints.value = false
  if (props.editingDataset) {
    name.value = props.editingDataset.name
    description.value = props.editingDataset.description
    selectedKeys.value = [...props.editingDataset.pointKeys]
    samplingIntervalSecs.value = props.editingDataset.samplingIntervalSecs
    windowSecs.value = props.editingDataset.windowSecs
    missingValues.value = props.editingDataset.missingValues
    normalization.value = props.editingDataset.normalization
    excludeBadQuality.value = props.editingDataset.excludeBadQuality
    removeOutliers.value = props.editingDataset.removeOutliers
    outlierMethod.value = props.editingDataset.outlierMethod
    outputFormat.value = props.editingDataset.outputFormat
  } else {
    name.value = ''
    description.value = ''
    selectedKeys.value = props.pointRows.map(p => p.key)
    samplingIntervalSecs.value = 60
    windowSecs.value = 900
    missingValues.value = 'forward_fill'
    normalization.value = 'none'
    excludeBadQuality.value = true
    removeOutliers.value = false
    outlierMethod.value = 'iqr'
    outputFormat.value = 'jsonl'
  }
})

const pointRowMap = computed(() => {
  const map = new Map<string, PointRow>()
  for (const p of props.pointRows) map.set(p.key, p)
  return map
})

interface DisplayPoint {
  key: string
  protocol: string
  primaryName: string
  secondaryLine: string
  unit: string
  fullIdentifier: string
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

function bestPointName(row: PointRow): string {
  if (row.rawPointName && row.rawPointName !== row.metric) return row.rawPointName
  if (row.rawObjectName && row.rawObjectName !== row.metric) return row.rawObjectName
  if (row.normalizedName) return row.normalizedName
  return row.metric
}

const displayPoints = computed<DisplayPoint[]>(() => {
  return selectedKeys.value.map(key => {
    const row = pointRowMap.value.get(key)
    if (row) {
      return {
        key,
        protocol: row.protocol,
        primaryName: truncate(bestPointName(row), 40),
        secondaryLine: row.endpointName,
        unit: row.unit || '',
        fullIdentifier: `${row.endpointName} / ${row.metric}`,
      }
    }
    try {
      const parts = JSON.parse(key) as string[]
      return {
        key,
        protocol: parts[0] || '',
        primaryName: truncate(parts[2] || 'Unknown', 40),
        secondaryLine: parts[1] || '',
        unit: '',
        fullIdentifier: `${parts[0]} / ${parts[1]} / ${parts[2]}`,
      }
    } catch {
      return {
        key,
        protocol: '',
        primaryName: 'Unknown point',
        secondaryLine: '',
        unit: '',
        fullIdentifier: key,
      }
    }
  })
})

const visiblePoints = computed(() =>
  showAllPoints.value ? displayPoints.value : displayPoints.value.slice(0, VISIBLE_LIMIT))
const hiddenCount = computed(() => Math.max(0, displayPoints.value.length - VISIBLE_LIMIT))

function removePoint(key: string) {
  selectedKeys.value = selectedKeys.value.filter(k => k !== key)
}

function extractMetricName(key: string): string {
  try {
    const parts = JSON.parse(key) as string[]
    const metric = parts[2] || parts[1] || 'value'
    return metric.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
  } catch {
    return 'value'
  }
}

const previewText = computed(() => {
  const keys = selectedKeys.value.slice(0, 5)
  if (!keys.length) return ''
  if (outputFormat.value === 'csv') {
    const cols = keys.map(extractMetricName)
    const header = ['timestamp', ...cols].join(',')
    const row = ['2026-10-14T12:00:00Z', ...cols.map((_, i) => (20 + i * 1.3).toFixed(1))].join(',')
    return `${header}\n${row}`
  }
  const obj: Record<string, unknown> = { timestamp: '2026-10-14T12:00:00Z' }
  for (let i = 0; i < keys.length; i++) {
    obj[extractMetricName(keys[i])] = +(20 + i * 1.3).toFixed(1)
  }
  return JSON.stringify(obj, null, 2)
})

const canSave = computed(() => name.value.trim().length > 0 && selectedKeys.value.length > 0)

function onEditSelection() {
  const draft: DatasetDraftState = {
    name: name.value,
    description: description.value,
    samplingIntervalSecs: samplingIntervalSecs.value,
    windowSecs: windowSecs.value,
    missingValues: missingValues.value,
    normalization: normalization.value,
    excludeBadQuality: excludeBadQuality.value,
    removeOutliers: removeOutliers.value,
    outlierMethod: outlierMethod.value,
    outputFormat: outputFormat.value,
    selectedKeys: [...selectedKeys.value],
    editingDataset: props.editingDataset,
  }
  emit('edit-selection', draft)
  emit('update:open', false)
}

function restoreFromDraft(draft: DatasetDraftState, newKeys: string[]) {
  name.value = draft.name
  description.value = draft.description
  samplingIntervalSecs.value = draft.samplingIntervalSecs
  windowSecs.value = draft.windowSecs
  missingValues.value = draft.missingValues
  normalization.value = draft.normalization
  excludeBadQuality.value = draft.excludeBadQuality
  removeOutliers.value = draft.removeOutliers
  outlierMethod.value = draft.outlierMethod
  outputFormat.value = draft.outputFormat
  selectedKeys.value = newKeys
}

async function save() {
  const trimmedName = name.value.trim()
  if (!trimmedName || selectedKeys.value.length === 0) return
  saving.value = true
  try {
    const input: CreateMlDatasetInput = {
      name: trimmedName,
      description: description.value.trim(),
      pointKeys: selectedKeys.value,
      samplingIntervalSecs: samplingIntervalSecs.value,
      windowSecs: windowSecs.value,
      missingValues: missingValues.value,
      normalization: normalization.value,
      excludeBadQuality: excludeBadQuality.value,
      removeOutliers: removeOutliers.value,
      outlierMethod: removeOutliers.value ? outlierMethod.value : undefined,
      outputFormat: outputFormat.value,
    }
    if (isEdit.value) {
      await datasetsApi.update(props.editingDataset!.id, input)
      message.success('Dataset updated')
    } else {
      await datasetsApi.create(input)
      message.success('Dataset created')
    }
    emit('saved')
    emit('update:open', false)
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Failed to save dataset')
  } finally {
    saving.value = false
  }
}

defineExpose({ restoreFromDraft })
</script>

<template>
  <a-drawer
    :open="open"
    :title="isEdit ? 'Edit Dataset' : 'Create Dataset'"
    :width="560"
    @close="emit('update:open', false)"
  >
    <div class="drawer-body">
      <!-- Section 1: Basic Information -->
      <div class="section">
        <div class="section-title">Basic Information</div>
        <div class="field">
          <label class="field-label">Name <span class="required">*</span></label>
          <a-input v-model:value="name" placeholder="e.g. VAV Zone Sensors" :maxlength="100" />
        </div>
        <div class="field">
          <label class="field-label">Description</label>
          <a-textarea v-model:value="description" placeholder="What is this dataset for?" :rows="2" :maxlength="500" />
        </div>
      </div>

      <!-- Section 2: Selected Points -->
      <div class="section">
        <div class="section-header">
          <div>
            <div class="section-title" style="margin-bottom: 2px">Selected Points ({{ selectedKeys.length }})</div>
            <div class="section-subtitle">Features included in this dataset</div>
          </div>
          <a-button size="small" class="edit-selection-btn" @click="onEditSelection">
            <EditOutlined /> {{ selectedKeys.length ? 'Edit Selection' : 'Select Points' }}
          </a-button>
        </div>

        <div v-if="!selectedKeys.length" class="empty-state">
          <p>No points selected.</p>
          <p>Select rows in the Data Explorer table, then click Create Dataset — or use the button above to pick points.</p>
        </div>

        <div v-else class="points-list">
          <div v-for="dp in visiblePoints" :key="dp.key" class="point-row">
            <a-tag :color="protocolColor(dp.protocol)" class="proto-tag">{{ protocolLabel(dp.protocol) }}</a-tag>
            <div class="point-info" :title="dp.fullIdentifier">
              <div class="point-name">{{ dp.primaryName }}</div>
              <div v-if="dp.secondaryLine" class="point-meta">{{ dp.secondaryLine }}</div>
            </div>
            <span v-if="dp.unit" class="unit-badge">{{ dp.unit }}</span>
            <a-button type="text" size="small" class="remove-btn" @click="removePoint(dp.key)">
              <template #icon><DeleteOutlined /></template>
            </a-button>
          </div>
          <a-button v-if="hiddenCount > 0 && !showAllPoints" type="link" size="small" class="toggle-link" @click="showAllPoints = true">
            Show {{ hiddenCount }} more points…
          </a-button>
          <a-button v-if="showAllPoints && hiddenCount > 0" type="link" size="small" class="toggle-link" @click="showAllPoints = false">
            Show less
          </a-button>
        </div>
      </div>

      <!-- Section 3: Data Collection -->
      <div class="section">
        <div class="section-title">Data Collection</div>
        <div class="field-row">
          <div class="field">
            <label class="field-label">Sampling Interval</label>
            <a-select v-model:value="samplingIntervalSecs" :options="SAMPLING_OPTIONS" style="width: 100%" />
          </div>
          <div class="field">
            <label class="field-label">Dataset Window</label>
            <a-select v-model:value="windowSecs" :options="WINDOW_OPTIONS" style="width: 100%" />
          </div>
        </div>
      </div>

      <!-- Section 4: Preprocessing -->
      <div class="section">
        <div class="section-title">Preprocessing</div>
        <div class="field-row">
          <div class="field">
            <label class="field-label">Missing Values</label>
            <a-select v-model:value="missingValues" :options="MISSING_VALUE_OPTIONS" style="width: 100%" />
          </div>
          <div class="field">
            <label class="field-label">Normalization</label>
            <a-select v-model:value="normalization" :options="NORMALIZATION_OPTIONS" style="width: 100%" />
          </div>
        </div>
        <div class="checkbox-row">
          <a-checkbox v-model:checked="excludeBadQuality">Exclude bad-quality readings</a-checkbox>
        </div>
        <div class="checkbox-row">
          <a-checkbox v-model:checked="removeOutliers">Remove outliers (IQR)</a-checkbox>
        </div>
      </div>

      <!-- Section 5: Output Format -->
      <div class="section">
        <div class="section-title">Output Format</div>
        <div class="field">
          <label class="field-label">Format</label>
          <a-select v-model:value="outputFormat" :options="FORMAT_OPTIONS" style="width: 100%" />
        </div>
        <div v-if="selectedKeys.length" class="preview-block">
          <div class="preview-header">Preview (illustrative — sample values only)</div>
          <pre class="preview-code">{{ previewText }}</pre>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="drawer-footer">
        <a-button @click="emit('update:open', false)">Cancel</a-button>
        <a-button type="primary" :loading="saving" :disabled="!canSave" @click="save">
          {{ isEdit ? 'Save Changes' : 'Create Dataset' }}
        </a-button>
      </div>
    </template>
  </a-drawer>
</template>

<style scoped>
.drawer-body { display: flex; flex-direction: column; gap: 20px; }
.section { border: 1px solid #edf0f5; border-radius: 8px; padding: 16px; }
.section-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.section-title { font-size: 14px; font-weight: 650; color: #1a2332; margin-bottom: 12px; }
.section-subtitle { font-size: 12px; color: #8a94a3; margin: 0; }
.edit-selection-btn { color: #1677ff; border-color: #1677ff; flex-shrink: 0; }
.field { margin-bottom: 10px; }
.field:last-child { margin-bottom: 0; }
.field-label { display: block; font-size: 12px; font-weight: 600; color: #555; margin-bottom: 5px; }
.required { color: #f04452; }
.field-row { display: flex; gap: 12px; }
.field-row .field { flex: 1; }
.checkbox-row { margin-top: 8px; }

.empty-state { text-align: center; padding: 20px 12px; color: #8a94a3; font-size: 13px; }
.empty-state p { margin: 0 0 4px; }

.points-list { display: flex; flex-direction: column; }
.point-row { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid #f0f2f5; }
.point-row:last-of-type { border-bottom: none; }
.proto-tag { flex-shrink: 0; margin: 0; font-size: 11px; min-width: 58px; text-align: center; }
.point-info { flex: 1; min-width: 0; overflow: hidden; }
.point-name { font-size: 13px; font-weight: 500; color: #1a2332; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.point-meta { font-size: 11px; color: #8a94a3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 1px; }
.unit-badge { flex-shrink: 0; font-size: 11px; color: #555; background: #f5f5f5; border: 1px solid #e8e8e8; border-radius: 4px; padding: 1px 6px; white-space: nowrap; }
.remove-btn { color: #bbb; flex-shrink: 0; }
.remove-btn:hover { color: #f04452; }
.toggle-link { padding: 8px 0 2px; }

.preview-block { margin-top: 10px; }
.preview-header { font-size: 11px; color: #8a94a3; margin-bottom: 6px; }
.preview-code { background: #f7f9fc; border: 1px solid #e7ebf0; border-radius: 6px; padding: 10px 12px; font-size: 11px; line-height: 1.5; overflow-x: auto; margin: 0; color: #334155; white-space: pre-wrap; word-break: break-all; }
.drawer-footer { display: flex; justify-content: flex-end; gap: 8px; }
</style>
