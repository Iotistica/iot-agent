<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import type { TableColumnType } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import { client } from '@/api/client'
import { pipelineApi, type SubscriptionActivity, type ActivityEvent } from '@/api/pipeline'
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
type DeviceRecord = { uuid: string; name: string; metadata?: Record<string, unknown> }
const subscriptions = ref<SubscriptionActivity[]>([])
const events = ref<ActivityEvent[]>([])
const devices = ref<DeviceRecord[]>([])
const loading = ref(true)
const error = ref('')
const search = ref('')
const protocolFilter = ref<string | undefined>(undefined)
const sourceFilter = ref<string | undefined>(undefined)
const qualityFilter = ref<string | undefined>(undefined)
const selected = ref<PointRow | null>(null)
const drawerOpen = ref(false)
const paused = ref(false)
const favoritesOnly = ref(false)
const favorites = ref<string[]>([])
const sortBySource = ref(false)
const pageSize = ref(20)
const lastSync = ref('')
const refreshing = ref(false)
const now = ref(Date.now())
const POLL_MS = 5000
let timer: ReturnType<typeof setInterval> | undefined
let busy = false

const deviceNames = computed(() => {
  const map = new Map<string, string>()
  for (const d of devices.value) {
    const friendly = (d.metadata?.objectName as string | undefined) || d.name
    map.set(`${friendly}-${d.uuid.slice(0, 8)}`, friendly)
    map.set(friendly, friendly)
  }
  return map
})
function friendlySource(name: string) { return deviceNames.value.get(name) || name }
function pointName(row: PointRow) { return row.normalizedName || row.rawPointName || row.rawObjectName || row.metric }
function originalName(row: PointRow) { return row.rawPointName || row.rawObjectName || row.metric }
function valueText(v: unknown) {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2)
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}
function age(iso: string) {
  const ms = new Date(iso).getTime()
  if (!Number.isFinite(ms)) return 'Unknown'
  const s = Math.max(0, Math.floor((now.value - ms) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
function isStale(iso: string) {
  const t = new Date(iso).getTime()
  return Number.isFinite(t) && now.value - t > 60000
}
// Events are a bounded recent sample, not a historical database or a full point inventory.
// Keep the most recent event per protocol/source/metric/destination combination.
const points = computed<PointRow[]>(() => {
  const byKey = new Map<string, PointRow>()
  for (const e of events.value) {
    const key = JSON.stringify([e.protocol, e.endpointName, e.metric, e.destinationName])
    const row: PointRow = {
      key, protocol: e.protocol, endpointName: e.endpointName, metric: e.metric,
      normalizedName: e.normalizedName, rawPointName: e.rawPointName,
      rawObjectName: e.rawObjectName, value: e.value, quality: e.quality,
      unit: e.unit, timestamp: e.timestamp, destinationName: e.destinationName,
    }
    const previous = byKey.get(key)
    if (!previous || Date.parse(row.timestamp) > Date.parse(previous.timestamp)) byKey.set(key, row)
  }
  // Subscription snapshots can contain a latest reading not present in the last 100 events.
  for (const s of subscriptions.value) {
    if (!s.lastMetric || !s.lastPublishTime) continue
    const key = JSON.stringify([s.protocol, s.endpointName, s.lastMetric, s.destinationName])
    const row: PointRow = {
      key, protocol: s.protocol, endpointName: s.endpointName, metric: s.lastMetric,
      normalizedName: s.normalizedName, rawPointName: s.rawPointName,
      rawObjectName: s.rawObjectName, value: s.lastValue, quality: s.lastQuality,
      unit: s.lastUnit, timestamp: s.lastPublishTime, destinationName: s.destinationName,
    }
    const previous = byKey.get(key)
    if (!previous || Date.parse(row.timestamp) > Date.parse(previous.timestamp)) byKey.set(key, row)
  }
  return [...byKey.values()].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
})
const sourceOptions = computed(() => [...new Set(points.value.map(p => p.endpointName))]
  .sort((a, b) => friendlySource(a).localeCompare(friendlySource(b)))
  .map(v => ({ value: v, label: friendlySource(v) })))
const protocolOptions = computed(() => [...new Set(points.value.map(p => p.protocol))].sort()
  .map(v => ({ value: v, label: protocolLabel(v) })))
const filteredPoints = computed(() => points.value.filter(p => {
  const q = search.value.trim().toLowerCase()
  return (!favoritesOnly.value || favorites.value.includes(p.key)) && (!q || [friendlySource(p.endpointName), p.metric, p.normalizedName, p.rawPointName, p.rawObjectName, p.destinationName]
    .some(v => (v || '').toLowerCase().includes(q)))
    && (!protocolFilter.value || p.protocol === protocolFilter.value)
    && (!sourceFilter.value || p.endpointName === sourceFilter.value)
    && (!qualityFilter.value || (qualityFilter.value === 'STALE' ? isStale(p.timestamp) : qualityFilter.value === 'BAD' ? p.quality === 'BAD' : p.quality !== 'BAD' && !isStale(p.timestamp)))
}).sort((a,b) => sortBySource.value
  ? friendlySource(a.endpointName).localeCompare(friendlySource(b.endpointName)) || pointName(a).localeCompare(pointName(b))
  : Date.parse(b.timestamp) - Date.parse(a.timestamp)))
const favoriteCount = computed(() => points.value.filter(p => favorites.value.includes(p.key)).length)
function toggleFavorite(key: string) {
  favorites.value = favorites.value.includes(key)
    ? favorites.value.filter(v => v !== key) : [...favorites.value, key]
  try { localStorage.setItem('iot-explorer-favorites', JSON.stringify(favorites.value)) } catch { /* optional */ }
}
function exportCsv() {
  const quote = (v: unknown) => '"' + String(v ?? '').replace(/"/g, '""') + '"'
  const rows = filteredPoints.value.map(p => [
    protocolLabel(p.protocol), friendlySource(p.endpointName), pointName(p), originalName(p),
    valueText(p.value), p.unit || '', p.quality || '', p.timestamp, p.destinationName
  ])
  const header = ['Protocol','Source','Point','Original','Value','Unit','Quality','Timestamp','Destination']
  const csv = '\\uFEFF' + [header, ...rows].map(r => r.map(quote).join(',')).join('\\r\\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'data-explorer.csv'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
const badCount = computed(() => points.value.filter(p => p.quality === 'BAD').length)
const staleCount = computed(() => points.value.filter(p => isStale(p.timestamp)).length)
const columns: TableColumnType<PointRow>[] = [
  { title: '★', key: 'favorite', width: 52 },
  { title: 'Protocol', key: 'protocol', width: 105 },
  { title: 'Source', key: 'source', width: 180, ellipsis: true },
  { title: 'Point', key: 'point', width: 320, ellipsis: true, sorter: (a, b) => pointName(a).localeCompare(pointName(b)) },
  { title: 'Latest Value', key: 'value', width: 135 },
  { title: 'Unit', key: 'unit', width: 115, ellipsis: true },
  { title: 'Quality', key: 'quality', width: 105 },
  { title: 'Updated', key: 'updated', width: 110 },
  { title: 'Destination', dataIndex: 'destinationName', key: 'destinationName', width: 150, ellipsis: true },
  { title: '', key: 'action', width: 75 },
]
async function loadDevices() {
  try {
    const { data } = await client.get<{ devices: DeviceRecord[] }>('/v1/devices')
    devices.value = data.devices || []
  } catch { /\* friendly names are optional \*/ }
}
async function poll() {
  if (busy) return
  busy = true
  refreshing.value = true
  try {
    const [subs, evts] = await Promise.all([pipelineApi.getSubscriptions(), pipelineApi.getEvents(100)])
    subscriptions.value = subs
    events.value = evts
    error.value = ''
    lastSync.value = new Date().toLocaleTimeString()
    now.value = Date.now()
  } catch {
    error.value = 'Unable to refresh readings. Showing the last available data.'
  } finally {
    loading.value = false
    busy = false
    refreshing.value = false
  }
}
function inspect(row: PointRow) { selected.value = row; drawerOpen.value = true }
function resetFilters() { search.value = ''; protocolFilter.value = undefined; sourceFilter.value = undefined; qualityFilter.value = undefined }
watch(points, () => {
  if (selected.value) selected.value = points.value.find(p => p.key === selected.value?.key) || selected.value
})
onMounted(() => {
  try {
    const saved = JSON.parse(localStorage.getItem('iot-explorer-favorites') || '[]')
    if (Array.isArray(saved)) favorites.value = saved.filter((v): v is string => typeof v === 'string')
  } catch { /* ignore invalid preferences */ }
  loadDevices()
  poll()
  timer = setInterval(() => { now.value = Date.now(); if (!paused.value) poll() }, POLL_MS)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <AppLayout title="Data Explorer">
    <div class="explorer">

      <div class="heading">
        <div>
          <h2>Explore connected points</h2>
          <p>Search, inspect and export the latest readings across your connected sources.</p>
        </div>
        <div class="header-actions">
          <a-tag :color="error ? 'orange' : paused ? 'default' : 'green'">{{ error ? 'Refresh error' : paused ? 'Paused' : 'Auto-refresh · 5s' }}</a-tag>
          <a-button @click="paused = !paused">{{ paused ? 'Resume' : 'Pause' }}</a-button>
          <a-button :loading="refreshing" @click="poll">Refresh now</a-button>
          <a-button type="primary" @click="exportCsv">Export CSV</a-button>
        </div>
      </div>
      <a-alert v-if="error"  type="warning" show-icon :message="error" style="margin-bottom: 14px" />
      <a-row :gutter="12" class="stats">
        <a-col :xs="12" :md="6"><a-card size="small"><a-statistic title="Observed points" :value="points.length" /></a-card></a-col>
        <a-col :xs="12" :md="6"><a-card size="small"><a-statistic title="Active subscriptions" :value="subscriptions.length" /></a-card></a-col>
        <a-col :xs="12" :md="6"><a-card size="small"><a-statistic title="Bad quality" :value="badCount" /></a-card></a-col>
        <a-col :xs="12" :md="6"><a-card size="small"><a-statistic title="No update in 60s" :value="staleCount" /></a-card></a-col>
      </a-row>
      <a-card size="small" class="browser-card">
          <div class="browser-heading"><div><h3>Point browser</h3><span>Current values and point metadata</span></div><span class="browser-count">{{ filteredPoints.length }} results</span></div>
        <div class="filters">
          <a-input v-model:value="search" placeholder="Search source, point, destination…" allow-clear class="search" />
          <a-select v-model:value="protocolFilter" :options="protocolOptions" placeholder="All protocols" allow-clear class="filter" />
          <a-select v-model:value="sourceFilter" :options="sourceOptions" show-search option-filter-prop="label" placeholder="All sources" allow-clear class="filter" />
          <a-select v-model:value="qualityFilter" placeholder="All states" allow-clear class="filter">
            <a-select-option value="GOOD">Good / current</a-select-option>
            <a-select-option value="BAD">Bad quality</a-select-option>
            <a-select-option value="STALE">No update in 60s</a-select-option>
          </a-select>
          <a-button @click="resetFilters">Clear</a-button>
        </div>
        <div class="toolbar">
            <a-checkbox v-model:checked="sortBySource">Sort by source</a-checkbox>
            <a-checkbox v-model:checked="favoritesOnly">Favorites ({{ favoriteCount }})</a-checkbox>
            <span class="toolbar-spacer"></span><span>Rows per page</span>
            <a-select v-model:value="pageSize" style="width: 82px" :options="[{value:10,label:'10'},{value:20,label:'20'},{value:50,label:'50'}]" />
          </div>
          <div class="results">Showing {{ filteredPoints.length }} of {{ points.length }} recently observed points · {{ paused ? "Refresh paused" : "Refreshes every 5 seconds" }}<span v-if="lastSync"> · Last sync {{ lastSync }}</span></div>
        <a-table :columns="columns" :data-source="filteredPoints" :loading="loading" row-key="key" size="small" :pagination="{ pageSize, showSizeChanger: false }" :scroll="{ x: 1250 }">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'favorite'"><a-button type="text" size="small" :aria-label="favorites.includes(record.key) ? 'Remove favorite' : 'Add favorite'" @click="toggleFavorite(record.key)"><span :class="favorites.includes(record.key) ? 'star active' : 'star'">{{ favorites.includes(record.key) ? '★' : '☆' }}</span></a-button></template>
              <template v-else-if="column.key === 'protocol'"><a-tag :color="protocolColor(record.protocol)">{{ protocolLabel(record.protocol) }}</a-tag></template>
            <template v-else-if="column.key === 'source'">{{ friendlySource(record.endpointName) }}</template>
            <template v-else-if="column.key === 'point'"><div class="point-primary" :title="pointName(record)">{{ pointName(record) }}</div><div v-if="record.normalizedName" class="point-secondary" :title="originalName(record)">Original: {{ originalName(record) }}</div></template>
            <template v-else-if="column.key === 'value'"><a-tag v-if="record.quality === 'BAD' && record.value == null" color="red">No Value</a-tag><span v-else class="monospace">{{ valueText(record.value) }}</span></template>
            <template v-else-if="column.key === 'unit'">{{ record.unit || '—' }}</template>
            <template v-else-if="column.key === 'quality'"><a-tag v-if="record.quality === 'BAD'" color="red">BAD</a-tag><a-tag v-else-if="isStale(record.timestamp)" color="orange">STALE</a-tag><a-tag v-else color="green">{{ record.quality || 'CURRENT' }}</a-tag></template>
            <template v-else-if="column.key === 'updated'"><span :class="isStale(record.timestamp) ? 'age stale' : 'age'"><i class="status-dot"></i>{{ age(record.timestamp) }}</span></template>
            <template v-else-if="column.key === 'action'"><a-button type="link" size="small" @click="inspect(record)">Inspect</a-button></template>
          </template>
          <template #emptyText>No matching recent readings. Check your source, subscription, and destination configuration.</template>
        </a-table>
      </a-card>
      <p class="note">This view uses the latest 100 activity events plus subscription snapshots. It is not a complete point inventory or historical archive. “Stale” means no observed update for 60 seconds, not necessarily a device failure.</p>
    </div>
    <a-drawer v-model:open="drawerOpen" title="Point details" :width="440">
      <template v-if="selected">
        <a-descriptions :column="1" bordered size="small">
          <a-descriptions-item label="Point">{{ pointName(selected) }}</a-descriptions-item>
          <a-descriptions-item label="Original name">{{ originalName(selected) }}</a-descriptions-item>
          <a-descriptions-item label="Source">{{ friendlySource(selected.endpointName) }}</a-descriptions-item>
          <a-descriptions-item label="Protocol">{{ protocolLabel(selected.protocol) }}</a-descriptions-item>
          <a-descriptions-item label="Latest value">{{ valueText(selected.value) }}</a-descriptions-item>
          <a-descriptions-item label="Unit">{{ selected.unit || '—' }}</a-descriptions-item>
          <a-descriptions-item label="Quality">{{ selected.quality || 'Not provided' }}</a-descriptions-item>
          <a-descriptions-item label="Last observed">{{ selected.timestamp }} ({{ age(selected.timestamp) }})</a-descriptions-item>
          <a-descriptions-item label="Destination">{{ selected.destinationName }}</a-descriptions-item>
          <a-descriptions-item label="Metric key">{{ selected.metric }}</a-descriptions-item>
        </a-descriptions>
      </template>
    </a-drawer>
  </AppLayout>
</template>

<style scoped>
.explorer { padding: 2px 0 24px; }
.eyebrow { font-size: 10px; letter-spacing: 1.3px; font-weight: 700; color: #8a95a5; margin-bottom: 7px; }
.header-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.browser-heading { display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; }
.browser-heading h3 { font-size: 15px; margin: 0 0 3px; font-weight: 650; }
.browser-heading span { color: #8b94a3; font-size: 11px; }
.browser-count { background: #f1f5fb; border-radius: 20px; padding: 5px 12px; }
.toolbar { display: flex; align-items: center; gap: 18px; padding: 10px 0; flex-wrap: wrap; color: #7c8795; font-size: 12px; }
.toolbar-spacer { flex: 1; }
.star { font-size: 21px; color: #a5afbb; }
.star.active { color: #e2a42c; }
.age { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
.status-dot { width: 7px; height: 7px; border-radius: 50%; background: #3cb77d; display: inline-block; }
.age.stale .status-dot { background: #ed9a38; }
.stats :deep(.ant-card) { border-radius: 9px; border-color: #e7ebf0; }
.stats :deep(.ant-card-body) { padding: 17px 18px; }
.browser-card { border-radius: 9px; }
.browser-card :deep(.ant-table-thead > tr > th) { background: #f7f9fc; font-size: 12px; font-weight: 650; }
.browser-card :deep(.ant-table-tbody > tr:hover > td) { background: #f5f9ff; }
@media (max-width: 900px) { .heading { align-items: flex-start; flex-direction: column; } .toolbar-spacer { flex-basis: 100%; } }
.heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
.heading h2 { font-size: 19px; font-weight: 600; margin: 0 0 3px; }
.heading p { color: #777; margin: 0; }
.stats { margin-bottom: 14px; }
.filters { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.search { width: 300px; max-width: 100%; }
.filter { width: 170px; max-width: 100%; }
.results, .note { color: #888; font-size: 12px; margin-bottom: 10px; }
.note { margin-top: 12px; }
.point-primary { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.point-secondary { color: #777; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.monospace { font-family: monospace; }
</style>
