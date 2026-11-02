<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { message } from 'ant-design-vue'
import type { TableColumnType } from 'ant-design-vue'
import {
  PlayCircleOutlined,
  PauseCircleOutlined,
  ClearOutlined,
  DownloadOutlined,
  SearchOutlined,
} from '@ant-design/icons-vue'
import {
  networkApi,
  type CapturePacket,
  type CaptureStatusData,
  type CapturePacketDetail,
} from '@/api/network'

// ── State ──────────────────────────────────────────────────────────────────

const available = ref(false)
const status = ref<CaptureStatusData | null>(null)
const packets = ref<CapturePacket[]>([])
const loading = ref(false)
const starting = ref(false)
const stopping = ref(false)

// Filters (client-side)
const filterDirection = ref<string | undefined>(undefined)
const filterProtocol = ref<string | undefined>(undefined)
const filterSearch = ref('')

// BPF filter (server-side, applied at tcpdump level)
const bpfFilter = ref('')

// Detail drawer
const drawerOpen = ref(false)
const selectedPacket = ref<CapturePacketDetail | null>(null)
const loadingDetail = ref(false)

// WebSocket
let ws: WebSocket | null = null
const wsConnected = ref(false)
const paused = ref(false)

// Auto-scroll
const tableContainer = ref<HTMLElement | null>(null)
const autoScroll = ref(true)

// ── Computed ───────────────────────────────────────────────────────────────

const running = computed(() => status.value?.running ?? false)

const filteredPackets = computed(() => {
  let result = packets.value
  if (filterDirection.value) {
    result = result.filter((p) => p.direction === filterDirection.value)
  }
  if (filterProtocol.value) {
    result = result.filter((p) => p.protocolName === filterProtocol.value)
  }
  if (filterSearch.value) {
    const q = filterSearch.value.toLowerCase()
    result = result.filter(
      (p) =>
        p.info.toLowerCase().includes(q) ||
        p.srcIp.includes(q) ||
        p.dstIp.includes(q) ||
        p.protocolName.toLowerCase().includes(q),
    )
  }
  return result
})

const uniqueProtocols = computed(() => {
  const set = new Set(packets.value.map((p) => p.protocolName))
  return Array.from(set).sort()
})

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

// ── Table columns ──────────────────────────────────────────────────────────

const columns: TableColumnType<CapturePacket>[] = [
  { title: 'No.', dataIndex: 'id', key: 'id', width: 70 },
  {
    title: 'Time',
    dataIndex: 'timestamp',
    key: 'timestamp',
    width: 110,
    customRender: ({ value }) => {
      const d = new Date(value as number)
      return `${d.toLocaleTimeString()}.${String(d.getMilliseconds()).padStart(3, '0')}`
    },
  },
  {
    title: 'Source',
    key: 'source',
    width: 180,
    customRender: ({ record }) => {
      const p = record as CapturePacket
      return p.srcPort != null ? `${p.srcIp}:${p.srcPort}` : p.srcIp
    },
  },
  {
    title: 'Destination',
    key: 'destination',
    width: 180,
    customRender: ({ record }) => {
      const p = record as CapturePacket
      return p.dstPort != null ? `${p.dstIp}:${p.dstPort}` : p.dstIp
    },
  },
  { title: 'Protocol', dataIndex: 'protocolName', key: 'protocolName', width: 110 },
  { title: 'Length', dataIndex: 'length', key: 'length', width: 80 },
  { title: 'Info', dataIndex: 'info', key: 'info', ellipsis: true },
]

// ── Protocol tag colors ────────────────────────────────────────────────────

const protocolColors: Record<string, string> = {
  TCP: 'blue', UDP: 'green', ICMP: 'orange',
  MQTT: 'purple', 'MQTT/TLS': 'purple',
  HTTP: 'cyan', HTTPS: 'cyan', 'HTTP-Alt': 'cyan', 'HTTPS-Alt': 'cyan',
  DNS: 'gold', SSH: 'red', 'Modbus/TCP': 'volcano',
  'OPC-UA': 'magenta', 'BACnet/IP': 'lime',
  FTP: 'geekblue', NTP: 'default',
}

function getProtocolColor(proto: string): string {
  return protocolColors[proto] ?? 'default'
}

// ── Actions ────────────────────────────────────────────────────────────────

async function loadStatus() {
  try {
    const data = await networkApi.getCaptureStatus()
    available.value = data.available
    status.value = data.status
  } catch {
    available.value = false
  }
}

async function loadPackets() {
  if (!available.value) return
  loading.value = true
  try {
    const data = await networkApi.getCapturePackets({ limit: 10000 })
    packets.value = data.packets
  } finally {
    loading.value = false
  }
}

