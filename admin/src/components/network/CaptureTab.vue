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
  type NetworkInterfaceInfo,
} from '@/api/network'

// ── State ──────────────────────────────────────────────────────────────────

const available = ref(false)
const status = ref<CaptureStatusData | null>(null)
const packets = ref<CapturePacket[]>([])
const loading = ref(false)
const starting = ref(false)
const stopping = ref(false)
const switchingInterface = ref(false)
const interfacesLoading = ref(false)
const interfacesLoadError = ref(false)
const networkInterfaces = ref<NetworkInterfaceInfo[]>([])

function readSelectedInterface(): string {
  try {
    return typeof window === 'undefined'
      ? 'any'
      : window.sessionStorage.getItem('iotistica.capture.interface') || 'any'
  } catch {
    return 'any'
  }
}

function saveSelectedInterface(iface: string) {
  try {
    window.sessionStorage.setItem('iotistica.capture.interface', iface)
  } catch {
    // Keep selection in memory when session storage is unavailable.
  }
}

const selectedInterface = ref(readSelectedInterface())

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
// Prevent queued WebSocket messages from extending the UI while Stop is pending.
const stopRequested = ref(false)
let pendingPackets: CapturePacket[] = []
let packetFlushTimer: ReturnType<typeof setTimeout> | null = null
const PACKET_FLUSH_MS = 75

function cancelPacketFlush() {
  if (packetFlushTimer !== null) {
    clearTimeout(packetFlushTimer)
    packetFlushTimer = null
  }
  pendingPackets = []
}

function flushPacketBatch() {
  packetFlushTimer = null
  if (stopRequested.value || paused.value || pendingPackets.length === 0) {
    pendingPackets = []
    return
  }
  packets.value = [...packets.value, ...pendingPackets].slice(-10_000)
  pendingPackets = []
  if (autoScroll.value) {
    nextTick(() => {
      const el = tableContainer.value?.querySelector('.ant-table-body')
      if (el) el.scrollTop = el.scrollHeight
    })
  }
}

// Auto-scroll
const tableContainer = ref<HTMLElement | null>(null)
const autoScroll = ref(true)

// ── Computed ───────────────────────────────────────────────────────────────

const running = computed(() => status.value?.running ?? false)
const selectedInterfaceUnavailable = computed(() =>
  selectedInterface.value !== 'any' &&
  !networkInterfaces.value.some((iface) => iface.name === selectedInterface.value),
)

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

const KNOWN_PROTOCOLS = [
  'ARP', 'BACnet/IP', 'DNS', 'HTTP', 'HTTPS', 'ICMP', 'MQTT', 'MQTT/TLS',
  'Modbus/TCP', 'OPC-UA', 'SSH', 'TCP', 'UDP',
]

