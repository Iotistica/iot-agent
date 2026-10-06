<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { message } from 'ant-design-vue'
import type { FormInstance } from 'ant-design-vue'
import type { Destination, Subscription, SubscriptionFormData, SubscriptionRoute } from '@/types'
import { subscriptionsApi } from '@/api/subscriptions'

const props = defineProps<{
  open: boolean
  editing: Subscription | null
  destinations: Destination[]
  deviceNames?: string[]
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
  { label: 'None', value: null },
  { label: 'JSON', value: 'json' },
  { label: 'MessagePack', value: 'msgpack' },
  { label: 'JSON + Deflate', value: 'json+deflate' },
  { label: 'MessagePack + Deflate', value: 'msgpack+deflate' },
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
  enabled: true,
})

const form = ref<SubscriptionFormData>(blankForm())

// Drives the "Publish interval" select. Reads/writes form.route_json.minIntervalMs directly
// so the existing submit()/hasRouteConfig logic (r.minIntervalMs != null) keeps working
// unchanged — "Every update" always writes `undefined`, never `0`, matching blankRoute()'s
// existing default and avoiding a false-positive hasRouteConfig.
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

const selectedDestination = computed(() =>
  props.destinations.find((d) => d.id === form.value.publish_destination_id) ?? null,
)

const isIotisticaDestination = computed(() => selectedDestination.value?.type === 'iotistica')
const isExternalDestination = computed(() => !!selectedDestination.value && !isIotisticaDestination.value)
const isInfluxDbDestination = computed(() => selectedDestination.value?.type === 'influxdb')
const isTimescaleDbDestination = computed(() => selectedDestination.value?.type === 'timescaledb')

const destinationTopicRules = computed(() =>
  isExternalDestination.value && !isInfluxDbDestination.value && !isTimescaleDbDestination.value
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

watch(
  () => props.open,
  (open) => {
    if (!open) return
    showAdvanced.value = false
    if (props.editing) {
      form.value = {
        publish_destination_id: props.editing.publish_destination_id,
        topics: [...props.editing.topics],
        route_json: props.editing.route_json ?? blankRoute(),
        payload_format: props.editing.payload_format,
        compression: props.editing.compression ?? null,
        enabled: props.editing.enabled,
      }
    } else {
      form.value = blankForm()
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

async function submit() {
  await formRef.value?.validate()
  saving.value = true

  const payload = { ...form.value }
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
    width="520"
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
        v-if="isExternalDestination && !isTimescaleDbDestination"
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

      <!-- Source Protocols -->
      <a-form-item
        label="Source Protocols"
        name="topics"
        extra="Which protocol endpoints feed this subscription. Leave empty to receive from all."
      >
        <a-select
          v-model:value="form.topics"
          mode="multiple"
          placeholder="All protocols (leave empty for all)"
        >
          <a-select-option v-for="p in SOURCE_PROTOCOLS" :key="p" :value="p">
            {{ p }}
          </a-select-option>
        </a-select>
      </a-form-item>

      <!-- Payload Format -->
      <a-form-item label="Payload Format" name="payload_format">
        <a-select v-model:value="form.payload_format">
          <a-select-option v-for="f in PAYLOAD_FORMATS" :key="f.value" :value="f.value">{{ f.label }}</a-select-option>
        </a-select>
      </a-form-item>

      <!-- Compression -->
      <a-form-item label="Compression" name="compression">
        <a-select v-model:value="form.compression">
          <a-select-option v-for="c in COMPRESSIONS" :key="String(c.value)" :value="c.value">
            {{ c.label }}
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
          <a-form-item label="Include metrics" extra="Select from the list or type a custom name">
            <a-select
              v-model:value="form.route_json!.includeMetrics"
              mode="tags"
              placeholder="All metrics (leave empty for all)"
              :options="(metricNames ?? []).map(n => ({ value: n, label: n }))"
            />
          </a-form-item>
          <a-form-item label="Exclude metrics" extra="Select from the list or type a custom name">
            <a-select
              v-model:value="form.route_json!.excludeMetrics"
              mode="tags"
              placeholder="None excluded"
              :options="(metricNames ?? []).map(n => ({ value: n, label: n }))"
            />
          </a-form-item>
          <a-form-item label="Include devices" extra="Select from the list or type a custom name">
            <a-select
              v-model:value="form.route_json!.includeDevices"
              mode="tags"
              placeholder="All devices (leave empty for all)"
              :options="(deviceNames ?? []).map(n => ({ value: n, label: n }))"
            />
          </a-form-item>
          <a-form-item label="Exclude devices">
            <a-select
              v-model:value="form.route_json!.excludeDevices"
              mode="tags"
              placeholder="None excluded"
              :options="(deviceNames ?? []).map(n => ({ value: n, label: n }))"
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
