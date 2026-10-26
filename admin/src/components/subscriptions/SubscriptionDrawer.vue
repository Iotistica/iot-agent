<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { message } from 'ant-design-vue'
import { SearchOutlined, WarningOutlined } from '@ant-design/icons-vue'
import type { FormInstance } from 'ant-design-vue'
import type { Destination, Endpoint, Subscription, SubscriptionFormData, SubscriptionRoute } from '@/types'
import { subscriptionsApi } from '@/api/subscriptions'
import { datasetsApi, type MlDataset } from '@/api/ml-datasets'
import { protocolColor, protocolLabel } from '@/utils/protocol'

const props = defineProps<{
  open: boolean
  editing: Subscription | null
  destinations: Destination[]
  endpoints?: Endpoint[]
  metricNames?: string[]
  iotisticaTopicBase?: string
}>()

const emit = defineEmits<{
  'update:open': [val: boolean]
  saved: []
}>()

const SOURCE_PROTOCOLS = ['bacnet', 'modbus', 'opcua', 'mqtt', 'system']
const PAYLOAD_FORMATS = [
  { value: 'custom', label: 'Iotistica' },
  { value: 'tags',   label: 'Tags' },
  { value: 'ecp',    label: 'ECP' },
  { value: 'ml',     label: 'ML / Training' },
]
const COMPRESSIONS = [
  { label: 'None', value: null, hint: '' },
  { label: 'Deflate', value: 'json+deflate', hint: '~40–60% smaller' },
  { label: 'MessagePack', value: 'msgpack', hint: '~20–30% smaller' },
  { label: 'MessagePack + Deflate', value: 'msgpack+deflate', hint: '~50–70% smaller' },
]
const QUALITIES = ['GOOD', 'BAD', 'UNCERTAIN']

const PUBLISH_INTERVAL_PRESETS = [
  { label: 'Every update', value: 'none' },
  { label: '1 second',     value: '1000' },
  { label: '5 seconds',    value: '5000' },
  { label: '10 seconds',   value: '10000' },
  { label: '30 seconds',   value: '30000' },
  { label: '1 minute',     value: '60000' },
  { label: 'Custom…',      value: 'custom' },
]
const PRESET_MS_VALUES = new Set(['1000', '5000', '10000', '30000', '60000'])

const customIntervalValue = ref<number | undefined>(undefined)
const customIntervalUnit = ref<'s' | 'm'>('s')

function msToCustomFields(ms: number): { value: number; unit: 's' | 'm' } {
  return ms > 0 && ms % 60000 === 0
    ? { value: ms / 60000, unit: 'm' }
    : { value: ms / 1000, unit: 's' }
}

function customFieldsToMs(): number | undefined {
  if (customIntervalValue.value == null || customIntervalValue.value <= 0) return undefined
  const ms = customIntervalUnit.value === 'm' ? customIntervalValue.value * 60000 : customIntervalValue.value * 1000
  return Math.round(ms)
}

function seedCustomIntervalFromMs(ms: number | null | undefined) {
  if (ms != null && ms > 0) {
    const fields = msToCustomFields(ms)
    customIntervalValue.value = fields.value
    customIntervalUnit.value = fields.unit
  } else {
    customIntervalValue.value = 1
    customIntervalUnit.value = 's'
  }
}

const formRef = ref<FormInstance>()
const saving = ref(false)
const showAdvanced = ref(false)
const datasets = ref<MlDataset[]>([])
const datasetsLoading = ref(false)

async function loadDatasets() {
  datasetsLoading.value = true
  try {
    datasets.value = await datasetsApi.list()
  } catch { /* ignore */ }
  datasetsLoading.value = false
}

const selectedDataset = computed(() =>
  datasets.value.find((d) => d.id === form.value.ml_dataset_id) ?? null,
)

function formatDatasetInterval(secs: number): string {
  if (secs >= 60) return `${secs / 60}-minute`
  return `${secs}-second`
}

const blankRoute = (): SubscriptionRoute => ({
  includeMetrics: [],
  excludeMetrics: [],
  includeDevices: [],
  excludeDevices: [],
  qualities: [],
  minIntervalMs: undefined,
  maxPointsPerMessage: undefined,
  topic: '',
})

const blankForm = (): SubscriptionFormData => ({
  publish_destination_id: props.destinations[0]?.id ?? 0,
  topics: [],
  route_json: blankRoute(),
  payload_format: 'tags',
  compression: null,
  ml_dataset_id: null,
  enabled: true,
})