async function startCapture() {
  starting.value = true
  try {
    const opts: { filter?: string } = {}
    if (bpfFilter.value.trim()) opts.filter = bpfFilter.value.trim()
    await networkApi.startCapture(opts)
    packets.value = []
    paused.value = false
    await loadStatus()
    connectWs()
    message.success('Capture started')
  } catch (err: any) {
    message.error(err?.response?.data?.error || err?.message || 'Failed to start capture')
  } finally {
    starting.value = false
  }
}

async function stopCapture() {
  stopping.value = true
  try {
    await networkApi.stopCapture()
    disconnectWs()
    await loadStatus()
    message.success('Capture stopped')
  } catch (err: any) {
    message.error(err?.message || 'Failed to stop capture')
  } finally {
    stopping.value = false
  }
}

async function clearCapture() {
  try {
    await networkApi.clearCapture()
    packets.value = []
    await loadStatus()
  } catch (err: any) {
    message.error(err?.message || 'Failed to clear capture')
  }
}

function exportCapture() {
  const url = networkApi.getCaptureExportUrl()
  window.open(url, '_blank')
}

async function openPacketDetail(record: CapturePacket) {
  drawerOpen.value = true
  loadingDetail.value = true
  selectedPacket.value = null
  try {
    selectedPacket.value = await networkApi.getCapturePacket(record.id)
  } catch {
    message.error('Failed to load packet detail')
    drawerOpen.value = false
  } finally {
    loadingDetail.value = false
  }
}

// ── WebSocket ──────────────────────────────────────────────────────────────

function captureWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const apiBase = (import.meta.env.VITE_API_BASE_URL as string) || ''
  const host = apiBase ? new URL(apiBase, location.href).host : location.host
  return `${proto}://${host}/v1/capture`
}

function connectWs() {
  disconnectWs()
  ws = new WebSocket(captureWsUrl())
  ws.onopen = () => { wsConnected.value = true }
  ws.onclose = () => { wsConnected.value = false }
  ws.onerror = () => { wsConnected.value = false }
  ws.onmessage = (ev) => {
    if (paused.value) return
    try {
      const pkt = JSON.parse(ev.data) as CapturePacket
      packets.value.push(pkt)
      // Cap local array at 10k
      if (packets.value.length > 10_000) {
        packets.value = packets.value.slice(-10_000)
      }
      if (autoScroll.value) {
        nextTick(() => {
          const el = tableContainer.value?.querySelector('.ant-table-body')
          if (el) el.scrollTop = el.scrollHeight
        })
      }
    } catch { /* ignore malformed */ }
  }
}

