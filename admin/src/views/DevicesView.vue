<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { CheckCircleOutlined, StopOutlined, DeleteOutlined, CopyOutlined } from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import { client } from '@/api/client'
import { protocolColor, protocolLabel } from '@/utils/protocol'

interface Device {
  uuid: string
  name: string
  protocol: string
  enabled: boolean
  identifier: string | null
  metadata?: Record<string, any>
  lastSeenAt: string | null
  created_at: string
}

const rows = ref<Device[]>([])
const loading = ref(false)
const activeProtocol = ref('')
let refreshTimer: ReturnType<typeof setInterval> | null = null

const selectedUuids = ref<string[]>([])
const deleting = ref(false)
const bulkEnabling = ref(false)
const bulkDisabling = ref(false)

const rowSelection = computed(() => ({
  selectedRowKeys: selectedUuids.value,
  onChange: (keys: string[]) => { selectedUuids.value = keys },
}))

const filtered = computed(() =>
  activeProtocol.value
    ? rows.value.filter(d => d.protocol === activeProtocol.value)
    : rows.value,
)

const protocolCounts = computed(() => {
  const counts: Record<string, number> = {}
  for (const d of rows.value) {
    counts[d.protocol] = (counts[d.protocol] ?? 0) + 1
  }
  return counts
})

const columns: TableColumnType[] = [
  { title: 'Name',       key: 'name',       ellipsis: true },
  { title: 'Protocol',   key: 'protocol',   width: 110 },
  { title: 'Identifier', key: 'identifier', width: 160, ellipsis: true },
  { title: 'UUID',       key: 'uuid',       width: 160 },
  { title: 'Last Seen',  key: 'lastSeen',   width: 130 },
  { title: 'Status',     key: 'status',     width: 110 },
]