const form = ref<SubscriptionFormData>(blankForm())

// ── Source mode (3-way selector) ────────────────────────────────────────────
type SourceMode = 'all' | 'protocol' | 'specific'
const sourceMode = ref<SourceMode>('all')
const sourceSearch = ref('')

function detectSourceMode(sub: Subscription | null): SourceMode {
  if (!sub) return 'all'
  if ((sub.route_json?.includeDevices?.length ?? 0) > 0) return 'specific'
  if (sub.topics?.length > 0) return 'protocol'
  return 'all'
}

watch(sourceMode, (mode) => {
  if (mode === 'all') {
    form.value.topics = []
    if (form.value.route_json) form.value.route_json.includeDevices = []
  } else if (mode === 'protocol') {
    if (form.value.route_json) form.value.route_json.includeDevices = []
  } else if (mode === 'specific') {
    form.value.topics = []
  }
  syncIotisticaTopic()
})

const endpointsByProtocol = computed(() => {
  const groups: Record<string, Endpoint[]> = {}
  for (const ep of props.endpoints ?? []) {
    const p = ep.protocol || 'other'
    ;(groups[p] ??= []).push(ep)
  }
  return groups
})

const filteredEndpointsByProtocol = computed(() => {
  const q = sourceSearch.value.trim().toLowerCase()
  if (!q) return endpointsByProtocol.value
  const result: Record<string, Endpoint[]> = {}
  for (const [protocol, eps] of Object.entries(endpointsByProtocol.value)) {
    const filtered = eps.filter(ep => ep.name.toLowerCase().includes(q) || connSummary(ep).toLowerCase().includes(q))
    if (filtered.length > 0) result[protocol] = filtered
  }
  return result
})

const selectedSources = computed(() => new Set(form.value.route_json?.includeDevices ?? []))
const endpointNames = computed(() => new Set((props.endpoints ?? []).map(ep => ep.name)))
const totalEndpoints = computed(() => (props.endpoints ?? []).length)
const selectedCount = computed(() => selectedSources.value.size)

const staleSourceNames = computed(() => {
  const names = form.value.route_json?.includeDevices ?? []
  return names.filter(n => !endpointNames.value.has(n))
})

function toggleSource(name: string) {
  if (!form.value.route_json) return
  const list = form.value.route_json.includeDevices ?? []
  const idx = list.indexOf(name)
  if (idx >= 0) {
    list.splice(idx, 1)
  } else {
    list.push(name)
  }
  form.value.route_json.includeDevices = [...list]
}

function toggleProtocolGroup(protocol: string) {
  if (!form.value.route_json) return
  const eps = endpointsByProtocol.value[protocol] ?? []
  const names = eps.map(ep => ep.name)
  const current = new Set(form.value.route_json.includeDevices ?? [])
  const allSelected = names.every(n => current.has(n))
  if (allSelected) {
    names.forEach(n => current.delete(n))
  } else {
    names.forEach(n => current.add(n))
  }
  form.value.route_json.includeDevices = [...current]
}

function isProtocolGroupAllSelected(protocol: string): boolean {
  const eps = endpointsByProtocol.value[protocol] ?? []
  if (eps.length === 0) return false
  return eps.every(ep => selectedSources.value.has(ep.name))
}

function isProtocolGroupPartial(protocol: string): boolean {
  const eps = endpointsByProtocol.value[protocol] ?? []
  const some = eps.some(ep => selectedSources.value.has(ep.name))
  const all = eps.every(ep => selectedSources.value.has(ep.name))
  return some && !all
}

function connSummary(ep: Endpoint): string {
  const c = ep.connection
  if (!c) return ''
  if (ep.protocol === 'modbus') {
    return c.type === 'rtu' ? String(c.serialPort ?? '') : `${c.host ?? ''}:${c.port ?? 502}`
  }
  if (ep.protocol === 'opcua') {
    const raw = String(c.endpointUrl ?? '')
    try {
      const u = new URL(raw)
      return `${u.hostname}:${u.port || 4840}`
    } catch {
      return raw
    }
  }
  if (ep.protocol === 'mqtt') {
    const host = String(c.host ?? c.url ?? '')
    const port = c.port ? `:${c.port}` : ''
    return `${host}${port}`
  }
  if (ep.protocol === 'bacnet') {
    const ip = String(c.ipAddress ?? c.host ?? '')
    const instance = c.deviceInstance != null ? ` #${c.deviceInstance}` : ''
    return `${ip}${instance}`
  }
  if (ep.protocol === 'system') return 'local'
  return ''
}

