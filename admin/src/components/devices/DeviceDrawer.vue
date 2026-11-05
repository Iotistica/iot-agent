<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { message } from 'ant-design-vue'
import { PlusOutlined, DeleteOutlined, SendOutlined, CopyOutlined, CheckOutlined } from '@ant-design/icons-vue'
import { client } from '@/api/client'
import { deviceApi, type WritablePoint } from '@/api/device'
import { copyText } from '@/utils/clipboard'
import { protocolColor, protocolLabel } from '@/utils/protocol'

interface Device {
  uuid: string
  name: string
  protocol: string
  enabled: boolean
  identifier: string | null
  metadata?: Record<string, any>
  assetPath?: string | null
  lastSeenAt: string | null
  created_at: string
}

const props = defineProps<{
  open: boolean
  device: Device | null
}>()

const emit = defineEmits<{
  'update:open': [val: boolean]
  saved: []
}>()

const saving = ref(false)
const assetPath = ref('')
const metadataEntries = ref<Array<{ key: string; value: string }>>([])
const newKey = ref('')
const newValue = ref('')

const systemMetadataKeys = new Set(['objectName', 'slaveId', 'nodeCount'])

const writeModalOpen = ref(false)
const writePointName = ref<string | undefined>(undefined)
const writeValue = ref('')
const writeSending = ref(false)
const writablePoints = ref<WritablePoint[]>([])
const loadingPoints = ref(false)
const copiedUuid = ref(false)

async function copyUuid() {
  if (!props.device) return
  await copyText(props.device.uuid)
  copiedUuid.value = true
  setTimeout(() => { copiedUuid.value = false }, 2000)
}

async function openWriteModal() {
  writePointName.value = undefined
  writeValue.value = ''
  writablePoints.value = []
  writeModalOpen.value = true
  if (!props.device) return
  loadingPoints.value = true
  try {
    writablePoints.value = await deviceApi.getWritablePoints(props.device.uuid)
  } catch {
    writablePoints.value = []
  } finally {
    loadingPoints.value = false
  }
}

const selectedPoint = computed(() => writablePoints.value.find((p) => p.name === writePointName.value))

function parseWriteValue(raw: string): number | boolean | string {
  if (raw === 'true') return true
  if (raw === 'false') return false
  const n = Number(raw)
  if (raw !== '' && !isNaN(n)) return n
  return raw
}

async function submitWrite() {
  if (!props.device || !writePointName.value) return
  writeSending.value = true
  try {
    const val = parseWriteValue(writeValue.value)
    await deviceApi.writePoint(props.device.uuid, writePointName.value, val)
    message.success(`Wrote ${writeValue.value} to ${writePointName.value}`)
    writeModalOpen.value = false
  } catch (err: unknown) {
    const e = err as { response?: { data?: { error?: string } }; message?: string }
    message.error(e?.response?.data?.error ?? e?.message ?? 'Write failed')
  } finally {
    writeSending.value = false
  }
}

function syncFromDevice() {
  if (!props.device) return
  assetPath.value = props.device.assetPath || ''
  const meta = props.device.metadata || {}
  metadataEntries.value = Object.entries(meta)
    .filter(([k]) => !systemMetadataKeys.has(k))
    .map(([key, value]) => ({ key, value: String(value) }))
  newKey.value = ''
  newValue.value = ''
  writablePoints.value = []
  copiedUuid.value = false
  deviceApi.getWritablePoints(props.device.uuid).then((pts) => { writablePoints.value = pts }).catch(() => { writablePoints.value = [] })
}

watch(() => props.open, (open) => { if (open) syncFromDevice() })
watch(() => props.device, () => { if (props.open) syncFromDevice() })

function addEntry() {
  const k = newKey.value.trim()
  const v = newValue.value.trim()
  if (!k) return
  if (metadataEntries.value.some(e => e.key === k)) {
    message.warning(`Key "${k}" already exists`)
    return
  }
  metadataEntries.value.push({ key: k, value: v })
  newKey.value = ''
  newValue.value = ''
}

function removeEntry(index: number) {
  metadataEntries.value.splice(index, 1)
}