async function load() {
  loading.value = true
  try {
    const { data } = await client.get<{ devices: Device[] }>('/v1/devices')
    rows.value = data.devices ?? []
  } finally {
    loading.value = false
  }
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

function deviceStatus(d: Device): { label: string; color: string } {
  if (!d.enabled) return { label: 'Disabled', color: 'default' }
  if (!d.lastSeenAt) return { label: 'Pending', color: 'gold' }
  const age = (Date.now() - new Date(d.lastSeenAt).getTime()) / 1000
  if (age < 300)  return { label: 'Active',   color: 'green' }
  if (age < 3600) return { label: 'Stale',    color: 'orange' }
  return { label: 'Inactive', color: 'red' }
}

function shortUuid(uuid: string): string {
  return uuid ? uuid.slice(0, 8) : '—'
}

// The uuid shown here is the exact `deviceId` value MQTT device-write commands
// expect (src/commands/types.ts) — copy-to-clipboard avoids users having to
// select-and-copy out of the truncated/tooltip display by hand.
async function copyUuid(uuid: string) {
  try {
    await navigator.clipboard.writeText(uuid)
    message.success('Device UUID copied')
  } catch {
    message.error('Could not copy to clipboard')
  }
}

function identifierLabel(d: Device): string {
  if (d.identifier) return d.identifier
  if (d.metadata?.slaveId != null) return `Slave ${d.metadata.slaveId}`
  return '—'
}

function confirmDeleteSelected() {
  const count = selectedUuids.value.length
  Modal.confirm({
    title: `Delete ${count} device${count !== 1 ? 's' : ''}?`,
    content: 'Removed devices will reappear if the endpoint reconnects.',
    okType: 'danger',
    okText: `Delete ${count}`,
    async onOk() {
      deleting.value = true
      try {
        const results = await Promise.allSettled(selectedUuids.value.map((uuid) => client.delete(`/v1/devices/${uuid}`)))
        reportBulkResult(results, 'Deleted', 'delete')
        selectedUuids.value = []
        await load()
      } finally {
        deleting.value = false
      }
    },
  })
}

// Promise.allSettled never throws — without inspecting each result, a bulk
// action against a broken/missing endpoint silently "succeeds" with nothing
// actually changed. Surface real failures instead of a blanket success.
function reportBulkResult(results: PromiseSettledResult<unknown>[], verbPast: string, verbInf: string): void {
  const failed = results.filter((r) => r.status === 'rejected').length
  const ok = results.length - failed
  if (failed === 0) {
    message.success(`${verbPast} ${ok} device${ok !== 1 ? 's' : ''}`)
  } else if (ok === 0) {
    message.error(`Failed to ${verbInf} ${failed} device${failed !== 1 ? 's' : ''}`)
  } else {
    message.warning(`${verbPast} ${ok}, failed to ${verbInf} ${failed}`)
  }
}

async function bulkEnable() {
  const uuids = [...selectedUuids.value]
  bulkEnabling.value = true
  try {
    const results = await Promise.allSettled(uuids.map((uuid) => client.patch(`/v1/devices/${uuid}`, { enabled: true })))
    reportBulkResult(results, 'Enabled', 'enable')
    selectedUuids.value = []
    await load()
  } finally {
    bulkEnabling.value = false
  }
}

async function bulkDisable() {
  const uuids = [...selectedUuids.value]
  bulkDisabling.value = true
  try {
    const results = await Promise.allSettled(uuids.map((uuid) => client.patch(`/v1/devices/${uuid}`, { enabled: false })))
    reportBulkResult(results, 'Disabled', 'disable')
    selectedUuids.value = []
    await load()
  } finally {
    bulkDisabling.value = false
  }
}

onMounted(() => {
  load()
  refreshTimer = setInterval(load, 30_000)
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>

<template>
  <AppLayout title="Devices">
    <div class="devices-page">
      <div class="page-header">
        <p class="subtitle">Physical and logical devices discovered through protocol endpoints</p>
      </div>

      <!-- Protocol filter tabs + table toolbar (same row, consistent with other grid pages) -->
      <div class="protocol-tabs">
        <a-radio-group
          v-model:value="activeProtocol"
          button-style="solid"
          size="small"
        >
          <a-radio-button value="">All ({{ rows.length }})</a-radio-button>
          <a-radio-button value="modbus">Modbus ({{ protocolCounts.modbus ?? 0 }})</a-radio-button>
          <a-radio-button value="opcua">OPC-UA ({{ protocolCounts.opcua ?? 0 }})</a-radio-button>
          <a-radio-button value="mqtt">MQTT ({{ protocolCounts.mqtt ?? 0 }})</a-radio-button>
          <a-radio-button value="bacnet">BACnet ({{ protocolCounts.bacnet ?? 0 }})</a-radio-button>
        </a-radio-group>

        <a-space>
          <template v-if="selectedUuids.length > 0">
            <span style="font-size: 13px; color: #666">{{ selectedUuids.length }} selected</span>
            <a-button :loading="bulkEnabling" @click="bulkEnable">
              <template #icon><CheckCircleOutlined /></template>
              Enable
            </a-button>
            <a-button :loading="bulkDisabling" @click="bulkDisable">
              <template #icon><StopOutlined /></template>
              Disable
            </a-button>
            <a-button danger :loading="deleting" @click="confirmDeleteSelected">
              <template #icon><DeleteOutlined /></template>
              Delete
            </a-button>
          </template>
          <a-button @click="load" :loading="loading">Refresh</a-button>
        </a-space>
      </div>

      <a-table
        :dataSource="filtered"
        :columns="columns"
        :loading="loading"
        :pagination="{ pageSize: 50, hideOnSinglePage: true }"
        :row-selection="rowSelection"
        row-key="uuid"
        size="small"
      >
        <template #bodyCell="{ column, record }">

          <template v-if="column.key === 'name'">
            <span class="device-name" :title="record.name">{{ record.metadata?.objectName || record.name }}</span>
          </template>

          <template v-else-if="column.key === 'protocol'">
            <a-tag :color="protocolColor(record.protocol)">
              {{ protocolLabel(record.protocol) }}
            </a-tag>
          </template>

          <template v-else-if="column.key === 'identifier'">
            <span class="mono-text">{{ identifierLabel(record) }}</span>
          </template>

          <template v-else-if="column.key === 'uuid'">
            <a-tooltip :title="record.uuid">
              <span class="mono-text uuid-chip">{{ shortUuid(record.uuid) }}</span>
            </a-tooltip>
            <a-button type="text" size="small" class="uuid-copy-btn" @click="copyUuid(record.uuid)">
              <CopyOutlined />
            </a-button>
          </template>

          <template v-else-if="column.key === 'lastSeen'">
            <span :class="['lastseen', record.lastSeenAt ? 'has-time' : 'no-time']">
              {{ timeSince(record.lastSeenAt) }}
            </span>
          </template>

          <template v-else-if="column.key === 'status'">
            <a-badge
              :color="deviceStatus(record).color === 'green' ? '#52c41a' : deviceStatus(record).color === 'orange' ? '#fa8c16' : deviceStatus(record).color === 'red' ? '#ff4d4f' : deviceStatus(record).color === 'gold' ? '#faad14' : '#8c8c8c'"
              :text="deviceStatus(record).label"
            />
          </template>

        </template>

        <template #emptyText>
          <a-empty description="No devices yet">
            <template #description>
              <span>Devices appear here once endpoints connect and report data.</span><br>
              <a-typography-link href="/admin/#/endpoints">Go to Endpoints →</a-typography-link>
            </template>
          </a-empty>
        </template>
      </a-table>
    </div>
  </AppLayout>
</template>

<style scoped>
.devices-page {
  padding: 24px;
  max-width: 1200px;
}

.page-header {
  margin-bottom: 20px;
}

.subtitle {
  margin: 0;
  color: #888;
  font-size: 13px;
}

.protocol-tabs {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 16px;
}

.device-name {
  font-weight: 400;
}

.mono-text {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
  color: #555;
}

.uuid-chip {
  background: #f0f0f0;
  padding: 1px 6px;
  border-radius: 4px;
  cursor: default;
  letter-spacing: 0.03em;
}

.uuid-copy-btn {
  margin-left: 4px;
  padding: 0 4px;
  color: #999;
}

.uuid-copy-btn:hover {
  color: #1677ff;
}

.lastseen {
  font-size: 12px;
}

.lastseen.has-time {
  color: #666;
}

.lastseen.no-time {
  color: #bbb;
}
</style>