function healthDot(ep: Endpoint): { color: string; label: string } {
  if (!ep.enabled) return { color: '#999', label: 'Disabled' }
  const q = ep.health?.communicationQuality
  if (q === 'good') return { color: '#52c41a', label: 'Connected' }
  if (q === 'degraded') return { color: '#faad14', label: 'Degraded' }
  if (q === 'poor') return { color: '#fa541c', label: 'Poor' }
  if (q === 'offline') return { color: '#ff4d4f', label: 'Offline' }
  return { color: '#d9d9d9', label: 'Unknown' }
}

// ── Publish interval ────────────────────────────────────────────────────────
const publishIntervalPreset = computed<string>({
  get() {
    const ms = form.value.route_json?.minIntervalMs
    if (ms == null || ms <= 0) return 'none'
    return PRESET_MS_VALUES.has(String(ms)) ? String(ms) : 'custom'
  },
  set(preset: string) {
    if (!form.value.route_json) return
    if (preset === 'none') {
      form.value.route_json.minIntervalMs = undefined
    } else if (preset === 'custom') {
      seedCustomIntervalFromMs(form.value.route_json.minIntervalMs)
      form.value.route_json.minIntervalMs = customFieldsToMs()
    } else {
      form.value.route_json.minIntervalMs = Number(preset)
    }
  },
})

watch([customIntervalValue, customIntervalUnit], () => {
  if (publishIntervalPreset.value !== 'custom' || !form.value.route_json) return
  form.value.route_json.minIntervalMs = customFieldsToMs()
})

// ── Destination logic ───────────────────────────────────────────────────────
const selectedDestination = computed(() =>
  props.destinations.find((d) => d.id === form.value.publish_destination_id) ?? null,
)

const isIotisticaDestination = computed(() => selectedDestination.value?.type === 'iotistica')
const isExternalDestination = computed(() => !!selectedDestination.value && !isIotisticaDestination.value)
const isInfluxDbDestination = computed(() => selectedDestination.value?.type === 'influxdb')
const isTimescaleDbDestination = computed(() => selectedDestination.value?.type === 'timescaledb')
const isSocketDestination = computed(() => selectedDestination.value?.type === 'socket')

const destinationTopicRules = computed(() =>
  isExternalDestination.value && !isInfluxDbDestination.value && !isTimescaleDbDestination.value && !isSocketDestination.value
    ? [{ required: true, message: 'Destination topic is required for external destinations' }]
    : [],
)

function buildIotisticaTopic(): string {
  const base = props.iotisticaTopicBase ?? ''
  const protocols = form.value.topics
  return protocols.length === 1 ? `${base}/${protocols[0]}` : `${base}/+`
}

function syncIotisticaTopic() {
  if (!isIotisticaDestination.value || !props.iotisticaTopicBase) return
  form.value.route_json!.topic = buildIotisticaTopic()
}

watch(isIotisticaDestination, (yes) => {
  if (!yes) return
  form.value.payload_format = 'custom'
  nextTick(syncIotisticaTopic)
})

watch(() => form.value.topics, () => {
  syncIotisticaTopic()
})

// ── Drawer open/close ───────────────────────────────────────────────────────
watch(
  () => props.open,
  (open) => {
    if (!open) return
    showAdvanced.value = false
    sourceSearch.value = ''
    loadDatasets()
    if (props.editing) {
      form.value = {
        publish_destination_id: props.editing.publish_destination_id,
        topics: [...props.editing.topics],
        route_json: props.editing.route_json ?? blankRoute(),
        payload_format: props.editing.payload_format,
        compression: props.editing.compression ?? null,
        ml_dataset_id: props.editing.ml_dataset_id ?? null,
        enabled: props.editing.enabled,
      }
      sourceMode.value = detectSourceMode(props.editing)
    } else {
      form.value = blankForm()
      sourceMode.value = 'all'
      nextTick(() => {
        if (isIotisticaDestination.value) {
          form.value.payload_format = 'custom'
          syncIotisticaTopic()
        }
      })
    }
    seedCustomIntervalFromMs(form.value.route_json?.minIntervalMs)
  },
)

