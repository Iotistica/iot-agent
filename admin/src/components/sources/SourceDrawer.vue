<script setup lang="ts">
import { ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import type { FormInstance } from 'ant-design-vue'
import type { Endpoint, EndpointCreateData } from '@/types'
import { sourcesApi, type OPCUADeviceIdentification, type SourceTestResult } from '@/api/sources'
import { EditOutlined, FolderOpenOutlined } from '@ant-design/icons-vue'
import SourceConnectionFields from './SourceConnectionFields.vue'
import ModbusRegisterMapEditor from './ModbusRegisterMapEditor.vue'
import OPCUABrowser from './OPCUABrowser.vue'

const props = defineProps<{
  open: boolean
  editing: Endpoint | null
  prefill: EndpointCreateData | null
}>()

const emit = defineEmits<{
  'update:open': [val: boolean]
  saved: []
}>()

const PROTOCOLS = ['modbus', 'opcua', 'mqtt', 'bacnet']

const formRef = ref<FormInstance>()
const saving = ref(false)
const testing = ref(false)
const testResult = ref<SourceTestResult | null>(null)
const registerMapOpen = ref(false)
const opcuaBrowserOpen = ref(false)
const identification = ref<OPCUADeviceIdentification | null>(null)

function connectionWithDefaults(protocol: string, connection: Record<string, unknown> = {}) {
  return protocol === 'modbus' && connection.type == null ? { ...connection, type: 'tcp' } : { ...connection }
}

const form = ref<EndpointCreateData>({
  name: '',
  protocol: 'modbus',
  connection: { type: 'tcp' },
  poll_interval: 5000,
  enabled: true,
})

watch(
  () => props.open,
  (open) => {
    if (!open) {
      opcuaBrowserOpen.value = false
      return
    }
    testResult.value = null
    if (props.editing) {
      form.value = {
        name: props.editing.name,
        protocol: props.editing.protocol,
        connection: connectionWithDefaults(props.editing.protocol, props.editing.connection),
        poll_interval: props.editing.poll_interval,
        enabled: props.editing.enabled,
        data_points: props.editing.data_points ? [...props.editing.data_points] : undefined,
        metadata: props.editing.metadata ? { ...props.editing.metadata } : undefined,
      }
    } else if (props.prefill) {
      form.value = {
        name: props.prefill.name,
        protocol: props.prefill.protocol,
        connection: connectionWithDefaults(props.prefill.protocol, props.prefill.connection),
        poll_interval: props.prefill.poll_interval ?? 5000,
        enabled: props.prefill.enabled ?? true,
      }
    } else {
      form.value = { name: '', protocol: 'modbus', connection: { type: 'tcp' }, poll_interval: 5000, enabled: true }
    }
    identification.value = form.value.protocol === 'opcua' && form.value.connection.deviceIdentification
      ? { ...(form.value.connection.deviceIdentification as OPCUADeviceIdentification) } : null
  },
)

function onProtocolChange() {
  form.value.connection = connectionWithDefaults(form.value.protocol)
  form.value.data_points = undefined
  identification.value = null
  testResult.value = null
}

async function testConnection() {
  testResult.value = null
  testing.value = true
  try {
    testResult.value = await sourcesApi.test({
      protocol: form.value.protocol,
      connection: form.value.connection ?? {},
    })
  } catch (err: unknown) {
    const e = err as { message?: string }
    testResult.value = { ok: false, error: e?.message ?? 'Test failed' }
  } finally {
    testing.value = false
  }
}

async function submit() {
  await formRef.value?.validate()
  saving.value = true
  try {
    if (form.value.protocol === 'opcua') {
      if (identification.value) {
        form.value.connection = { ...form.value.connection, deviceIdentification: identification.value }
      } else {
        const { deviceIdentification: _deviceIdentification, ...connection } = form.value.connection
        form.value.connection = connection
      }
    }
    if (props.editing) {
      await sourcesApi.replace(props.editing.uuid, form.value)
      message.success('Source updated')
    } else {
      await sourcesApi.create(form.value)
      message.success('Source added')
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

function updateIdentifier(field: 'identifierProperty' | 'identifierPath', value: string) {
  identification.value = {
    rootNodeId: '', scopeNodeId: '', deviceTypeNodeId: '', identifierProperty: '', identifierPath: '',
    ...identification.value, [field]: value,
  }
}

function close() {
  emit('update:open', false)
}
</script>

<template>
  <a-drawer
    :open="open"
    :title="editing ? `Edit — ${editing.name}` : 'New Source'"
    :width="560"
    @close="close"
  >
    <a-form
      ref="formRef"
      :model="form"
      layout="vertical"
      autocomplete="off"
    >
      <a-form-item
        label="Name"
        name="name"
        :rules="[{ required: true, message: 'Name is required' }]"
      >
        <a-input v-model:value="form.name" placeholder="e.g. Warehouse Modbus Bus" />
      </a-form-item>

      <a-form-item label="Protocol" name="protocol">
        <a-select v-model:value="form.protocol" :disabled="!!editing" @change="onProtocolChange">
          <a-select-option v-for="p in PROTOCOLS" :key="p" :value="p">
            {{ p.toUpperCase() === 'OPCUA' ? 'OPC-UA' : p.charAt(0).toUpperCase() + p.slice(1) }}
          </a-select-option>
        </a-select>
      </a-form-item>

      <a-divider orientation="left" orientation-margin="0">Connection</a-divider>

      <SourceConnectionFields
        :protocol="form.protocol"
        :model-value="form.connection"
        @update:model-value="form.connection = $event"
      />

      <template v-if="form.protocol === 'opcua'">
        <a-button block :disabled="!form.connection.endpointUrl" @click="opcuaBrowserOpen = true">
          Browse OPC UA
          <template #icon><FolderOpenOutlined /></template>
        </a-button>
        <a-divider orientation="left" orientation-margin="0">Device Identification</a-divider>
        <p style="color: var(--text-tertiary)">Select a device root and identifier in the browser, or enter the identifier property and relative path.</p>
        <p v-if="editing" style="color: var(--text-tertiary)">Changes apply on the next discovery of this source.</p>
        <a-form-item label="Device Identifier Property">
          <a-input :value="identification?.identifierProperty ?? ''" placeholder="e.g. DeviceUUID"
            @update:value="updateIdentifier('identifierProperty', $event)" />
        </a-form-item>
        <a-form-item label="Device Identifier Path" extra="Relative to the selected device root, including the property name.">
          <a-input :value="identification?.identifierPath ?? ''" placeholder="e.g. Identification/DeviceUUID"
            @update:value="updateIdentifier('identifierPath', $event)" />
        </a-form-item>
        <div v-if="identification" style="margin-bottom: 12px; color: var(--text-tertiary)">
          Device root: {{ identification.rootNodeId || 'Not selected' }}
          <a-button type="link" size="small" @click="identification = null">Clear</a-button>
        </div>
      </template>

      <a-divider orientation="left" orientation-margin="0">Options</a-divider>

      <a-form-item label="Poll Interval (ms)" name="poll_interval">
        <a-input-number
          v-model:value="form.poll_interval"
          :min="100"
          :step="1000"
          style="width: 100%"
        />
      </a-form-item>

      <template v-if="form.protocol === 'modbus'">
        <a-divider orientation="left" orientation-margin="0">Register Map</a-divider>
        <a-button block @click="registerMapOpen = true">
          Configure Register Map
          <template #icon><EditOutlined /></template>
        </a-button>
        <div v-if="form.data_points?.length" style="margin-top: 8px; font-size: 12px; color: var(--text-tertiary)">
          {{ form.data_points.length }} register(s) configured
        </div>
      </template>

    </a-form>

    <a-alert
      v-if="testResult"
      :type="testResult.ok ? 'success' : 'error'"
      :message="testResult.ok ? testResult.message : testResult.error"
      show-icon
      style="margin-top: 12px"
    />

    <template #footer>
      <a-space style="width: 100%; justify-content: space-between">
        <a-space>
          <a-button :loading="testing" data-testid="source-drawer-test-connection" @click="testConnection">Test Connection</a-button>
          
        </a-space>
        <a-space>
          <a-button @click="close">Cancel</a-button>
          <a-button type="primary" :loading="saving" data-testid="source-drawer-submit" @click="submit">
            {{ editing ? 'Save' : 'Add Source' }}
          </a-button>
        </a-space>
      </a-space>
    </template>
  </a-drawer>

  <a-modal
    v-model:open="registerMapOpen"
    title="Register Map"
    :width="900"
    :footer="null"
    centered
  >
    <ModbusRegisterMapEditor
      :model-value="form.data_points"
      :connection="form.connection ?? {}"
      @update:model-value="form.data_points = $event"
    />
  </a-modal>
  <OPCUABrowser v-if="form.protocol === 'opcua'" v-model:open="opcuaBrowserOpen"
    :connection="form.connection" @select="identification = $event" />
</template>