async function save() {
  if (!props.device) return

  if (newKey.value.trim()) {
    addEntry()
  }

  saving.value = true
  try {
    const metadata: Record<string, any> = { ...(props.device.metadata || {}) }
    for (const k of Object.keys(metadata)) {
      if (!systemMetadataKeys.has(k)) delete metadata[k]
    }
    for (const entry of metadataEntries.value) {
      if (entry.key.trim()) metadata[entry.key.trim()] = entry.value
    }

    await client.patch(`/v1/devices/${props.device.uuid}`, {
      metadata,
      assetPath: assetPath.value.trim() || null,
    })
    message.success('Device updated')
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

function timeSince(ts: string | null): string {
  if (!ts) return '—'
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
  if (isNaN(diff) || diff < 0) return '—'
  if (diff < 5)    return 'just now'
  if (diff < 60)   return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}
</script>

<template>
  <a-drawer
    :open="open"
    title="Device"
    width="520"
    @close="close"
  >
    <template v-if="device">
      <!-- Device info (read-only) -->
      <a-descriptions :column="2" size="small" bordered style="margin-bottom: 24px">
        <a-descriptions-item label="Name" :span="2">{{ device.metadata?.objectName || device.name }}</a-descriptions-item>
        <a-descriptions-item label="Protocol">
          <a-tag :color="protocolColor(device.protocol)" style="margin: 0">{{ protocolLabel(device.protocol) }}</a-tag>
        </a-descriptions-item>
        <a-descriptions-item label="Status">
          <a-badge :color="device.enabled ? '#52c41a' : '#8c8c8c'" :text="device.enabled ? 'Enabled' : 'Disabled'" />
        </a-descriptions-item>
        <a-descriptions-item label="UUID" :span="2">
          <span class="mono-text">{{ device.uuid }}</span>
          <a-button type="text" size="small" class="uuid-copy-btn" @click="copyUuid">
            <CheckOutlined v-if="copiedUuid" style="color: #52c41a" />
            <CopyOutlined v-else />
          </a-button>
        </a-descriptions-item>
        <a-descriptions-item v-if="device.identifier" label="Identifier">{{ device.identifier }}</a-descriptions-item>
        <a-descriptions-item label="Last Seen">{{ timeSince(device.lastSeenAt) }}</a-descriptions-item>
      </a-descriptions>

      <!-- Asset Path -->
      <a-divider orientation="left" class="section-divider">Enrichment</a-divider>

      <a-form layout="vertical">
        <a-form-item label="Asset Path" extra="Hierarchy path injected into publish payloads and available as {assetPath} in MQTT topic templates.">
          <a-input v-model:value="assetPath" placeholder="e.g. Chicago/Plant-3/Line-A/CNC-01" />
        </a-form-item>
      </a-form>

      <!-- Custom Metadata KV -->
      <div class="section-label" style="margin-bottom: 8px">Custom Metadata</div>
      <div class="meta-hint">Key-value pairs included in the publish payload <code>context.metadata</code> block.</div>

      <div v-for="(entry, idx) in metadataEntries" :key="idx" class="kv-row">
        <a-input v-model:value="entry.key" placeholder="Key" class="kv-key" />
        <a-input v-model:value="entry.value" placeholder="Value" class="kv-value" />
        <a-button type="text" danger size="small" @click="removeEntry(idx)">
          <template #icon><DeleteOutlined /></template>
        </a-button>
      </div>

      <div class="kv-row" style="margin-top: 4px">
        <a-input v-model:value="newKey" placeholder="New key" class="kv-key" @press-enter="addEntry" />
        <a-input v-model:value="newValue" placeholder="Value" class="kv-value" @press-enter="addEntry" />
        <a-button type="text" size="small" @click="addEntry">
          <template #icon><PlusOutlined /></template>
        </a-button>
      </div>

      <!-- Write Value -->
      <template v-if="writablePoints.length > 0">
        <a-divider orientation="left" class="section-divider">Commands</a-divider>
        <a-button @click="openWriteModal">
          <template #icon><SendOutlined /></template>
          Write Value
        </a-button>
      </template>
    </template>

    <template #footer>
      <a-space>
        <a-button @click="close">Cancel</a-button>
        <a-button type="primary" :loading="saving" @click="save">Save</a-button>
      </a-space>
    </template>
  </a-drawer>

  <a-modal
    v-model:open="writeModalOpen"
    title="Write Value"
    :confirm-loading="writeSending"
    :ok-button-props="{ disabled: !writePointName || writeValue === '' }"
    @ok="submitWrite"
  >
    <a-form layout="vertical">
      <a-form-item label="Point" required>
        <a-select
          v-model:value="writePointName"
          placeholder="Select a writable point"
          :loading="loadingPoints"
          show-search
          :filter-option="(input: string, option: any) => option.label?.toLowerCase().includes(input.toLowerCase())"
        >
          <a-select-option v-for="p in writablePoints" :key="p.name" :value="p.name" :label="p.name">
            {{ p.name }}
          </a-select-option>
        </a-select>
        <div v-if="!loadingPoints && writablePoints.length === 0" style="font-size: 12px; color: var(--text-tertiary); margin-top: 4px">
          No writable points configured for this device.
        </div>
      </a-form-item>
      <div v-if="selectedPoint?.unit" style="font-size: 12px; color: var(--text-tertiary); margin-bottom: 12px">
        Unit: <strong>{{ selectedPoint.unit }}</strong>
      </div>
      <a-form-item label="Value" required>
        <a-input v-model:value="writeValue" placeholder="e.g. 1500" />
      </a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.mono-text {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-all;
}

.uuid-copy-btn {
  margin-left: 4px;
  padding: 0 4px;
  color: var(--text-muted);
}

.uuid-copy-btn:hover {
  color: #1677ff;
}

.section-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}

.section-divider {
  font-size: 13px;
  color: var(--text-tertiary);
}

.meta-hint {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-bottom: 12px;
}

.meta-hint code {
  font-size: 11px;
  padding: 1px 4px;
  background: var(--bg-subtle);
  border-radius: 3px;
}

.kv-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 6px;
}

.kv-key {
  width: 40%;
}

.kv-value {
  flex: 1;
}
</style>