watch(() => form.value.payload_format, (fmt) => {
  if (fmt !== 'ml') {
    form.value.ml_dataset_id = null
  }
})

watch(() => form.value.ml_dataset_id, (id) => {
  if (id) {
    form.value.topics = []
    sourceMode.value = 'all'
  }
})

// ── Submit ──────────────────────────────────────────────────────────────────
async function submit() {
  await formRef.value?.validate()
  saving.value = true

  const payload = { ...form.value }

  if (sourceMode.value === 'all') {
    payload.topics = []
    if (payload.route_json) payload.route_json.includeDevices = []
  } else if (sourceMode.value === 'protocol') {
    if (payload.route_json) payload.route_json.includeDevices = []
  } else if (sourceMode.value === 'specific') {
    payload.topics = []
  }

  const r = payload.route_json
  const hasRouteConfig =
    r &&
    ((r.includeMetrics?.length ?? 0) > 0 ||
      (r.excludeMetrics?.length ?? 0) > 0 ||
      (r.includeDevices?.length ?? 0) > 0 ||
      (r.excludeDevices?.length ?? 0) > 0 ||
      (r.qualities?.length ?? 0) > 0 ||
      r.minIntervalMs != null ||
      r.maxPointsPerMessage != null ||
      (r.topic?.trim().length ?? 0) > 0)
  if (!hasRouteConfig) payload.route_json = null

  try {
    if (props.editing) {
      await subscriptionsApi.update(props.editing.id, payload)
      message.success('Subscription updated')
    } else {
      await subscriptionsApi.create(payload)
      message.success('Subscription created')
    }
    emit('update:open', false)
    emit('saved')
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Save failed')
  } finally {
    saving.value = false
  }
}

function close() {
  emit('update:open', false)
}
</script>

