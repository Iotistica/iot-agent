<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons-vue'
import type { FormInstance } from 'ant-design-vue'
import type { Asset, AssetFormData, AssetMetricBinding, Endpoint } from '@/types'
import { assetsApi } from '@/api/assets'
import { sourcesApi } from '@/api/sources'

const CRITICALITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
]

const props = defineProps<{
  open: boolean
  editing: Asset | null
}>()

const emit = defineEmits<{
  'update:open': [val: boolean]
  saved: []
}>()

const formRef = ref<FormInstance>()
const saving = ref(false)

const blankForm = (): AssetFormData => ({
  name: '',
  asset_type: null,
  criticality: 'medium',
  manufacturer: null,
  model: null,
  rated_life_hours: null,
  rated_cycles: null,
  install_date: null,
  last_service_date: null,
  location: null,
})

const form = ref<AssetFormData>(blankForm())

// Dates round-trip as epoch ms (matches the assets table columns); the date
// picker itself works in a "x" (epoch ms string) value-format.
const installDateStr = ref<string | undefined>(undefined)
const lastServiceDateStr = ref<string | undefined>(undefined)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    if (props.editing) {
      form.value = {
        name: props.editing.name,
        asset_type: props.editing.asset_type,
        criticality: props.editing.criticality,
        manufacturer: props.editing.manufacturer,
        model: props.editing.model,
        rated_life_hours: props.editing.rated_life_hours,
        rated_cycles: props.editing.rated_cycles,
        install_date: props.editing.install_date,
        last_service_date: props.editing.last_service_date,
        location: props.editing.location,
      }
      installDateStr.value = props.editing.install_date != null ? String(props.editing.install_date) : undefined
      lastServiceDateStr.value = props.editing.last_service_date != null ? String(props.editing.last_service_date) : undefined
      metrics.value = [...props.editing.metrics]
    } else {
      form.value = blankForm()
      installDateStr.value = undefined
      lastServiceDateStr.value = undefined
      metrics.value = []
    }
  },
)

