<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import type { TableColumnType } from 'ant-design-vue'
import { Modal } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import { client } from '@/api/client'
import { pipelineApi, type SubscriptionActivity, type ActivityEvent } from '@/api/pipeline'
import { datasetsApi, type MlDataset } from '@/api/ml-datasets'
import { protocolColor, protocolLabel } from '@/utils/protocol'
import { BarChartOutlined, WifiOutlined, WarningOutlined, ClockCircleOutlined, SaveOutlined, CloseOutlined, DatabaseOutlined, CopyOutlined, EditOutlined, DeleteOutlined, DownloadOutlined, ReloadOutlined } from '@ant-design/icons-vue'
import CreateDatasetDrawer from '@/components/CreateDatasetDrawer.vue'
import CreateViewDrawer from '@/components/CreateViewDrawer.vue'
import { viewsApi, type SavedView as SavedViewType } from '@/api/views'

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
const observedPointCount = ref(0)
const loading = ref(true)
const error = ref('')
const search = ref('')
const protocolFilter = ref<string | undefined>(undefined)
const sourceFilter = ref<string | undefined>(undefined)
const qualityFilter = ref<string | undefined>(undefined)
const selected = ref<PointRow | null>(null)
const drawerOpen = ref(false)
const paused = ref(false)
const favorites = ref<string[]>([])
function favKey(p: PointRow): string { return `${p.endpointName}::${p.metric}` }
function normalizePointKey(key: string): string {
  try {
    const parts = JSON.parse(key)
    if (Array.isArray(parts) && parts.length === 4) return JSON.stringify(parts.slice(0, 3))
    return key
  } catch { return key }
}
const favPointCache = ref(new Map<string, PointRow>())
type SavedView = SavedViewType
const savedViews = ref<SavedView[]>([])
const activeTab = ref('all')
const openViewIds = ref<string[]>([])
const viewsLoading = ref(false)
const viewError = ref('')
const selectedPointKeys = ref<string[]>([])
const viewDrawerOpen = ref(false)
const editingView = ref<SavedView | null>(null)
const viewMode = computed(() => activeTab.value === 'favorites' ? 'favorites' : 'all')
const activeSavedView = computed(() => savedViews.value.find(v => v.id === activeTab.value))
const activeViewIds = computed(() => new Set((activeSavedView.value?.pointKeys || []).map(normalizePointKey)))
const rowSelection = computed(() => ({
  selectedRowKeys: selectedPointKeys.value,
  onChange: (keys: (string | number)[]) => { selectedPointKeys.value = keys.map(String) },
}))
const pageSize = ref(20)
const tableSortField = ref<string | null>(null)
const tableSortOrder = ref<'ascend' | 'descend' | null>(null)
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
// Keep the most recent event per protocol/source/metric combination.
const points = computed<PointRow[]>(() => {
  const byKey = new Map<string, PointRow>()
  for (const e of events.value) {
    const key = JSON.stringify([e.protocol, e.endpointName, e.metric])
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
    const key = JSON.stringify([s.protocol, s.endpointName, s.lastMetric])
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
function persistFavorites() {
  try {
    localStorage.setItem('iot-explorer-favorites', JSON.stringify(favorites.value))
    const cache: Record<string, PointRow> = {}
    for (const [k, v] of favPointCache.value) cache[k] = v
    localStorage.setItem('iot-explorer-fav-cache', JSON.stringify(cache))
  } catch {}
}
watch([points, favorites], () => {
  for (const p of points.value) {
    const fk = favKey(p)
    if (favorites.value.includes(fk)) favPointCache.value.set(fk, p)
  }
  for (const fk of favPointCache.value.keys()) {
    if (!favorites.value.includes(fk)) favPointCache.value.delete(fk)
  }
  persistFavorites()
})
const sourceOptions = computed(() => [...new Set(points.value.map(p => p.endpointName))]
  .sort((a, b) => friendlySource(a).localeCompare(friendlySource(b)))
  .map(v => ({ value: v, label: friendlySource(v) })))
const protocolOptions = computed(() => [...new Set(points.value.map(p => p.protocol))].sort()
  .map(v => ({ value: v, label: protocolLabel(v) })))
function columnSort(a: PointRow, b: PointRow): number {
  const field = tableSortField.value
  const desc = tableSortOrder.value === 'descend' ? -1 : 1
  if (!field) return Date.parse(b.timestamp) - Date.parse(a.timestamp)
  if (field === 'source') return desc * friendlySource(a.endpointName).localeCompare(friendlySource(b.endpointName))
  if (field === 'point') return desc * pointName(a).localeCompare(pointName(b))
  if (field === 'value') {
    const na = typeof a.value === 'number' ? a.value : parseFloat(String(a.value ?? ''))
    const nb = typeof b.value === 'number' ? b.value : parseFloat(String(b.value ?? ''))
    if (isNaN(na) && isNaN(nb)) return 0
    if (isNaN(na)) return 1
    if (isNaN(nb)) return -1
    return desc * (na - nb)
  }
  if (field === 'updated') return desc * (Date.parse(a.timestamp) - Date.parse(b.timestamp))
  return 0
}
const filteredPoints = computed(() => {
  const liveKeys = new Set(points.value.map(favKey))
  const source = [...points.value]
  for (const [fk, p] of favPointCache.value) {
    if (!liveKeys.has(fk)) source.push(p)
  }
  const q = search.value.trim().toLowerCase()
  const filtered = source.filter(p => {
    return (viewMode.value !== 'favorites' || favorites.value.includes(favKey(p)))
        && (!activeSavedView.value || activeViewIds.value.has(p.key))
      && (!q || [friendlySource(p.endpointName), p.metric, p.normalizedName, p.rawPointName, p.rawObjectName, p.destinationName]
        .some(v => (v || '').toLowerCase().includes(q)))
      && (!protocolFilter.value || p.protocol === protocolFilter.value)
      && (!sourceFilter.value || p.endpointName === sourceFilter.value)
      && (!qualityFilter.value || (qualityFilter.value === 'STALE' ? isStale(p.timestamp) : qualityFilter.value === 'BAD' ? p.quality === 'BAD' : p.quality !== 'BAD' && !isStale(p.timestamp)))
  })
  if (viewMode.value === 'favorites') {
    return filtered.sort((a, b) => friendlySource(a.endpointName).localeCompare(friendlySource(b.endpointName)) || pointName(a).localeCompare(pointName(b)))
  }
  return filtered.sort(columnSort)
})
const favoriteCount = computed(() => favorites.value.length)
const normalizedViewKeys = computed(() => activeSavedView.value
  ? [...new Set(activeSavedView.value.pointKeys.map(normalizePointKey))] : [])
const missingViewCount = computed(() => normalizedViewKeys.value.filter(key => !points.value.some(p => p.key === key)).length)
const candidateViewPoints = computed(() =>
  points.value.filter(p => selectedPointKeys.value.includes(p.key)))
function openCreateView(_selectedOnly = false) {
  editingView.value = null
  viewDrawerOpen.value = true
}
function openEditView(view: SavedView) {
  editingView.value = view
  viewDrawerOpen.value = true
}
async function loadViews() {
  viewsLoading.value = true
  try {
    savedViews.value = await viewsApi.list()
    viewError.value = ''
  } catch { viewError.value = 'Saved views API is unavailable.' }
  finally { viewsLoading.value = false }
}
function onViewSaved() {
  loadViews()
}
function activateTab(id: string) { activeTab.value = id }
function openSavedView(id: string) {
  if (!openViewIds.value.includes(id)) openViewIds.value.push(id)
  activeTab.value = id
}
function closeSavedView(id: string) {
  openViewIds.value = openViewIds.value.filter(v => v !== id)
  if (activeTab.value === id) activeTab.value = 'all'
}
async function deleteSavedView(id: string) {
  try {
    await viewsApi.remove(id)
    closeSavedView(id)
    await loadViews()
  } catch { viewError.value = 'Unable to delete the saved view.' }
}

function toggleFavorite(key: string) {
  if (favorites.value.includes(key)) {
    favorites.value = favorites.value.filter(v => v !== key)
    favPointCache.value.delete(key)
  } else {
    favorites.value = [...favorites.value, key]
    const point = points.value.find(p => favKey(p) === key)
    if (point) favPointCache.value.set(key, point)
  }
  persistFavorites()
}

// ── ML Datasets ──────────────────────────────────────────────────────────────
const datasets = ref<MlDataset[]>([])
const datasetsLoading = ref(false)
const datasetDrawerOpen = ref(false)
const editingDataset = ref<MlDataset | null>(null)
const candidateDatasetPoints = computed(() =>
  points.value.filter(p => selectedPointKeys.value.includes(p.key)))

async function loadDatasets() {
  datasetsLoading.value = true
  try {
    datasets.value = await datasetsApi.list()
  } catch { /* datasets API may not be available yet */ }
  finally { datasetsLoading.value = false }
}

function openCreateDataset() {
  editingDataset.value = null
  datasetDrawerOpen.value = true
}

function openEditDataset(ds: MlDataset) {
  editingDataset.value = ds
  datasetDrawerOpen.value = true
}

async function duplicateDataset(ds: MlDataset) {
  try {
    await datasetsApi.create({
      name: ds.name + ' (copy)',
      description: ds.description,
      pointKeys: ds.pointKeys,
      samplingIntervalSecs: ds.samplingIntervalSecs,
      windowSecs: ds.windowSecs,
      missingValues: ds.missingValues,
      normalization: ds.normalization,
      excludeBadQuality: ds.excludeBadQuality,
      removeOutliers: ds.removeOutliers,
      outlierMethod: ds.removeOutliers ? ds.outlierMethod : undefined,
      outputFormat: ds.outputFormat,
    })
    await loadDatasets()
  } catch { /* error handled by interceptor */ }
}

function deleteDataset(id: string) {
  Modal.confirm({
    title: 'Delete this dataset?',
    okType: 'danger',
    okText: 'Delete',
    async onOk() {
      await datasetsApi.remove(id)
      await loadDatasets()
    },
  })
}

function onDatasetSaved() {
  loadDatasets()
}


function formatInterval(secs: number): string {
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${secs / 60}m`
  return `${secs / 3600}h`
}

function downloadCsv(rows: PointRow[], filename: string) {
  const quote = (v: unknown) => '"' + String(v ?? '').replace(/"/g, '""') + '"'
  const data = rows.map(p => [
    protocolLabel(p.protocol), friendlySource(p.endpointName), pointName(p), originalName(p),
    valueText(p.value), p.unit || '', p.quality || '', p.timestamp, p.destinationName
  ])
  const header = ['Protocol','Source','Point','Original','Value','Unit','Quality','Timestamp','Destination']
  const csv = '\uFEFF' + [header, ...data].map(r => r.map(quote).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function exportViewCsv(view: SavedView) {
  const viewKeys = new Set(view.pointKeys.map(normalizePointKey))
  const viewPoints = points.value.filter(p => viewKeys.has(p.key))
  downloadCsv(viewPoints, `${view.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.csv`)
}
const badCount = computed(() => points.value.filter(p => p.quality === 'BAD').length)
const staleCount = computed(() => points.value.filter(p => isStale(p.timestamp)).length)
function sortOrderFor(key: string) { return tableSortField.value === key ? tableSortOrder.value : null }
const columns = computed<TableColumnType<PointRow>[]>(() => {
  const cols: TableColumnType<PointRow>[] = []
  cols.push(
    { title: 'Protocol', key: 'protocol', width: 105 },
    { title: 'Source', key: 'source', width: 180, ellipsis: true, sorter: true, sortOrder: sortOrderFor('source') },
    { title: 'Point', key: 'point', width: 320, ellipsis: true, sorter: true, sortOrder: sortOrderFor('point') },
    { title: 'Latest Value', key: 'value', width: 135, sorter: true, sortOrder: sortOrderFor('value') },
    { title: 'Unit', key: 'unit', width: 115, ellipsis: true },
    { title: 'Quality', key: 'quality', width: 105 },
    { title: 'Updated', key: 'updated', width: 110, sorter: true, sortOrder: sortOrderFor('updated') },
    { title: 'Destination', dataIndex: 'destinationName', key: 'destinationName', width: 150, ellipsis: true },
    { title: '', key: 'action', width: 120 },
  )
  return cols
})
const viewColumns: TableColumnType<SavedView>[] = [
  { title: 'Name', key: 'name', ellipsis: true },
  { title: 'Points', key: 'points', width: 80 },
  { title: 'Actions', key: 'actions', width: 200, fixed: 'right' },
]
const datasetColumns: TableColumnType<MlDataset>[] = [
  { title: 'Name', key: 'name', ellipsis: true },
  { title: 'Points', key: 'points', width: 80 },
  { title: 'Sampling', key: 'sampling', width: 100 },
  { title: 'Window', key: 'window', width: 100 },
  { title: 'Format', key: 'format', width: 90 },
  { title: 'Updated', key: 'updated', width: 110 },
  { title: 'Actions', key: 'actions', width: 130, fixed: 'right' },
]

function onTableChange(_pagination: unknown, _filters: unknown, sorter: { field?: string; columnKey?: string; order?: 'ascend' | 'descend' | null }) {
  if (!sorter || (!sorter.columnKey && !sorter.field)) return
  const key = sorter.columnKey as string || sorter.field as string || null
  tableSortField.value = sorter.order ? key : null
  tableSortOrder.value = sorter.order ?? null
}
async function loadDevices() {
  try {
    const { data } = await client.get<{ devices: DeviceRecord[] }>('/v1/devices')
    devices.value = data.devices || []
  } catch { /**\\*** friendly names are optional **\\***/ }
}
async function poll() {
  if (busy) return
  busy = true
  refreshing.value = true
  try {
    const [subs, evts, overview] = await Promise.all([pipelineApi.getSubscriptions(), pipelineApi.getEvents(1000), pipelineApi.getOverview()])
    subscriptions.value = subs
    events.value = evts
    observedPointCount.value = overview.activePoints
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
onMounted(async () => {
  try {
    const saved = JSON.parse(localStorage.getItem('iot-explorer-favorites') || '[]')
    if (Array.isArray(saved)) {
      favorites.value = saved.filter((v): v is string => typeof v === 'string' && v.includes('::') && !v.startsWith('['))
      if (favorites.value.length !== saved.length) persistFavorites()
    }
  } catch { /* ignore invalid preferences */ }
  try {
    const savedCache = JSON.parse(localStorage.getItem('iot-explorer-fav-cache') || '{}')
    for (const [k, v] of Object.entries(savedCache)) {
      if (favorites.value.includes(k) && v && typeof v === 'object') favPointCache.value.set(k, v as PointRow)
    }
  } catch { /* ignore invalid cache */ }
  loadDevices()
  loadDatasets()
  await loadViews()
  await poll()
  for (const p of points.value) {
    const fk = favKey(p)
    if (favorites.value.includes(fk)) favPointCache.value.set(fk, p)
  }
  persistFavorites()
  timer = setInterval(() => { now.value = Date.now(); if (!paused.value) poll() }, POLL_MS)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <AppLayout title="Data Explorer">
    <div class="explorer">

      <div class="heading">
        <p>Search, inspect and export the latest readings across your connected sources.</p>
      </div>
      <a-alert v-if="error"  type="warning" show-icon :message="error" style="margin-bottom: 14px" />
      <a-row :gutter="12" class="stats">
        <a-col :xs="12" :md="6"><a-card size="small" class="metric-card"><div class="metric-inner"><span class="metric-icon icon-points"><BarChartOutlined /></span><a-statistic title="Observed points" :value="observedPointCount" /></div></a-card></a-col>
        <a-col :xs="12" :md="6"><a-card size="small" class="metric-card"><div class="metric-inner"><span class="metric-icon icon-subscriptions"><WifiOutlined /></span><a-statistic title="Active subscriptions" :value="subscriptions.length" /></div></a-card></a-col>
        <a-col :xs="12" :md="6"><a-card size="small" class="metric-card"><div class="metric-inner"><span class="metric-icon icon-quality"><WarningOutlined /></span><a-statistic title="Bad quality" :value="badCount" /></div></a-card></a-col>
        <a-col :xs="12" :md="6"><a-card size="small" class="metric-card"><div class="metric-inner"><span class="metric-icon icon-stale"><ClockCircleOutlined /></span><a-statistic title="No update in 60s" :value="staleCount" /></div></a-card></a-col>
      </a-row>
      <a-card size="small" class="browser-card">
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
          <div class="filters-actions">
            <a-button @click="poll"><ReloadOutlined :spin="refreshing" /> Refresh</a-button>
            <a-button class="save-view-button" @click="openCreateView(false)"><SaveOutlined /> Save as View</a-button>
            <a-button type="primary" :disabled="!filteredPoints.length" @click="openCreateDataset()"><DatabaseOutlined /> Create Dataset</a-button>
          </div>
        </div>
        <div class="views-bar">
          <div class="views-list">
            <button type="button" :class="['view-tab', { active: activeTab === 'all' }]" @click="activateTab('all')">All points ({{ points.length }})</button>
            <button type="button" :class="['view-tab', { active: activeTab === 'favorites' }]" @click="activateTab('favorites')"> Favorites ({{ favoriteCount }})</button>
            <div v-for="view in savedViews.filter(v => openViewIds.includes(v.id))" :key="view.id" :class="['saved-view-tab', { active: activeTab === view.id }]">
              <button type="button" @click="activateTab(view.id)">{{ view.name }} ({{ new Set(view.pointKeys.map(normalizePointKey)).size }})</button>
              <button type="button" class="close-view" :aria-label="`Close ${view.name} tab`" @click="closeSavedView(view.id)"><CloseOutlined /></button>
            </div>
            <button type="button" :class="['view-tab', { active: activeTab === 'views' }]" @click="activateTab('views')">Views ({{ savedViews.length }})</button>
            <button type="button" :class="['view-tab', { active: activeTab === 'datasets' }]" @click="activateTab('datasets')">Datasets ({{ datasets.length }})</button>
          </div>
        </div>
        <a-alert v-if="viewError" type="warning" show-icon :message="viewError" style="margin-bottom: 10px" />
        <a-alert v-if="activeSavedView && missingViewCount" type="info" show-icon :message="`${missingViewCount} saved point(s) are not in the recent sample. They remain saved in this view.`" style="margin-bottom: 10px" />
        <div class="table-meta">
          <div>
            <a-button v-if="selectedPointKeys.length" size="small" @click="openCreateView(true)"><SaveOutlined /> Save selected ({{ selectedPointKeys.length }})</a-button>
          </div>
          <span class="toolbar-info">Showing {{ activeTab === 'datasets' ? datasets.length + ' datasets' : activeTab === 'views' ? savedViews.length + ' views' : filteredPoints.length + ' points' }}<template v-if="lastSync"> · Last sync {{ lastSync }}</template></span>
        </div>

        <!-- Views tab content -->
        <template v-if="activeTab === 'views'">
          <a-table :columns="viewColumns" :data-source="savedViews" :loading="viewsLoading" row-key="id" size="small" :pagination="{ pageSize: 20, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'] }">
            <template #bodyCell="{ column, record: view }">
              <template v-if="column.key === 'name'">
                <div class="point-primary">{{ view.name }}</div>
                <div v-if="view.description" class="point-secondary">{{ view.description }}</div>
              </template>
              <template v-else-if="column.key === 'points'">{{ new Set(view.pointKeys.map(normalizePointKey)).size }}</template>
              <template v-else-if="column.key === 'actions'">
                <a-space>
                  <a-tooltip title="Open"><a-button size="small" @click="openSavedView(view.id); activeTab = view.id"><template #icon><BarChartOutlined /></template></a-button></a-tooltip>
                  <a-tooltip title="Export CSV"><a-button size="small" @click="exportViewCsv(view)"><template #icon><DownloadOutlined /></template></a-button></a-tooltip>
                  <a-tooltip title="Edit"><a-button size="small" @click="openEditView(view)"><template #icon><EditOutlined /></template></a-button></a-tooltip>
                  <a-popconfirm title="Delete this saved view permanently?" ok-text="Delete" @confirm="deleteSavedView(view.id)"><a-button size="small" danger><template #icon><DeleteOutlined /></template></a-button></a-popconfirm>
                </a-space>
              </template>
            </template>
            <template #emptyText>No saved views yet — filter points and click Save as View.</template>
          </a-table>
        </template>

        <!-- Datasets tab content -->
        <template v-else-if="activeTab === 'datasets'">
          <a-table :columns="datasetColumns" :data-source="datasets" :loading="datasetsLoading" row-key="id" size="small" :pagination="{ pageSize: 20, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'] }">
            <template #bodyCell="{ column, record: ds }">
              <template v-if="column.key === 'name'">
                <div class="point-primary">{{ ds.name }}</div>
                <div v-if="ds.description" class="point-secondary">{{ ds.description }}</div>
              </template>
              <template v-else-if="column.key === 'points'">{{ ds.pointKeys.length }}</template>
              <template v-else-if="column.key === 'sampling'">{{ formatInterval(ds.samplingIntervalSecs) }}</template>
              <template v-else-if="column.key === 'window'">{{ formatInterval(ds.windowSecs) }}</template>
              <template v-else-if="column.key === 'format'"><a-tag>{{ ds.outputFormat }}</a-tag></template>
              <template v-else-if="column.key === 'updated'"><span class="age">{{ age(ds.updatedAt) }}</span></template>
              <template v-else-if="column.key === 'actions'">
                <a-space>
                  <a-tooltip title="Edit"><a-button size="small" @click="openEditDataset(ds)"><template #icon><EditOutlined /></template></a-button></a-tooltip>
                  <a-tooltip title="Duplicate"><a-button size="small" @click="duplicateDataset(ds)"><template #icon><CopyOutlined /></template></a-button></a-tooltip>
                  <a-tooltip title="Delete"><a-button size="small" danger @click="deleteDataset(ds.id)"><template #icon><DeleteOutlined /></template></a-button></a-tooltip>
                </a-space>
              </template>
            </template>
            <template #emptyText>No datasets yet — select points and click Create Dataset.</template>
          </a-table>
        </template>

        <!-- Points table -->
        <a-table v-else :columns="columns" :data-source="filteredPoints" :loading="loading" row-key="key" :row-selection="rowSelection" size="small" :pagination="{ pageSize, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'], onShowSizeChange: (_: number, size: number) => { pageSize = size } }" :scroll="{ x: 1390 }" table-layout="fixed" @change="onTableChange">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'protocol'"><a-tag :color="protocolColor(record.protocol)">{{ protocolLabel(record.protocol) }}</a-tag></template>
            <template v-else-if="column.key === 'source'">{{ friendlySource(record.endpointName) }}</template>
            <template v-else-if="column.key === 'point'"><div class="point-primary" :title="pointName(record)">{{ pointName(record) }}</div><div v-if="record.normalizedName" class="point-secondary" :title="originalName(record)">Original: {{ originalName(record) }}</div></template>
            <template v-else-if="column.key === 'value'"><a-tag v-if="record.quality === 'BAD' && record.value == null" color="red">No Value</a-tag><span v-else>{{ valueText(record.value) }}</span></template>
            <template v-else-if="column.key === 'unit'">{{ record.unit || '—' }}</template>
            <template v-else-if="column.key === 'quality'"><a-tag v-if="record.quality === 'BAD'" color="red">BAD</a-tag><a-tag v-else-if="isStale(record.timestamp)" color="orange">STALE</a-tag><a-tag v-else color="green">{{ record.quality || 'CURRENT' }}</a-tag></template>
            <template v-else-if="column.key === 'updated'"><span :class="isStale(record.timestamp) ? 'age stale' : 'age'"><i class="status-dot"></i>{{ age(record.timestamp) }}</span></template>
            <template v-else-if="column.key === 'action'"><a-button type="text" size="small" @click="toggleFavorite(favKey(record))"><span :class="favorites.includes(favKey(record)) ? 'star active' : 'star'">{{ favorites.includes(favKey(record)) ? '★' : '☆' }}</span></a-button><a-button type="link" size="small" @click="inspect(record)">Inspect</a-button></template>
          </template>
          <template #emptyText>No matching recent readings. Check your source, subscription, and destination configuration.</template>
        </a-table>
      </a-card>
      <p class="note">This view uses the latest 100 activity events plus subscription snapshots. It is not a complete point inventory or historical archive. “Stale” means no observed update for 60 seconds, not necessarily a device failure.</p>
    </div>
    <CreateViewDrawer
      v-model:open="viewDrawerOpen"
      :point-rows="selectedPointKeys.length ? candidateViewPoints : filteredPoints"
      :editing-view="editingView"
      @saved="onViewSaved"
    />
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
    <CreateDatasetDrawer
      v-model:open="datasetDrawerOpen"
      :point-rows="candidateDatasetPoints"
      :editing-dataset="editingDataset"
      @saved="onDatasetSaved"
    />
  </AppLayout>
</template>

<style scoped>
.explorer { padding: 2px 0 24px; }
.metric-inner { display: flex; align-items: center; gap: 15px; min-height: 66px; }
.metric-icon { width: 50px; height: 50px; flex-shrink: 0; border-radius: 14px; display: inline-flex; align-items: center; justify-content: center; font-size: 23px; }
.icon-points, .icon-subscriptions, .icon-stale { background: #edf4ff; color: #1677ff; }
.icon-quality { background: #fff1f2; color: #f04452; }
.metric-card :deep(.ant-statistic-title) { color: #8390a3; }
.metric-card :deep(.ant-statistic-content) { font-size: 23px; }
.save-view-button { color: #1677ff; border-color: #1677ff; }
.views-bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; border-bottom: 1px solid #edf0f5; margin: 8px 0 12px; }
.views-list { display: flex; align-items: stretch; gap: 4px; overflow-x: auto; min-width: 0; }
.view-tab, .saved-view-tab { background: transparent; color: #334155; border: 0; border-bottom: 2px solid transparent; padding: 10px 12px; font: inherit; white-space: nowrap; cursor: pointer; }
.view-tab.active, .saved-view-tab.active { color: #1677ff; border-bottom-color: #1677ff; }
.saved-view-tab { display: flex; gap: 10px; align-items: center; }
.saved-view-tab button { color: inherit; background: none; border: 0; cursor: pointer; padding: 0; font: inherit; }
.saved-view-tab .close-view { color: #8895a7; }
.table-meta { display: flex; justify-content: space-between; align-items: center; min-height: 28px; margin-bottom: 10px; gap: 8px; }
@media (max-width: 850px) { .views-bar { align-items: flex-start; flex-direction: column; } .metric-inner { gap: 8px; } .metric-icon { width: 38px; height: 38px; } }

.eyebrow { font-size: 10px; letter-spacing: 1.3px; font-weight: 700; color: #8a95a5; margin-bottom: 7px; }
.header-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.browser-heading { display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; }
.browser-heading h3 { font-size: 15px; margin: 0 0 3px; font-weight: 650; }
.browser-heading span { color: #8b94a3; font-size: 11px; }
.browser-count { background: #f1f5fb; border-radius: 20px; padding: 5px 12px; }
.star { font-size: 21px; color: #a5afbb; }
.star.active { color: #e2a42c; }
.age { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
.status-dot { width: 7px; height: 7px; border-radius: 50%; background: #3cb77d; display: inline-block; }
.age.stale .status-dot { background: #ed9a38; }
.stats :deep(.ant-card) { border-radius: 9px; border-color: #e7ebf0; background: #fafafa; }
.stats :deep(.ant-card-body) { padding: 17px 18px; }
.browser-card { border-radius: 9px; }
.browser-card :deep(.ant-table-thead > tr > th) { background: #f7f9fc; font-size: 12px; font-weight: 650; }
.browser-card :deep(.ant-table-tbody > tr:hover > td) { background: #f5f9ff; }
@media (max-width: 900px) { .heading { align-items: flex-start; flex-direction: column; } }
.heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
.heading p { color: #777; margin: 0; }
.stats { margin-bottom: 14px; }
.filters { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
.search { width: 240px; flex-shrink: 0; }
.filter { width: 160px; flex-shrink: 0; }
.filter :deep(.ant-select) { width: 100% !important; }
.filters-actions { display: flex; gap: 8px; margin-left: auto; flex-shrink: 0; }
.toolbar-info { color: #888; font-size: 12px; }
.note { color: #888; font-size: 12px; margin-top: 12px; }
.point-primary { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.point-secondary { color: #777; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

</style>