<template>
  <a-drawer
    :open="open"
    :title="editing ? 'Edit Subscription' : 'New Subscription'"
    width="560"
    @close="close"
  >
    <a-form
      ref="formRef"
      :model="form"
      layout="vertical"
    >
      <!-- Destination -->
      <a-form-item
        label="Destination"
        name="publish_destination_id"
        :rules="[{ required: true }]"
      >
        <a-select v-model:value="form.publish_destination_id" placeholder="Select destination">
          <a-select-option
            v-for="d in destinations"
            :key="d.id"
            :value="d.id"
          >
            {{ d.name }}
            <a-tag size="small" style="margin-left: 8px">{{ d.type }}</a-tag>
          </a-select-option>
        </a-select>
      </a-form-item>

      <!-- Iotistica native topic (read-only) -->
      <a-form-item
        v-if="isIotisticaDestination && form.route_json?.topic"
        label="MQTT Topic"
        extra="Agent publishes on this topic structure — one sub-topic per endpoint"
      >
        <a-input :value="form.route_json.topic" disabled style="font-family: monospace; font-size: 12px" />
      </a-form-item>

      <!-- Destination Topic / Measurement -->
      <a-form-item
        v-if="isExternalDestination && !isTimescaleDbDestination && !isSocketDestination"
        :label="isInfluxDbDestination ? 'Measurement' : 'Destination Topic'"
        :name="['route_json', 'topic']"
        :rules="destinationTopicRules"
        :extra="isInfluxDbDestination
          ? 'InfluxDB measurement name for this subscription (e.g. temperature). Defaults to \'metrics\' if empty.'
          : 'MQTT topic to publish to on the external broker (e.g. sensors/bacnet/readings)'"
      >
        <a-input
          v-model:value="form.route_json!.topic"
          :placeholder="isInfluxDbDestination ? 'e.g. temperature' : 'e.g. sensors/bacnet/readings'"
        />
      </a-form-item>

      <a-alert
        v-if="isTimescaleDbDestination"
        type="info"
        show-icon
        message="No destination topic needed"
        description="TimescaleDB rows go into the readings table by metric name — there's no per-topic destination to configure."
        style="margin-bottom: 16px"
      />


      <!-- Sources (hidden when a dataset is selected) -->
      <a-form-item v-if="!selectedDataset" label="Sources">
        <a-radio-group v-model:value="sourceMode" style="display: flex; flex-direction: column; gap: 8px">
          <a-radio value="all">All sources</a-radio>
          <a-radio value="protocol">By protocol</a-radio>
          <a-radio value="specific">Specific sources</a-radio>
        </a-radio-group>

        <!-- By protocol: multi-select -->
        <div v-if="sourceMode === 'protocol'" class="source-sub-panel">
          <a-select
            v-model:value="form.topics"
            mode="multiple"
            placeholder="Select protocols"
            style="width: 100%"
          >
            <a-select-option v-for="p in SOURCE_PROTOCOLS" :key="p" :value="p">
              {{ protocolLabel(p) || p }}
            </a-select-option>
          </a-select>
        </div>

        <!-- Specific sources: grouped checkbox list -->
        <div v-if="sourceMode === 'specific'" class="source-sub-panel">
          <a-input
            v-model:value="sourceSearch"
            placeholder="Search sources..."
            allow-clear
            size="small"
            style="margin-bottom: 8px"
          >
            <template #prefix><SearchOutlined style="color: var(--text-muted)" /></template>
          </a-input>

          <div class="source-list">
            <template v-for="(eps, protocol) in filteredEndpointsByProtocol" :key="protocol">
              <div class="source-group-header">
                <a-checkbox
                  :checked="isProtocolGroupAllSelected(protocol as string)"
                  :indeterminate="isProtocolGroupPartial(protocol as string)"
                  @change="toggleProtocolGroup(protocol as string)"
                >
                  <a-tag :color="protocolColor(protocol as string)" size="small">{{ protocolLabel(protocol as string) || protocol }}</a-tag>
                </a-checkbox>
              </div>
              <div
                v-for="ep in eps"
                :key="ep.uuid"
                class="source-row"
                @click="toggleSource(ep.name)"
              >
                <a-checkbox
                  :checked="selectedSources.has(ep.name)"
                  @click.stop
                  @change="toggleSource(ep.name)"
                />
                <span class="source-name">{{ ep.name }}</span>
                <span class="source-health" :title="healthDot(ep).label">
                  <span class="health-dot" :style="{ background: healthDot(ep).color }" />
                  {{ healthDot(ep).label }}
                </span>
                <span class="source-conn">{{ connSummary(ep) }}</span>
              </div>
            </template>

            <div v-if="Object.keys(filteredEndpointsByProtocol).length === 0" class="source-empty">
              {{ sourceSearch ? 'No sources match your search.' : 'No sources configured.' }}
            </div>
          </div>

          <!-- Stale references warning -->
          <a-alert
            v-if="staleSourceNames.length > 0"
            type="warning"
            size="small"
            show-icon
            style="margin-top: 8px"
          >
            <template #icon><WarningOutlined /></template>
            <template #message>
              {{ staleSourceNames.length }} selected source{{ staleSourceNames.length > 1 ? 's' : '' }} no longer exist{{ staleSourceNames.length === 1 ? 's' : '' }}:
              <a-tag v-for="n in staleSourceNames" :key="n" size="small" style="margin: 2px">{{ n }}</a-tag>
            </template>
          </a-alert>

          <div class="source-count">
            {{ selectedCount }} of {{ totalEndpoints }} source{{ totalEndpoints !== 1 ? 's' : '' }} selected
          </div>
        </div>
      </a-form-item>

      <!-- Payload Format -->
      <a-form-item label="Payload Format" name="payload_format">
        <a-select v-model:value="form.payload_format">
          <a-select-option v-for="f in PAYLOAD_FORMATS" :key="f.value" :value="f.value">{{ f.label }}</a-select-option>
        </a-select>
      </a-form-item>

      <!-- Dataset (ML format only) -->
      <template v-if="form.payload_format === 'ml'">
        <a-form-item
          label="Dataset"
          name="ml_dataset_id"
          extra="Select a dataset created in Data Explorer."
        >
          <a-select
            v-model:value="form.ml_dataset_id"
            placeholder="None (publish all points)"
            :loading="datasetsLoading"
            allow-clear
          >
            <a-select-option v-for="d in datasets" :key="d.id" :value="d.id">
              {{ d.name }} ({{ d.pointKeys.length }} points)
            </a-select-option>
          </a-select>
        </a-form-item>
        <a-alert
          v-if="selectedDataset"
          type="info"
          show-icon
          style="margin-bottom: 16px"
        >
          <template #message>Dataset settings</template>
          <template #description>
            {{ selectedDataset.pointKeys.length }} selected points · {{ formatDatasetInterval(selectedDataset.samplingIntervalSecs) }} publish interval<br>
            <span style="color: var(--color-text-tertiary)">Preprocessing settings are included as metadata for the cloud.</span>
          </template>
        </a-alert>
      </template>

      <!-- Compression -->
      <a-form-item label="Compression" name="compression">
        <a-select v-model:value="form.compression">
          <a-select-option v-for="c in COMPRESSIONS" :key="String(c.value)" :value="c.value">
            {{ c.label }} <span v-if="c.hint" style="color: var(--color-text-tertiary)">{{ c.hint }}</span>
          </a-select-option>
        </a-select>
      </a-form-item>

      <!-- Enabled -->
      <a-form-item label="Enabled" name="enabled">
        <a-switch v-model:checked="form.enabled" />
      </a-form-item>

      <!-- Advanced routing -->
      <a-collapse
        v-model:active-key="showAdvanced"
        :bordered="false"
        ghost
        style="margin-top: 8px"
      >
        <a-collapse-panel key="true" header="Advanced Routing (optional)">
          <a-form-item label="Include points" extra="Select from the list or type a custom name">
            <a-select
              v-model:value="form.route_json!.includeMetrics"
              mode="tags"
              placeholder="All points (leave empty for all)"
              :options="(metricNames ?? []).map(n => ({ value: n, label: n }))"
            />
          </a-form-item>
          <a-form-item label="Exclude points" extra="Select from the list or type a custom name">
            <a-select
              v-model:value="form.route_json!.excludeMetrics"
              mode="tags"
              placeholder="None excluded"
              :options="(metricNames ?? []).map(n => ({ value: n, label: n }))"
            />
          </a-form-item>
          <a-form-item label="Quality filter">
            <a-checkbox-group v-model:value="form.route_json!.qualities">
              <a-checkbox v-for="q in QUALITIES" :key="q" :value="q">{{ q }}</a-checkbox>
            </a-checkbox-group>
          </a-form-item>
          <a-form-item
            label="Publish interval"
            extra="Minimum time between updates for the same point sent to this subscription."
          >
            <a-select v-model:value="publishIntervalPreset" style="width: 100%">
              <a-select-option v-for="p in PUBLISH_INTERVAL_PRESETS" :key="p.value" :value="p.value">
                {{ p.label }}
              </a-select-option>
            </a-select>
            <a-space v-if="publishIntervalPreset === 'custom'" :size="8" style="margin-top: 8px">
              <a-input-number
                v-model:value="customIntervalValue"
                :min="0.001"
                style="width: 140px"
                placeholder="Value"
              />
              <a-select v-model:value="customIntervalUnit" style="width: 120px">
                <a-select-option value="s">seconds</a-select-option>
                <a-select-option value="m">minutes</a-select-option>
              </a-select>
            </a-space>
          </a-form-item>
          <a-form-item label="Max points/message">
            <a-input-number v-model:value="form.route_json!.maxPointsPerMessage" :min="1" style="width: 100%" placeholder="None" />
          </a-form-item>
        </a-collapse-panel>
      </a-collapse>
    </a-form>

    <template #footer>
      <a-space>
        <a-button @click="close">Cancel</a-button>
        <a-button type="primary" :loading="saving" @click="submit">
          {{ editing ? 'Save' : 'Create' }}
        </a-button>
      </a-space>
    </template>
  </a-drawer>
</template>

<style scoped>
.source-sub-panel {
  margin-top: 8px;
  margin-left: 24px;
}

.source-list {
  border: 1px solid var(--border-color);
  border-radius: 6px;
  max-height: 260px;
  overflow-y: auto;
}

.source-group-header {
  padding: 6px 10px;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-color);
  font-weight: 500;
  font-size: 13px;
}

.source-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px 5px 28px;
  cursor: pointer;
  font-size: 13px;
  border-bottom: 1px solid var(--border-color);
  transition: background 0.15s;
}

.source-row:last-child {
  border-bottom: none;
}

.source-row:hover {
  background: var(--bg-hover);
}

.source-name {
  font-weight: 500;
  white-space: nowrap;
}

.source-health {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-tertiary);
  white-space: nowrap;
}

.health-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.source-conn {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-muted);
  font-family: monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
}

.source-empty {
  padding: 16px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
}

.source-count {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-tertiary);
}
</style>