async function submit() {
  await formRef.value?.validate()
  saving.value = true
  try {
    const payload: AssetFormData = {
      ...form.value,
      install_date: installDateStr.value ? Number(installDateStr.value) : null,
      last_service_date: lastServiceDateStr.value ? Number(lastServiceDateStr.value) : null,
    }
    if (props.editing) {
      await assetsApi.update(props.editing.uuid, payload)
      message.success('Asset updated')
      emit('saved')
    } else {
      await assetsApi.create(payload)
      message.success('Asset created')
      emit('update:open', false)
      emit('saved')
    }
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

// ── Metric bindings (only meaningful once the asset exists) ─────────────────
// Tracked locally rather than read off props.editing.metrics directly: the
// `editing` prop is a snapshot handed down when the row's Edit button was
// clicked, and doesn't refresh mid-drawer just because a `saved` event told
// the parent list to reload — so add/remove here update this copy in place.
const endpoints = ref<Endpoint[]>([])
const metrics = ref<AssetMetricBinding[]>([])
const bindingDeviceUuid = ref<string | undefined>(undefined)
const bindingMetric = ref('')
const addingBinding = ref(false)

async function loadEndpoints() {
  try {
    endpoints.value = await sourcesApi.getAll()
  } catch {
    // non-fatal — the picker just falls back to empty
  }
}

function endpointName(uuid: string): string {
  return endpoints.value.find((e) => e.uuid === uuid)?.name ?? uuid
}

async function addBinding() {
  if (!props.editing || !bindingDeviceUuid.value || !bindingMetric.value.trim()) return
  addingBinding.value = true
  try {
    const binding = await assetsApi.addMetric(props.editing.uuid, {
      device_uuid: bindingDeviceUuid.value,
      endpoint_uuid: null,
      metric: bindingMetric.value.trim(),
    })
    metrics.value.push(binding)
    bindingDeviceUuid.value = undefined
    bindingMetric.value = ''
    message.success('Metric bound')
    emit('saved')
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Failed to bind metric')
  } finally {
    addingBinding.value = false
  }
}

function removeBinding(binding: AssetMetricBinding) {
  if (!props.editing) return
  Modal.confirm({
    title: `Remove "${binding.metric}"?`,
    okType: 'danger',
    okText: 'Remove',
    async onOk() {
      await assetsApi.removeMetric(props.editing!.uuid, binding.id)
      metrics.value = metrics.value.filter((m) => m.id !== binding.id)
      message.success('Removed')
      emit('saved')
    },
  })
}

onMounted(loadEndpoints)
</script>

<template>
  <a-drawer
    :open="open"
    :title="editing ? 'Edit Asset' : 'New Asset'"
    width="520"
    @close="close"
  >
    <a-form ref="formRef" :model="form" layout="vertical">
      <a-form-item label="Name" name="name" :rules="[{ required: true, message: 'Name is required' }]">
        <a-input v-model:value="form.name" placeholder="e.g. Compressor Unit A" />
      </a-form-item>

      <a-row :gutter="16">
        <a-col :span="12">
          <a-form-item label="Equipment Type" name="asset_type">
            <a-input v-model:value="form.asset_type" placeholder="e.g. compressor" />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item
            label="Criticality"
            name="criticality"
            extra="Drives rule urgency defaults and publish priority — not just a label."
          >
            <a-select v-model:value="form.criticality">
              <a-select-option v-for="c in CRITICALITY_OPTIONS" :key="c.value" :value="c.value">{{ c.label }}</a-select-option>
            </a-select>
          </a-form-item>
        </a-col>
      </a-row>

      <a-row :gutter="16">
        <a-col :span="12">
          <a-form-item label="Manufacturer" name="manufacturer">
            <a-input v-model:value="form.manufacturer" />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item label="Model" name="model">
            <a-input v-model:value="form.model" />
          </a-form-item>
        </a-col>
      </a-row>

      <a-row :gutter="16">
        <a-col :span="12">
          <a-form-item
            label="Rated life (hours)"
            name="rated_life_hours"
            extra="Used as the default cumulative-runtime threshold for maintenance rules."
          >
            <a-input-number v-model:value="form.rated_life_hours" :min="0" style="width: 100%" placeholder="e.g. 20000" />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item label="Rated cycles" name="rated_cycles">
            <a-input-number v-model:value="form.rated_cycles" :min="0" style="width: 100%" />
          </a-form-item>
        </a-col>
      </a-row>

      <a-row :gutter="16">
        <a-col :span="12">
          <a-form-item label="Install date" name="install_date">
            <a-date-picker v-model:value="installDateStr" value-format="x" style="width: 100%" />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item label="Last service date" name="last_service_date">
            <a-date-picker v-model:value="lastServiceDateStr" value-format="x" style="width: 100%" />
          </a-form-item>
        </a-col>
      </a-row>

      <a-form-item label="Location" name="location">
        <a-input v-model:value="form.location" placeholder="e.g. Building 2, Floor 1" />
      </a-form-item>
    </a-form>

    <!-- ── Metric bindings ─────────────────────────────────────────────── -->
    <a-divider orientation="left" style="font-size: 13px; color: #888">Metrics</a-divider>

    <template v-if="!editing">
      <span style="color: #888; font-size: 13px">Save the asset first, then bind the metrics that describe its condition.</span>
    </template>
    <template v-else>
      <a-list :data-source="metrics" size="small" style="margin-bottom: 12px">
        <template #renderItem="{ item }">
          <a-list-item>
            <span style="font-size: 13px">
              {{ item.metric }}
              <span style="color: #888"> — {{ endpointName(item.device_uuid) }}</span>
            </span>
            <template #actions>
              <a-button size="small" danger @click="removeBinding(item)">
                <template #icon><DeleteOutlined /></template>
              </a-button>
            </template>
          </a-list-item>
        </template>
        <template #emptyText>
          <span style="font-size: 12px; color: #aaa">No metrics bound yet.</span>
        </template>
      </a-list>

      <a-space style="width: 100%" :size="8">
        <a-select
          v-model:value="bindingDeviceUuid"
          placeholder="Device"
          style="width: 180px"
          show-search
          :filter-option="(input: string, option: any) => option.label.toLowerCase().includes(input.toLowerCase())"
          :options="endpoints.map((e) => ({ value: e.uuid, label: e.name }))"
        />
        <a-input v-model:value="bindingMetric" placeholder="Metric name, e.g. vibration_rms" style="width: 200px" />
        <a-button :loading="addingBinding" @click="addBinding">
          <template #icon><PlusOutlined /></template>
          Bind
        </a-button>
      </a-space>
    </template>

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