const uniqueProtocols = computed(() => {
  const set = new Set(KNOWN_PROTOCOLS)
  for (const p of packets.value) set.add(p.protocolName)
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

// ── Helpers ───────────────────────────────────────────────────────────────

function formatDetailKey(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase())
}

// ── Protocol tag colors ────────────────────────────────────────────────────

const protocolColors: Record<string, string> = {
    ARP: 'gold', TCP: 'blue', UDP: 'green', ICMP: 'orange',
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

function formatCaptureInterface(iface: string): string {
  return iface === 'any' ? 'Any interface' : iface
}

function getInterfaceLabel(iface: NetworkInterfaceInfo): string {
  const type = iface.type?.toLowerCase()
  const typeLabel = type === 'wireless' || type === 'wifi'
    ? 'Wi-Fi'
    : type === 'wired' || type === 'ethernet'
      ? 'Ethernet'
      : iface.type ?? ''
  const displayType = iface.virtual ? (typeLabel ? `Virtual ${typeLabel}` : 'Virtual') : typeLabel
  return displayType ? `${iface.name} — ${displayType}` : iface.name
}

// ── Actions ────────────────────────────────────────────────────────────────

async function loadStatus() {
  try {
    const data = await networkApi.getCaptureStatus()
    available.value = data.available
    status.value = data.status
    if (data.status?.running) {
      selectedInterface.value = data.status.iface || 'any'
      saveSelectedInterface(selectedInterface.value)
    }
  } catch {
    available.value = false
    status.value = null
  }
}

async function loadInterfaces() {
  interfacesLoading.value = true
  interfacesLoadError.value = false
  try {
    const interfaces = await networkApi.getInterfaces()
    networkInterfaces.value = Array.from(new Map(interfaces.map((iface) => [iface.name, iface])).values())
  } catch {
    networkInterfaces.value = []
    interfacesLoadError.value = true
  } finally {
    interfacesLoading.value = false
  }
}

async function loadPackets() {
  if (!available.value) return
  loading.value = true
  try {
    const data = await networkApi.getCapturePackets({ limit: 10000 })
    if (!stopRequested.value) packets.value = data.packets
  } finally {
    loading.value = false
  }
}

async function startCapture() {
  if (starting.value || stopping.value || switchingInterface.value) return
  starting.value = true
  stopRequested.value = false
  try {
    const opts: { filter?: string; iface: string } = { iface: selectedInterface.value }
    if (bpfFilter.value.trim()) opts.filter = bpfFilter.value.trim()
    const result = await networkApi.startCapture(opts)
    status.value = result.status
    selectedInterface.value = result.status.iface
    saveSelectedInterface(selectedInterface.value)
    packets.value = []
    cancelPacketFlush()
    paused.value = false
    connectWs()
    message.success('Capture started')
  } catch (err: any) {
    message.error(err?.response?.data?.error || err?.message || 'Failed to start capture')
    await Promise.all([loadStatus(), loadInterfaces()])
  } finally {
    starting.value = false
  }
}

async function stopCapture() {
  if (starting.value || stopping.value || switchingInterface.value) return
  stopping.value = true
  // Stop UI ingestion immediately; do not wait for the backend tcpdump shutdown.
  stopRequested.value = true
  disconnectWs()
  try {
    status.value = await networkApi.stopCapture()
    message.success('Capture stopped')
  } catch (err: any) {
    message.error(err?.response?.data?.error || err?.message || 'Failed to stop capture')
    await loadStatus()
    // Restore the live feed only if the backend says capture is still running.
    if (status.value?.running) {
      stopRequested.value = false
      connectWs()
    }
  } finally {
    stopping.value = false
  }
}

async function handleInterfaceChange(value: string) {
  const nextInterface = value || 'any'
  const previousInterface = selectedInterface.value
  if (nextInterface === previousInterface || switchingInterface.value) return

  if (!running.value) {
    selectedInterface.value = nextInterface
    saveSelectedInterface(nextInterface)
    return
  }

  switchingInterface.value = true
  try {
    const result = await networkApi.switchCaptureInterface({
      iface: nextInterface,
      filter: bpfFilter.value.trim() || undefined,
    })
    status.value = result.status
    selectedInterface.value = result.status.iface
    saveSelectedInterface(selectedInterface.value)
    message.success(`Capture switched to ${formatCaptureInterface(result.status.iface)}`)
  } catch (err: any) {
    message.error(err?.response?.data?.error || err?.message || 'Failed to switch capture interface')
    await Promise.all([loadStatus(), loadInterfaces()])
    selectedInterface.value = status.value?.running ? status.value.iface : previousInterface
  } finally {
    switchingInterface.value = false
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
  const socket = new WebSocket(captureWsUrl())
  ws = socket
  socket.onopen = () => { if (ws === socket) wsConnected.value = true }
  socket.onclose = () => { if (ws === socket) wsConnected.value = false }
  socket.onerror = () => { if (ws === socket) wsConnected.value = false }
  socket.onmessage = (ev) => {
    if (ws !== socket) return
    if (paused.value || stopRequested.value || stopping.value) return
    try {
      pendingPackets.push(JSON.parse(ev.data) as CapturePacket)
      // Batch reactive table updates to avoid rendering on every incoming packet.
      if (packetFlushTimer === null) packetFlushTimer = setTimeout(flushPacketBatch, PACKET_FLUSH_MS)
    } catch { /* ignore malformed */ }
  }
}

function disconnectWs() {
  cancelPacketFlush()
  if (ws) {
    ws.onopen = null
    ws.onmessage = null
    ws.onclose = null
    ws.onerror = null
    ws.close()
    ws = null
    wsConnected.value = false
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

onMounted(async () => {
  await Promise.all([loadStatus(), loadInterfaces()])
  if (running.value) {
    await loadPackets()
    connectWs()
  }
})

onUnmounted(() => {
  stopRequested.value = true
  disconnectWs()
})

// Reconnect WS when capture starts externally
watch(running, (val) => {
  if (val && !wsConnected.value && !stopping.value && !stopRequested.value) connectWs()
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
        {{ running ? `Capturing · ${formatCaptureInterface(status.iface)}` : 'Stopped' }}
      </a-tag>
      <a-tag v-if="wsConnected" color="blue">Live</a-tag>
      <template v-if="status.counters.seen > 0">
        <span class="counter">Stored: {{ status.counters.stored.toLocaleString() }}</span>
        <span class="counter">Seen: {{ status.counters.seen.toLocaleString() }}</span>
        <span class="counter">Evicted: {{ status.counters.evicted.toLocaleString() }}</span>
        <span v-if="status.counters.dropped !== null && status.counters.dropped > 0" class="counter" style="color: #ff4d4f">
          Dropped: {{ status.counters.dropped.toLocaleString() }}
        </span>
        <span class="counter">{{ formatBytes(status.counters.bytes) }}</span>
      </template>
    </div>

    <!-- Filters and actions -->
    <div class="capture-toolbar">
      <div class="capture-filters">
        <a-select
          :value="selectedInterface"
          class="toolbar-interface"
          :loading="interfacesLoading || switchingInterface"
          :disabled="starting || stopping || switchingInterface"
          :not-found-content="interfacesLoadError ? 'Could not load interfaces' : 'No interfaces found'"
          @focus="loadInterfaces"
          @change="handleInterfaceChange"
        >
          <a-select-option value="any">Any interface (all)</a-select-option>
          <a-select-option v-if="selectedInterfaceUnavailable" :value="selectedInterface">
            {{ selectedInterface }} (unavailable)
          </a-select-option>
          <a-select-option v-for="iface in networkInterfaces" :key="iface.name" :value="iface.name">
            {{ getInterfaceLabel(iface) }}
          </a-select-option>
        </a-select>

        <a-input
          v-model:value="bpfFilter"
          class="toolbar-bpf"
          placeholder="BPF filter"
          :disabled="running || starting || stopping || switchingInterface"
          @pressEnter="startCapture"
        />

        <a-select
          v-model:value="filterDirection"
          placeholder="Direction"
          allow-clear
          class="toolbar-direction"
          :get-popup-container="(t: HTMLElement) => t.parentElement!"
        >
          <a-select-option value="inbound">Inbound</a-select-option>
          <a-select-option value="outbound">Outbound</a-select-option>
        </a-select>

        <a-select
          v-model:value="filterProtocol"
          placeholder="Protocol"
          allow-clear
          class="toolbar-protocol"
          :get-popup-container="(t: HTMLElement) => t.parentElement!"
        >
          <a-select-option v-for="p in uniqueProtocols" :key="p" :value="p">{{ p }}</a-select-option>
        </a-select>

        <a-input v-model:value="filterSearch" placeholder="Search..." allow-clear class="toolbar-search">
          <template #prefix><SearchOutlined /></template>
        </a-input>
      </div>

      <div class="capture-actions">
        <a-checkbox v-model:checked="autoScroll">Auto-scroll</a-checkbox>
        <a-button
          v-if="!running"
          type="primary"
          :loading="starting"
          :disabled="stopping || switchingInterface"
          @click="startCapture"
        >
          <template #icon><PlayCircleOutlined /></template>
          Start
        </a-button>
        <a-button
          v-else
          danger
          :loading="stopping"
          :disabled="starting || switchingInterface"
          @click="stopCapture"
        >
          <template #icon><PauseCircleOutlined /></template>
          Stop
        </a-button>

        <a-button :disabled="packets.length === 0 || starting || stopping || switchingInterface" @click="clearCapture">
          <template #icon><ClearOutlined /></template>
          Clear
        </a-button>

        <a-button :disabled="packets.length === 0" @click="exportCapture">
          <template #icon><DownloadOutlined /></template>
          Export PCAP
        </a-button>

        <a-checkbox v-if="running" v-model:checked="paused">Pause display</a-checkbox>
      </div>
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
          <template v-else-if="column.key === 'info'">
            <span :style="(record as CapturePacket).decoded?.status === 'error' ? 'color: #ff4d4f'
                        : (record as CapturePacket).decoded?.status === 'warning' ? 'color: #faad14'
                        : undefined">
              {{ (record as CapturePacket).info }}
            </span>
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
        <a-descriptions-item v-if="selectedPacket.arp" label="Operation">
          {{ selectedPacket.arp.operationName }}
        </a-descriptions-item>
        <a-descriptions-item v-if="selectedPacket.arp" label="Sender IP">
          {{ selectedPacket.arp.senderIp }}
        </a-descriptions-item>
        <a-descriptions-item v-if="selectedPacket.arp" label="Sender MAC">
          {{ selectedPacket.arp.senderMac }}
        </a-descriptions-item>
        <a-descriptions-item v-if="selectedPacket.arp" label="Target IP">
          {{ selectedPacket.arp.targetIp }}
        </a-descriptions-item>
        <a-descriptions-item v-if="selectedPacket.arp" label="Target MAC">
          {{ selectedPacket.arp.targetMac }}
        </a-descriptions-item>
        <a-descriptions-item v-else label="IP Protocol">
          {{ selectedPacket.ipProtocol < 0 ? 'N/A' : selectedPacket.ipProtocol }}
        </a-descriptions-item>
        <a-descriptions-item label="Length">{{ selectedPacket.length }} bytes</a-descriptions-item>
        <a-descriptions-item label="Captured">{{ selectedPacket.capturedLength }} bytes</a-descriptions-item>
        <a-descriptions-item label="Info">{{ selectedPacket.info }}</a-descriptions-item>
      </a-descriptions>

      <template v-if="selectedPacket.decoded">
        <div class="section-divider">Protocol Decode</div>
        <a-descriptions :column="1" bordered size="small">
          <a-descriptions-item label="Operation">
            <a-tag :color="selectedPacket.decoded.status === 'error' ? 'red'
                          : selectedPacket.decoded.status === 'warning' ? 'orange'
                          : 'blue'">
              {{ selectedPacket.decoded.operation }}
            </a-tag>
          </a-descriptions-item>
          <a-descriptions-item
            v-for="(value, key) in selectedPacket.decoded.details"
            :key="key"
            :label="formatDetailKey(String(key))"
          >
            {{ value }}
          </a-descriptions-item>
        </a-descriptions>
      </template>

      <div class="section-divider">Hex Dump</div>
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

.capture-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.capture-filters {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
}

.capture-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  flex: 0 0 auto;
  white-space: nowrap;
}

.toolbar-interface {
  width: 180px;
  flex-shrink: 0;
}

.toolbar-bpf {
  width: 210px;
  flex: 1 1 180px;
  min-width: 160px;
}

.toolbar-direction {
  width: 125px;
  flex-shrink: 0;
}

.toolbar-protocol {
  width: 145px;
  flex-shrink: 0;
}

.toolbar-search {
  width: 190px;
  flex: 1 1 160px;
  min-width: 145px;
}

@media (max-width: 1320px) {
  .capture-toolbar {
  margin-bottom: 12px;
  flex-wrap: wrap;
  }

  .capture-filters {
    flex: 1 1 100%;
    flex-wrap: wrap;
  }
}

@media (max-width: 760px) {
  .capture-filters > * {
    flex: 1 1 160px;
    min-width: 0;
  }

  .capture-actions {
    flex-wrap: wrap;
    margin-left: 0;
  }
}

.section-divider {
  margin-top: 20px;
  margin-bottom: 12px;
  padding: 6px 12px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.65);
  border-left: 3px solid #1668dc;
  background: rgba(22, 104, 220, 0.08);
  border-radius: 0 4px 4px 0;
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