function disconnectWs() {
  if (ws) {
    ws.onclose = null
    ws.close()
    ws = null
    wsConnected.value = false
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

onMounted(async () => {
  await loadStatus()
  if (running.value) {
    await loadPackets()
    connectWs()
  }
})

onUnmounted(() => {
  disconnectWs()
})

// Reconnect WS when capture starts externally
watch(running, (val) => {
  if (val && !wsConnected.value) connectWs()
  if (!val) disconnectWs()
})
</script>

<template>
  <a-alert
    v-if="!available"
    message="Packet capture is not available — tcpdump not found or insufficient permissions"
    type="info"
    show-icon
    style="margin-bottom: 16px"
  />

  <template v-if="available">
    <!-- Status bar -->
    <div v-if="status" class="status-bar">
      <a-tag :color="running ? 'green' : 'default'">
        {{ running ? 'Running' : 'Stopped' }}
      </a-tag>
      <a-tag v-if="wsConnected" color="blue">Live</a-tag>
      <template v-if="status.counters.seen > 0">
        <span class="counter">Packets: {{ status.counters.stored.toLocaleString() }}</span>
        <span class="counter">Seen: {{ status.counters.seen.toLocaleString() }}</span>
        <span v-if="status.counters.dropped > 0" class="counter" style="color: #ff4d4f">
          Dropped: {{ status.counters.dropped.toLocaleString() }}
        </span>
        <span class="counter">{{ formatBytes(status.counters.bytes) }}</span>
      </template>
    </div>

    <!-- Controls -->
    <div class="controls-bar">
      <a-space>
        <a-button
          v-if="!running"
          type="primary"
          :loading="starting"
          @click="startCapture"
        >
          <template #icon><PlayCircleOutlined /></template>
          Start
        </a-button>
        <a-button
          v-else
          danger
          :loading="stopping"
          @click="stopCapture"
        >
          <template #icon><PauseCircleOutlined /></template>
          Stop
        </a-button>

        <a-button :disabled="packets.length === 0" @click="clearCapture">
          <template #icon><ClearOutlined /></template>
          Clear
        </a-button>

        <a-button :disabled="packets.length === 0" @click="exportCapture">
          <template #icon><DownloadOutlined /></template>
          Export PCAP
        </a-button>

        <a-checkbox v-if="running" v-model:checked="paused">Pause display</a-checkbox>
        <a-checkbox v-model:checked="autoScroll">Auto-scroll</a-checkbox>
      </a-space>

      <a-input
        v-model:value="bpfFilter"
        placeholder="BPF filter (e.g. port 1883)"
        style="width: 240px"
        :disabled="running"
        @pressEnter="startCapture"
      />
    </div>

    <!-- Filters -->
    <div class="filter-bar">
      <a-select
        v-model:value="filterDirection"
        placeholder="Direction"
        allow-clear
        style="width: 130px"
        :get-popup-container="(t: HTMLElement) => t.parentElement!"
      >
        <a-select-option value="inbound">Inbound</a-select-option>
        <a-select-option value="outbound">Outbound</a-select-option>
      </a-select>

      <a-select
        v-model:value="filterProtocol"
        placeholder="Protocol"
        allow-clear
        style="width: 150px"
        :get-popup-container="(t: HTMLElement) => t.parentElement!"
      >
        <a-select-option v-for="p in uniqueProtocols" :key="p" :value="p">{{ p }}</a-select-option>
      </a-select>

      <a-input
        v-model:value="filterSearch"
        placeholder="Search..."
        style="width: 220px"
        allow-clear
      >
        <template #prefix><SearchOutlined /></template>
      </a-input>
    </div>

    <!-- Packet table -->
    <div ref="tableContainer">
      <a-table
        :columns="columns"
        :data-source="filteredPackets"
        :loading="loading"
        :pagination="false"
        row-key="id"
        size="small"
        :scroll="{ y: 500 }"
        :custom-row="(record: CapturePacket) => ({
          onClick: () => openPacketDetail(record),
          style: 'cursor: pointer',
        })"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'protocolName'">
            <a-tag :color="getProtocolColor((record as CapturePacket).protocolName)">
              {{ (record as CapturePacket).protocolName }}
            </a-tag>
          </template>
        </template>
      </a-table>
    </div>
  </template>

  <!-- Packet Detail Drawer -->
  <a-drawer
    :open="drawerOpen"
    title="Packet Detail"
    placement="right"
    :width="520"
    @close="drawerOpen = false"
  >
    <a-spin v-if="loadingDetail" />
    <template v-else-if="selectedPacket">
      <a-descriptions :column="1" bordered size="small">
        <a-descriptions-item label="No.">{{ selectedPacket.id }}</a-descriptions-item>
        <a-descriptions-item label="Time">
          {{ new Date(selectedPacket.timestamp).toLocaleString() }}.{{ String(new Date(selectedPacket.timestamp).getMilliseconds()).padStart(3, '0') }}
        </a-descriptions-item>
        <a-descriptions-item label="Source">
          {{ selectedPacket.srcPort != null ? `${selectedPacket.srcIp}:${selectedPacket.srcPort}` : selectedPacket.srcIp }}
        </a-descriptions-item>
        <a-descriptions-item label="Destination">
          {{ selectedPacket.dstPort != null ? `${selectedPacket.dstIp}:${selectedPacket.dstPort}` : selectedPacket.dstIp }}
        </a-descriptions-item>
        <a-descriptions-item label="Protocol">
          <a-tag :color="getProtocolColor(selectedPacket.protocolName)">{{ selectedPacket.protocolName }}</a-tag>
        </a-descriptions-item>
        <a-descriptions-item label="Direction">
          <a-tag :color="selectedPacket.direction === 'inbound' ? 'green' : selectedPacket.direction === 'outbound' ? 'blue' : 'default'">
            {{ selectedPacket.direction }}
          </a-tag>
        </a-descriptions-item>
        <a-descriptions-item label="IP Protocol">{{ selectedPacket.ipProtocol }}</a-descriptions-item>
        <a-descriptions-item label="Length">{{ selectedPacket.length }} bytes</a-descriptions-item>
        <a-descriptions-item label="Captured">{{ selectedPacket.capturedLength }} bytes</a-descriptions-item>
        <a-descriptions-item label="Info">{{ selectedPacket.info }}</a-descriptions-item>
      </a-descriptions>

      <h4 style="margin-top: 16px">Hex Dump</h4>
      <pre class="hex-dump">{{ selectedPacket.hexDump }}</pre>
    </template>
  </a-drawer>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.counter {
  font-size: 13px;
  color: var(--text-secondary, rgba(255, 255, 255, 0.65));
}

.controls-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
  gap: 8px;
}

.filter-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.hex-dump {
  font-family: 'Cascadia Code', 'Fira Code', 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.6;
  background: var(--bg-container, #141414);
  padding: 12px;
  border-radius: 6px;
  overflow-x: auto;
  white-space: pre;
  color: var(--text-primary, rgba(255, 255, 255, 0.85));
}
</style>
