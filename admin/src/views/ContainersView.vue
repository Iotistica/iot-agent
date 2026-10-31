<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { message, Modal } from 'ant-design-vue'
import {
  PlusOutlined,
  ReloadOutlined,
  PlayCircleOutlined,
  PoweroffOutlined,
  DeleteOutlined,
  EditOutlined,
  AppstoreOutlined,
  FileTextOutlined,
  ShopOutlined,
  EllipsisOutlined,
  DownOutlined,
  UpOutlined,
  EyeOutlined,
  CloseOutlined,
  SwapOutlined,
  CopyOutlined,
  CheckOutlined,
} from '@ant-design/icons-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import { containersApi, templatesApi } from '@/api/containers'
import type { ContainerApp, ContainerService, MarketplaceImage } from '@/api/containers'
import MarketplaceCatalog from '@/components/MarketplaceCatalog.vue'
import { useDockerStatus } from '@/composables/useDockerStatus'
import { useSystemStats } from '@/composables/useSystemStats'

const { dockerAvailable } = useDockerStatus()
const { sysStats, cpuSamples, lastUpdatedAt, appMetrics, storageSegments, statsLoading, startPolling, stopPolling, pollNow, fmtMb } = useSystemStats()
const route = useRoute()
const router = useRouter()

// ── State ─────────────────────────────────────────────────────────────────────

const apps = ref<ContainerApp[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const actionInFlight = ref<Record<string, boolean>>({})
const searchQuery = ref('')
const collapsedApps = ref(new Set<number>())
let refreshRequested = false

// ── Auto-refresh ──────────────────────────────────────────────────────────────

let refreshTimer: ReturnType<typeof setInterval> | null = null

function startRefresh() {
  refreshTimer = setInterval(load, 5000)
}
function stopRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
}

onMounted(async () => {
  await Promise.all([load(), pollNow()])
  startRefresh()
  startPolling()
  loadMarketplaceImages()
  const templateId = route.query.template
  if (typeof templateId === 'string') {
    await router.replace({ path: '/applications', query: { ...route.query, template: undefined } })
    try {
      deployTemplate(await templatesApi.get(templateId))
    } catch (e: unknown) {
      message.error((e as any)?.response?.data?.error ?? (e as any)?.message ?? 'Marketplace entry not found')
    }
  }
})
onUnmounted(() => { stopRefresh(); stopPolling(); if (logEs) { logEs.close(); logEs = null } })

// ── Load ──────────────────────────────────────────────────────────────────────

async function load() {
  if (loading.value) {
    refreshRequested = true
    return
  }
  loading.value = true
  error.value = null
  try {
    apps.value = await containersApi.getAll()
  } catch (e: unknown) {
    error.value = (e as any)?.message ?? 'Failed to load containers'
  } finally {
    loading.value = false
    if (refreshRequested) {
      refreshRequested = false
      void load()
    }
  }
}

// ── System performance (via composable — persists across navigations) ────────

const cpuTopCount = ref(3)
const storageTopCount = ref(3)
const cpuCurrent = computed(() => {
  const value = sysStats.value?.cpu_usage
  return typeof value === 'number' && Number.isFinite(value) ? value : null
})
const cpuPeak = computed(() => cpuSamples.value.length
  ? Math.max(...cpuSamples.value.map(sample => sample.value))
  : null)
const cpuChartPoints = computed(() => cpuSamples.value.map((sample, index) => ({
  ...sample,
  x: cpuSamples.value.length > 1 ? (index / (cpuSamples.value.length - 1)) * 300 : 150,
  y: 5 + ((100 - Math.max(0, Math.min(100, sample.value))) / 100) * 80,
})))
const cpuChartLine = computed(() => cpuChartPoints.value.reduce((path, point, index, points) => {
  if (index === 0) return `M${point.x.toFixed(1)},${point.y.toFixed(1)}`
  const previous = points[index - 1]
  const third = (point.x - previous.x) / 3
  return `${path} C${(previous.x + third).toFixed(1)},${previous.y.toFixed(1)} ${(point.x - third).toFixed(1)},${point.y.toFixed(1)} ${point.x.toFixed(1)},${point.y.toFixed(1)}`
}, ''))
const cpuChartArea = computed(() => cpuChartLine.value
  ? `${cpuChartLine.value} L300,90 L0,90 Z`
  : '')
const cpuTimeLabel = (timestamp: number) => new Date(timestamp).toLocaleTimeString([], {
  hour: '2-digit',
  minute: '2-digit',
})
const lastUpdatedLabel = computed(() => lastUpdatedAt.value
  ? new Date(lastUpdatedAt.value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  : '')

const storageChart = computed(() => {
  const stats = sysStats.value
  const used = stats?.storage_used
  const total = stats?.storage_total
  if (typeof used !== 'number' || typeof total !== 'number'
    || !Number.isFinite(used) || !Number.isFinite(total)
    || total <= 0 || used < 0 || used > total) return null

  const disk = stats?.docker_disk
  const breakdown = disk
    && Number.isFinite(disk.images) && disk.images >= 0
    && Number.isFinite(disk.volumes) && disk.volumes >= 0
    && disk.images + disk.volumes <= used
    ? disk
    : null
  const categories = breakdown
    ? [
      { name: 'Images', value: breakdown.images, color: '#1677ff' },
      { name: 'Volumes', value: breakdown.volumes, color: '#722ed1' },
      { name: 'Other used', value: used - breakdown.images - breakdown.volumes, color: '#9254de' },
      { name: 'Free space', value: total - used, color: '#454b55' },
    ]
    : [
      { name: 'Used', value: used, color: '#1677ff' },
      { name: 'Free space', value: total - used, color: '#454b55' },
    ]

  return { used, total, percent: (used / total) * 100, categories }
})
const storageDonutStyle = computed(() => {
  const chart = storageChart.value
  if (!chart) return {}
  let offset = 0
  const stops = chart.categories.map(category => {
    const start = offset
    offset += (category.value / chart.total) * 100
    return `${category.color} ${start}% ${offset}%`
  })
  return { background: `conic-gradient(${stops.join(', ')})` }
})
const topCpuConsumers = computed(() => [...appMetrics.value]
  .filter(app => Number.isFinite(app.cpu_percent) && app.cpu_percent >= 0)
  .sort((a, b) => b.cpu_percent - a.cpu_percent)
  .slice(0, cpuTopCount.value))
const topCpuScale = computed(() => Math.max(...topCpuConsumers.value.map(app => app.cpu_percent), 0))
const topStorageConsumers = computed(() => [...storageSegments.value]
  .filter(app => Number.isFinite(app.size) && app.size >= 0)
  .sort((a, b) => b.size - a.size)
  .slice(0, storageTopCount.value))
const topStorageScale = computed(() => Math.max(...topStorageConsumers.value.map(app => app.size), 0))
function barWidth(value: number, scale: number) {
  return scale > 0 ? `${(value / scale) * 100}%` : '0%'
}

const purging = ref(false)
function confirmPurge() {
  Modal.confirm({
    title: 'Purge unused Docker data?',
    content: 'This removes all Docker images not used by a container and unused volumes. This cannot be undone.',
    okText: 'Purge',
    okType: 'danger',
    async onOk() {
      purging.value = true
      try {
        const r = await containersApi.purgeUnused()
        message.success(`Purged ${r.images_deleted} images and ${r.volumes_deleted} volumes (${fmtMb(r.space_reclaimed)} freed)`)
        await pollNow()
      } catch (e) {
        message.error((e as any)?.message ?? 'Purge failed')
      } finally {
        purging.value = false
      }
    },
  })
}

// ── Status helpers ─────────────────────────────────────────────────────────────

type RunState = 'running' | 'stopped' | 'error' | 'creating' | 'unknown'

function resolveState(svc: ContainerService): RunState {
  if (svc.serviceStatus === 'error') return 'error'
  const rawStatus = typeof svc.status === 'string'
    ? svc.status
    : (svc.status as any)?.state
  const s = svc.state ?? rawStatus ?? svc.serviceStatus
  if (s === 'running') return 'running'
  if (s === 'stopped' || s === 'exited') return 'stopped'
  if (s === 'error') return 'error'
  if (s === 'creating' || s === 'pending') return 'creating'
  return 'unknown'
}

const STATUS_COLOR: Record<RunState, string> = {
  running: 'success',
  stopped: 'default',
  error: 'error',
  creating: 'processing',
  unknown: 'warning',
}

const STATUS_LABEL: Record<RunState, string> = {
  running: 'Running',
  stopped: 'Stopped',
  error: 'Error',
  creating: 'Creating',
  unknown: '—',
}

function summaryForApp(app: ContainerApp) {
  const total = app.services.length
  const running = app.services.filter(s => resolveState(s) === 'running').length
  return { total, running }
}

const filteredApps = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return apps.value
  return apps.value.flatMap(app => {
    const matchesApp = app.appName.toLowerCase().includes(query)
    const services = matchesApp
      ? app.services
      : app.services.filter(svc =>
        [svc.serviceName, svc.imageName, ...(svc.config.ports ?? [])]
          .some(value => value.toLowerCase().includes(query)),
      )
    return matchesApp || services.length
      ? [{ ...app, services }]
      : []
  })
})

const totalRunning = computed(() =>
  apps.value.reduce((n, a) => n + a.services.filter(s => resolveState(s) === 'running').length, 0),
)
const totalServices = computed(() =>
  apps.value.reduce((n, a) => n + a.services.length, 0),
)
const totalStopped = computed(() =>
  apps.value.reduce((n, a) => n + a.services.filter(s => resolveState(s) === 'stopped').length, 0),
)

// ── Service actions ───────────────────────────────────────────────────────────

function actionKey(appId: number, serviceName: string, action: string) {
  return `${appId}:${serviceName}:${action}`
}

async function doAction(app: ContainerApp, svc: ContainerService, action: 'start' | 'stop' | 'restart') {
  if (isServiceBusy(app.appId, svc.serviceName)) return
  const key = actionKey(app.appId, svc.serviceName, action)
  actionInFlight.value = { ...actionInFlight.value, [key]: true }
  try {
    await containersApi.serviceAction(app.appId, svc.serviceName, action)
    message.success(`${svc.serviceName} ${action}ed`)
    await load()
  } catch (e: unknown) {
    message.error((e as any)?.message ?? `${action} failed`)
  } finally {
    const next = { ...actionInFlight.value }
    delete next[key]
    actionInFlight.value = next
  }
}

function isInFlight(appId: number, serviceName: string, action: string) {
  return !!actionInFlight.value[actionKey(appId, serviceName, action)]
}

function isServiceBusy(appId: number, serviceName: string) {
  return (['start', 'stop', 'restart'] as const)
    .some(action => isInFlight(appId, serviceName, action))
}

function toggleApp(appId: number) {
  const next = new Set(collapsedApps.value)
  if (next.has(appId)) next.delete(appId)
  else next.add(appId)
  collapsedApps.value = next
}



function handleServiceMenu(key: string, app: ContainerApp, svc: ContainerService) {
  if (key === 'details') openServiceDetails(app, svc)
  if (key === 'edit') openEditService(app, svc)
  if (key === 'restart') void doAction(app, svc, 'restart')
  if (key === 'delete') confirmRemoveService(app, svc)
}

function handleServiceMenuClick(event: { key: string | number }, app: ContainerApp, svc: ContainerService) {
  handleServiceMenu(String(event.key), app, svc)
}

function fullApp(app: ContainerApp) {
  return apps.value.find(item => item.appId === app.appId) ?? app
}

function portUrl(port: string): string | null {
  const parts = port.split(':')
  const hostPort = parts.length > 1 ? parts[parts.length - 2].split('/')[0] : ''
  if (!/^\d+$/.test(hostPort) || Number(hostPort) < 1 || Number(hostPort) > 65535) return null
  const hostname = window.location.hostname
  const host = hostname.includes(':') ? `[${hostname}]` : hostname
  return `http://${host}:${hostPort}`
}

function maskedEnvironmentValue(name: string, value: string) {
  return /password|passwd|pwd|secret|token|(?:^|[_-])key(?:$|[_-])|api.?key|credential|private|auth/i.test(name)
    ? '••••••••'
    : value
}

const serviceDetailsOpen = ref(false)
const serviceDetailsApp = ref<ContainerApp | null>(null)
const serviceDetailsService = ref<ContainerService | null>(null)
const currentServiceDetailsApp = computed(() =>
  apps.value.find(app => app.appId === serviceDetailsApp.value?.appId) ?? serviceDetailsApp.value,
)
const currentServiceDetailsService = computed(() => {
  const selected = serviceDetailsService.value
  if (!selected) return null
  return currentServiceDetailsApp.value?.services.find(svc =>
    svc.serviceId === selected.serviceId || svc.serviceName === selected.serviceName,
  ) ?? selected
})

function openServiceDetails(app: ContainerApp, svc: ContainerService) {
  serviceDetailsApp.value = app
  serviceDetailsService.value = svc
  serviceDetailsOpen.value = true
}

// ── App details drawer ───────────────────────────────────────────────────────

const appDetailsOpen = ref(false)
const appDetailsTarget = ref<ContainerApp | null>(null)
const appDetailsName = ref('')
const appDetailsSaving = ref(false)

function openAppDetails(app: ContainerApp) {
  appDetailsTarget.value = app
  appDetailsName.value = app.appName
  appDetailsOpen.value = true
}

async function saveAppDetails() {
  const app = appDetailsTarget.value
  if (!app) return
  const name = appDetailsName.value.trim()
  if (!name) { message.error('Application name is required'); return }
  appDetailsSaving.value = true
  try {
    if (name !== app.appName) {
      await containersApi.renameApp(app.appId, name)
    }
    message.success('Application updated')
    appDetailsOpen.value = false
    await load()
  } catch (e: unknown) {
    message.error((e as any)?.message ?? 'Update failed')
  } finally {
    appDetailsSaving.value = false
  }
}

// ── Remove app ────────────────────────────────────────────────────────────────

function confirmRemoveApp(app: ContainerApp) {
  Modal.confirm({
    title: `Delete "${app.appName}"?`,
    content: 'All services in this application will be stopped and removed.',
    okType: 'danger',
    okText: 'Delete',
    async onOk() {
      try {
        await containersApi.remove(app.appId)
        message.success(`${app.appName} deleted`)
        appDetailsOpen.value = false
        await load()
      } catch (e: unknown) {
        message.error((e as any)?.message ?? 'Delete failed')
      }
    },
  })
}

function confirmRemoveService(app: ContainerApp, svc: ContainerService) {
  Modal.confirm({
    title: `Remove "${svc.serviceName}"?`,
    content: 'The service container will be stopped and removed.',
    okType: 'danger',
    okText: 'Remove',
    async onOk() {
      try {
        await containersApi.removeService(app.appId, svc.serviceName)
        message.success(`${svc.serviceName} removed`)
        await load()
      } catch (e: unknown) {
        message.error((e as any)?.message ?? 'Remove failed')
      }
    },
  })
}

// ── Add Service drawer ────────────────────────────────────────────────────────

const addSvcDrawerOpen = ref(false)
const addSvcTargetApp = ref<ContainerApp | null>(null)
const addSvcForm = ref<ServiceForm>(emptyService())
const addSvcSaving = ref(false)
const marketplaceImages = ref<MarketplaceImage[]>([])
const addSvcSelectedImage = ref<string | null>(null)

async function loadMarketplaceImages() {
  try {
    const result = await templatesApi.getAll()
    marketplaceImages.value = result.templates
  } catch { /* non-fatal */ }
}

function onImageSelected(imageId: string) {
  const img = marketplaceImages.value.find(i => i.id === imageId)
  if (!img) return
  addSvcForm.value = imageToServiceForm(img)
}

function openAddService(app: ContainerApp) {
  addSvcTargetApp.value = app
  addSvcForm.value = emptyService()
  addSvcSelectedImage.value = null
  addSvcDrawerOpen.value = true
  if (marketplaceImages.value.length === 0) loadMarketplaceImages()
}

function filterImageOption(input: string, option: any) {
  const img = marketplaceImages.value.find(i => i.id === option.value)
  if (!img) return false
  const q = input.toLowerCase()
  return img.name.toLowerCase().includes(q) ||
    img.category.toLowerCase().includes(q) ||
    img.image.toLowerCase().includes(q)
}

async function submitAddService() {
  const app = addSvcTargetApp.value
  if (!app) return
  if (!addSvcSelectedImage.value) { message.error('Please select an image from the marketplace'); return }
  if (!addSvcForm.value.serviceName.trim()) { message.error('Service name is required'); return }
  if (!addSvcForm.value.image.trim()) { message.error('Docker image is required'); return }

  const ports = cleanPorts(addSvcForm.value.ports)
  const volumes = parseLines(addSvcForm.value.volumes)
  const environment = rowsToEnv(addSvcForm.value.envRows)

  addSvcSaving.value = true
  try {
    await containersApi.addService(app.appId, {
      serviceName: addSvcForm.value.serviceName.trim(),
      imageName: addSvcForm.value.image.trim(),
      state: 'running',
      config: {
        image: addSvcForm.value.image.trim(),
        ...(ports.length ? { ports } : {}),
        ...(environment && Object.keys(environment).length ? { environment } : {}),
        ...(volumes.length ? { volumes } : {}),
        restart: addSvcForm.value.restart || undefined,
        ...buildAdvancedConfig(addSvcForm.value),
      },
    })
    message.success(`Service added to ${app.appName}`)
    addSvcDrawerOpen.value = false
    await load()
  } catch (e: unknown) {
    message.error((e as any)?.message ?? 'Failed to add service')
  } finally {
    addSvcSaving.value = false
  }
}

// ── Edit Service drawer ───────────────────────────────────────────────────────

const editSvcDrawerOpen = ref(false)
const editSvcTargetApp = ref<ContainerApp | null>(null)
const editSvcTargetSvc = ref<ContainerService | null>(null)
const editSvcForm = ref<ServiceForm>(emptyService())
const editSvcSaving = ref(false)

function openEditService(app: ContainerApp, svc: ContainerService) {
  editSvcTargetApp.value = app
  editSvcTargetSvc.value = svc
  const c = svc.config
  const probe = c.livenessProbe
  editSvcForm.value = {
    serviceName: svc.serviceName,
    image: svc.imageName,
    ports: portsToRows(c.ports),
    envRows: envToRows(c.environment),
    volumes: formatLines(c.volumes),
    restart: c.restart ?? '',
    networkMode: c.networkMode ?? 'bridge',
    command: (c.command ?? []).join(' '),
    entrypoint: (c.entrypoint ?? []).join(' '),
    user: c.user ?? '',
    cpuLimit: c.resources?.limits?.cpu ?? '',
    memoryLimit: c.resources?.limits?.memory ?? '',
    enableSocketDestination: c.enableSocketDestination ?? false,
    readonlyRootfs: c.readonlyRootfs ?? false,
    healthcheckType: probe?.type ?? 'none',
    healthcheckPath: probe?.path ?? '',
    healthcheckPort: probe?.port,
    healthcheckCommand: (probe?.command ?? []).join(' '),
    healthcheckInterval: probe?.periodSeconds ?? 30,
    healthcheckTimeout: probe?.timeoutSeconds ?? 5,
    healthcheckRetries: probe?.failureThreshold ?? 3,
  }
  editSvcDrawerOpen.value = true
}

async function submitEditService() {
  const app = editSvcTargetApp.value
  const original = editSvcTargetSvc.value
  if (!app || !original) return
  if (!editSvcForm.value.image.trim()) { message.error('Docker image is required'); return }

  const ports = cleanPorts(editSvcForm.value.ports)
  const volumes = parseLines(editSvcForm.value.volumes)
  const environment = rowsToEnv(editSvcForm.value.envRows)

  editSvcSaving.value = true
  try {
    await containersApi.updateService(app.appId, original.serviceName, {
      serviceName: editSvcForm.value.serviceName.trim() || original.serviceName,
      imageName: editSvcForm.value.image.trim(),
      config: {
        image: editSvcForm.value.image.trim(),
        ...(ports.length ? { ports } : {}),
        ...(environment && Object.keys(environment).length ? { environment } : {}),
        ...(volumes.length ? { volumes } : {}),
        restart: editSvcForm.value.restart || undefined,
        ...buildAdvancedConfig(editSvcForm.value),
      },
    })
    message.success(`${original.serviceName} updated`)
    editSvcDrawerOpen.value = false
    await load()
  } catch (e: unknown) {
    message.error((e as any)?.message ?? 'Failed to update service')
  } finally {
    editSvcSaving.value = false
  }
}

// ── Log viewer ───────────────────────────────────────────────────────────────

interface LogLine { msg: string; stream: 'stdout' | 'stderr'; ts: string }

const logDrawerOpen = ref(false)
const logApp = ref<ContainerApp | null>(null)
const logSvc = ref<ContainerService | null>(null)
const logLines = ref<LogLine[]>([])
const logFollow = ref(true)
const logAutoScroll = ref(true)
const logOutputEl = ref<HTMLDivElement | null>(null)
let logEs: EventSource | null = null

const LOG_API_BASE = (import.meta.env.VITE_API_BASE_URL as string) || ''
const MAX_LOG_LINES = 1000

const logSearchOpen = ref(false)
const logSearchQuery = ref('')
const logSearchIndex = ref(-1)
const logCopied = ref(false)

async function copyContainerLogs() {
  if (logLines.value.length === 0) return
  const text = logLines.value.map(line => `${line.ts ? `${line.ts} ` : ''}${line.msg}`).join('\n')
  await navigator.clipboard.writeText(text)
  logCopied.value = true
  setTimeout(() => { logCopied.value = false }, 2000)
}

const logSearchMatches = computed(() => {
  const q = logSearchQuery.value.toLowerCase()
  if (!q) return [] as { line: number; start: number }[]
  const hits: { line: number; start: number }[] = []
  logLines.value.forEach((line, i) => {
    const msg = line.msg.toLowerCase()
    let pos = msg.indexOf(q)
    while (pos !== -1) {
      hits.push({ line: i, start: pos })
      pos = msg.indexOf(q, pos + q.length)
    }
  })
  return hits
})

const logSearchFirstIndex = computed(() => {
  const first = new Map<number, number>()
  logSearchMatches.value.forEach((m, idx) => {
    if (!first.has(m.line)) first.set(m.line, idx)
  })
  return first
})

function logSegments(line: LogLine, i: number) {
  const first = logSearchFirstIndex.value.get(i)
  if (!logSearchQuery.value || first === undefined) return [{ text: line.msg, hit: false, current: false }]
  const len = logSearchQuery.value.length
  const segs: { text: string; hit: boolean; current: boolean }[] = []
  let cursor = 0
  const matches = logSearchMatches.value
  for (let k = first; k < matches.length && matches[k].line === i; k++) {
    const { start } = matches[k]
    if (start > cursor) segs.push({ text: line.msg.slice(cursor, start), hit: false, current: false })
    segs.push({ text: line.msg.slice(start, start + len), hit: true, current: k === logSearchIndex.value })
    cursor = start + len
  }
  if (cursor < line.msg.length) segs.push({ text: line.msg.slice(cursor), hit: false, current: false })
  return segs
}

function openLogSearch() {
  logSearchOpen.value = true
  logSearchIndex.value = -1
  nextTick(() => {
    const el = document.querySelector('.log-search-input input') as HTMLInputElement | null
    el?.focus()
  })
}

function closeLogSearch() {
  logSearchOpen.value = false
  logSearchQuery.value = ''
  logSearchIndex.value = -1
}

function scrollToLogMatch(idx: number) {
  const matches = logSearchMatches.value
  if (!matches.length) return
  logSearchIndex.value = idx
  nextTick(() => {
    const el = logOutputEl.value?.querySelector('.log-msg mark.search-current') as HTMLElement | null
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })
}

function logSearchNext() {
  const matches = logSearchMatches.value
  if (!matches.length) return
  scrollToLogMatch(logSearchIndex.value < matches.length - 1 ? logSearchIndex.value + 1 : 0)
}

function logSearchPrev() {
  const matches = logSearchMatches.value
  if (!matches.length) return
  scrollToLogMatch(logSearchIndex.value > 0 ? logSearchIndex.value - 1 : matches.length - 1)
}

watch(logSearchQuery, () => {
  logSearchIndex.value = logSearchMatches.value.length > 0 ? 0 : -1
  if (logSearchIndex.value >= 0) nextTick(() => scrollToLogMatch(0))
})

function parseLogLine(raw: string, stream: 'stdout' | 'stderr'): LogLine {
  const m = raw.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z) (.*)$/)
  if (m) {
    const ts = m[1].slice(0, 23).replace('T', ' ')
    return { msg: m[2], stream, ts }
  }
  return { msg: raw, stream, ts: '' }
}

function connectLogs(appId: number, serviceName: string) {
  if (logEs) { logEs.close(); logEs = null }
  const url = `${LOG_API_BASE}/v1/apps/${appId}/services/${encodeURIComponent(serviceName)}/logs?tail=200&follow=${logFollow.value}&timestamps=true`
  const es = new EventSource(url)
  logEs = es
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data)
      if (data.error) {
        logLines.value.push({ msg: `[error] ${data.error}`, stream: 'stderr', ts: '' })
        return
      }
      if (!data.msg) return
      const line = parseLogLine(data.msg, data.stream ?? 'stdout')
      logLines.value.push(line)
      if (logLines.value.length > MAX_LOG_LINES) logLines.value.splice(0, logLines.value.length - MAX_LOG_LINES)
    } catch {}
  }
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) logEs = null
  }
}

function openLogs(app: ContainerApp, svc: ContainerService) {
  logApp.value = app
  logSvc.value = svc
  logLines.value = []
  logFollow.value = true
  logAutoScroll.value = true
  logCopied.value = false
  logSearchOpen.value = false
  logSearchQuery.value = ''
  logSearchIndex.value = -1
  logDrawerOpen.value = true
  connectLogs(app.appId, svc.serviceName)
}

function openAppLogs(app: ContainerApp) {
  const targetApp = fullApp(app)
  const firstService = targetApp.services[0]
  if (firstService) openLogs(targetApp, firstService)
}

function onLogDrawerClose() {
  if (logEs) { logEs.close(); logEs = null }
}

function toggleFollow() {
  if (!logApp.value || !logSvc.value) return
  connectLogs(logApp.value.appId, logSvc.value.serviceName)
}

function switchService(serviceName: string) {
  if (!logApp.value) return
  const svc = logApp.value.services.find(s => s.serviceName === serviceName)
  if (!svc || svc.serviceName === logSvc.value?.serviceName) return
  logSvc.value = svc
  logLines.value = []
  logSearchQuery.value = ''
  logSearchIndex.value = -1
  connectLogs(logApp.value.appId, svc.serviceName)
}

watch(logLines, () => {
  if (logAutoScroll.value) nextTick(() => {
    if (logOutputEl.value) logOutputEl.value.scrollTop = logOutputEl.value.scrollHeight
  })
}, { deep: false })

// ── Marketplace modal ─────────────────────────────────────────────────────────

const marketOpen = ref(false)
function openMarketplace() {
  marketOpen.value = true
}

// ── Deploy target picker (marketplace) ───────────────────────────────────────

const deployTargetOpen = ref(false)
const deployTargetTpl = ref<MarketplaceImage | null>(null)
const deployTargetMode = ref<'new' | 'existing'>('new')
const deployTargetAppId = ref<number | null>(null)
const deployTargetBusy = ref(false)

function imageToServiceForm(img: MarketplaceImage): ServiceForm {
  return {
    ...emptyService(),
    serviceName: img.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    image: img.image,
    ports: portsToRows(img.ports),
    volumes: (img.volumes ?? []).join('\n'),
    envRows: envToRows(img.environment),
    restart: img.restart ?? 'unless-stopped',
    networkMode: img.networkMode ?? 'bridge',
    command: img.command ?? '',
    entrypoint: img.entrypoint ?? '',
    user: img.user ?? '',
    enableSocketDestination: img.enableSocketDestination ?? false,
  }
}

function deployTemplate(tpl: MarketplaceImage) {
  if (apps.value.length === 0) {
    deployTemplateAsNewApp(tpl)
    return
  }
  deployTargetTpl.value = tpl
  deployTargetMode.value = 'new'
  deployTargetAppId.value = apps.value[0]?.appId ?? null
  deployTargetOpen.value = true
}

function deployTemplateAsNewApp(tpl: MarketplaceImage) {
  marketOpen.value = false
  deployTargetOpen.value = false
  appName.value = tpl.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  services.value = [imageToServiceForm(tpl)]
  drawerOpen.value = true
}

async function confirmDeployTarget() {
  const tpl = deployTargetTpl.value
  if (!tpl) return

  if (deployTargetMode.value === 'new') {
    deployTemplateAsNewApp(tpl)
    return
  }

  const targetAppId = deployTargetAppId.value
  if (!targetAppId) return

  deployTargetBusy.value = true
  try {
    const svcForm = imageToServiceForm(tpl)
    const ports = cleanPorts(svcForm.ports)
    const volumes = parseLines(svcForm.volumes)
    const environment = rowsToEnv(svcForm.envRows)
    await containersApi.addService(targetAppId, {
      serviceName: svcForm.serviceName,
      imageName: tpl.image,
      state: 'running',
      config: {
        image: tpl.image,
        ...(ports.length ? { ports } : {}),
        ...(environment && Object.keys(environment).length ? { environment } : {}),
        ...(volumes.length ? { volumes } : {}),
        restart: svcForm.restart || undefined,
        ...buildAdvancedConfig(svcForm),
      },
    })
    message.success(`${tpl.name} added to ${apps.value.find(a => a.appId === targetAppId)?.appName ?? 'app'}`)
  } catch (e: unknown) {
    message.error((e as any)?.message ?? 'Failed to add service')
  } finally {
    deployTargetBusy.value = false
    deployTargetOpen.value = false
    load()
  }
}

// ── Deploy drawer ─────────────────────────────────────────────────────────────

const drawerOpen = ref(false)
const deploying = ref(false)

interface ServiceForm {
  serviceName: string
  image: string
  ports: PortMappingRow[]
  envRows: { name: string; value: string }[]
  volumes: string
  restart: string
  networkMode: string
  command: string
  entrypoint: string
  user: string
  cpuLimit: string
  memoryLimit: string
  enableSocketDestination: boolean
  readonlyRootfs: boolean
  healthcheckType: 'none' | 'http' | 'tcp' | 'exec'
  healthcheckPath: string
  healthcheckPort: number | undefined
  healthcheckCommand: string
  healthcheckInterval: number
  healthcheckTimeout: number
  healthcheckRetries: number
}

function emptyService(): ServiceForm {
  return {
    serviceName: '', image: '', ports: [], envRows: [], volumes: '', restart: 'unless-stopped',
    networkMode: 'bridge', command: '', entrypoint: '', user: '',
    cpuLimit: '', memoryLimit: '', enableSocketDestination: false, readonlyRootfs: false,
    healthcheckType: 'none', healthcheckPath: '', healthcheckPort: undefined,
    healthcheckCommand: '', healthcheckInterval: 30, healthcheckTimeout: 5, healthcheckRetries: 3,
  }
}

const appName = ref('')
const services = ref<ServiceForm[]>([emptyService()])

function openDeploy() {
  appName.value = ''
  services.value = [emptyService()]
  drawerOpen.value = true
}

function addService() {
  services.value.push(emptyService())
}

function removeService(i: number) {
  services.value.splice(i, 1)
}

function envToRows(env?: Record<string, string>): { name: string; value: string }[] {
  if (!env || !Object.keys(env).length) return []
  return Object.entries(env).map(([name, value]) => ({ name, value }))
}

interface PortMappingRow {
  host: string
  container: string
}

function portsToRows(ports?: string[]): PortMappingRow[] {
  return (ports ?? []).map(port => {
    const separator = port.lastIndexOf(':')
    return separator === -1
      ? { host: '', container: port }
      : { host: port.slice(0, separator), container: port.slice(separator + 1) }
  })
}

function rowsToEnv(rows: { name: string; value: string }[]): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const k = row.name.trim()
    if (k) out[k] = row.value
  }
  return Object.keys(out).length ? out : undefined
}

function cleanPorts(rows: PortMappingRow[]): string[] {
  return rows
    .map(({ host, container }) => {
      const cleanHost = host.trim()
      const cleanContainer = container.trim()
      if (cleanHost && cleanContainer) return `${cleanHost}:${cleanContainer}`
      return cleanHost || cleanContainer
    })
    .filter(Boolean)
}

function formatLines(arr?: string[]): string {
  return arr ? arr.join('\n') : ''
}


function parseLines(raw: string): string[] {
  return raw.split('\n').map(l => l.trim()).filter(Boolean)
}

function buildAdvancedConfig(svc: ServiceForm): Record<string, unknown> {
  const cfg: Record<string, unknown> = {}
  if (svc.networkMode && svc.networkMode !== 'bridge') cfg.networkMode = svc.networkMode
  if (svc.command.trim()) cfg.command = svc.command.trim().split(/\s+/)
  if (svc.entrypoint.trim()) cfg.entrypoint = svc.entrypoint.trim().split(/\s+/)
  if (svc.user.trim()) cfg.user = svc.user.trim()
  if (svc.enableSocketDestination) cfg.enableSocketDestination = true
  if (svc.readonlyRootfs) cfg.readonlyRootfs = true
  const limits: Record<string, string> = {}
  if (svc.cpuLimit.trim()) limits.cpu = svc.cpuLimit.trim()
  if (svc.memoryLimit.trim()) limits.memory = svc.memoryLimit.trim()
  if (Object.keys(limits).length) cfg.resources = { limits }
  if (svc.healthcheckType !== 'none') {
    const probe: Record<string, unknown> = { type: svc.healthcheckType }
    if (svc.healthcheckType === 'http') {
      probe.path = svc.healthcheckPath || '/health'
      if (svc.healthcheckPort) probe.port = svc.healthcheckPort
    } else if (svc.healthcheckType === 'tcp') {
      if (svc.healthcheckPort) probe.port = svc.healthcheckPort
    } else if (svc.healthcheckType === 'exec') {
      if (svc.healthcheckCommand.trim()) probe.command = ['sh', '-c', svc.healthcheckCommand.trim()]
    }
    probe.periodSeconds = svc.healthcheckInterval
    probe.timeoutSeconds = svc.healthcheckTimeout
    probe.failureThreshold = svc.healthcheckRetries
    cfg.livenessProbe = probe
  }
  return cfg
}

async function deploy() {
  if (!appName.value.trim()) { message.error('Application name is required'); return }
  for (let i = 0; i < services.value.length; i++) {
    const svc = services.value[i]
    if (!svc.serviceName.trim()) { message.error(`Service ${i + 1}: name is required`); return }
    if (!svc.image.trim()) { message.error(`Service ${i + 1} (${svc.serviceName}): Docker image is required`); return }
  }

  deploying.value = true
  try {
    await containersApi.deploy({
      appName: appName.value.trim(),
      services: services.value.map(svc => {
        const ports = cleanPorts(svc.ports)
        const volumes = parseLines(svc.volumes)
        const environment = rowsToEnv(svc.envRows)
        return {
          serviceName: svc.serviceName.trim(),
          imageName: svc.image.trim(),
          state: 'running' as const,
          config: {
            image: svc.image.trim(),
            ...(ports.length ? { ports } : {}),
            ...(environment && Object.keys(environment).length ? { environment } : {}),
            ...(volumes.length ? { volumes } : {}),
            restart: svc.restart || undefined,
            ...buildAdvancedConfig(svc),
          },
        }
      }),
    })
    message.success(`${appName.value} deploying…`)
    drawerOpen.value = false
    await load()
  } catch (e: unknown) {
    message.error((e as any)?.message ?? 'Deploy failed')
  } finally {
    deploying.value = false
  }
}
</script>

<template>
  <AppLayout title="Applications">
    <div class="heading">
      <p>Deploy and manage containerised services on this device.</p>
    </div>

    <a-row :gutter="12" class="stats" aria-label="Application summary">
      <a-col :xs="12" :md="6">
        <a-card size="small" class="metric-card">
          <div class="metric-inner">
            <span class="metric-icon icon-apps"><AppstoreOutlined /></span>
            <a-statistic title="Applications" :value="apps.length" />
          </div>
        </a-card>
      </a-col>
      <a-col :xs="12" :md="6">
        <a-card size="small" class="metric-card">
          <div class="metric-inner">
            <span class="metric-icon icon-services"><RocketOutlined /></span>
            <a-statistic title="Services" :value="totalServices" />
          </div>
        </a-card>
      </a-col>
      <a-col :xs="12" :md="6">
        <a-card size="small" class="metric-card">
          <div class="metric-inner">
            <span class="metric-icon icon-running"><PlayCircleOutlined /></span>
            <a-statistic title="Running" :value="totalRunning" />
          </div>
        </a-card>
      </a-col>
      <a-col :xs="12" :md="6">
        <a-card size="small" class="metric-card">
          <div class="metric-inner">
            <span class="metric-icon icon-stopped"><PoweroffOutlined /></span>
            <a-statistic title="Stopped" :value="totalStopped" />
          </div>
        </a-card>
      </a-col>
    </a-row>

    <section class="resource-grid" aria-label="Resource monitoring">
      <a-card size="small" class="resource-card">
        <div class="resource-header">
          <div>
            <h3>CPU Utilization</h3>
            <span class="resource-subtitle">Current</span>
          </div>
          <span v-if="lastUpdatedLabel" class="resource-updated">Updated {{ lastUpdatedLabel }}</span>
        </div>
        <div class="cpu-summary">
          <strong>{{ cpuCurrent == null ? '—' : `${cpuCurrent.toFixed(1)}%` }}</strong>
          <span v-if="cpuPeak != null" class="cpu-peak">Peak {{ cpuPeak.toFixed(1) }}% · recent samples</span>
        </div>
        <div class="cpu-chart-layout">
          <div class="cpu-y-axis" aria-hidden="true"><span>100%</span><span>50%</span><span>0%</span></div>
          <div class="cpu-chart-wrap">
            <svg
              v-if="cpuChartPoints.length > 1"
              class="cpu-chart"
              viewBox="0 0 300 90"
              preserveAspectRatio="none"
              role="img"
              aria-label="CPU utilization history, percentage scale from zero to one hundred"
            >
              <line v-for="y in [5, 45, 85]" :key="y" x1="0" :y1="y" x2="300" :y2="y" class="cpu-grid-line" />
              <path :d="cpuChartArea" class="cpu-chart-area" />
              <path :d="cpuChartLine" class="cpu-chart-line" />
              <circle
                v-for="point in cpuChartPoints"
                :key="point.timestamp"
                :cx="point.x"
                :cy="point.y"
                r="1.8"
                class="cpu-chart-point"
              >
                <title>{{ cpuTimeLabel(point.timestamp) }} · {{ point.value.toFixed(1) }}%</title>
              </circle>
            </svg>
            <div v-else class="resource-empty">
              {{ statsLoading ? 'Loading CPU history…' : cpuSamples.length ? 'Collecting CPU history…' : 'Historical CPU samples unavailable' }}
            </div>
            <div v-if="cpuChartPoints.length > 1" class="cpu-time-axis">
              <span>{{ cpuTimeLabel(cpuChartPoints[0].timestamp) }}</span>
              <span>{{ cpuTimeLabel(cpuChartPoints[cpuChartPoints.length - 1].timestamp) }}</span>
            </div>
          </div>
        </div>
      </a-card>

      <a-card size="small" class="resource-card">
        <div class="resource-header">
          <div>
            <h3>Storage Usage</h3>
            <span class="resource-subtitle">Used / total capacity</span>
          </div>
          <div v-if="sysStats?.docker_reclaimable" class="storage-actions">
            <span>Reclaimable {{ fmtMb(sysStats.docker_reclaimable.total) }}</span>
            <a-button danger size="small" :loading="purging" @click="confirmPurge">Purge</a-button>
          </div>
        </div>
        <div v-if="storageChart" class="storage-layout">
          <div class="storage-donut" :style="storageDonutStyle" role="img" :aria-label="`${storageChart.percent.toFixed(1)} percent storage used`">
            <div class="storage-donut-center">
              <strong>{{ storageChart.percent.toFixed(0) }}%</strong>
              <span>Used</span>
            </div>
          </div>
          <div class="storage-legend">
            <div
              v-for="category in storageChart.categories"
              :key="category.name"
              class="storage-legend-row"
              :title="`${category.name}: ${fmtMb(category.value)} (${(category.value / storageChart.total * 100).toFixed(1)}%)`"
            >
              <span class="storage-legend-name"><i :style="{ backgroundColor: category.color }" />{{ category.name }}</span>
              <span>{{ fmtMb(category.value) }} ({{ (category.value / storageChart.total * 100).toFixed(0) }}%)</span>
            </div>
            <div class="storage-capacity">{{ fmtMb(storageChart.used) }} / {{ fmtMb(storageChart.total) }}</div>
          </div>
        </div>
        <div v-else class="resource-empty">
          {{ statsLoading ? 'Loading storage metrics…' : 'Storage capacity data unavailable' }}
        </div>
      </a-card>

      <a-card size="small" class="resource-card">
        <div class="resource-header">
          <div>
            <h3>Top CPU Consumers</h3>
            <span class="resource-subtitle">Current CPU usage</span>
          </div>
          <select v-model.number="cpuTopCount" class="top-count-select" aria-label="Number of top CPU consumers">
            <option :value="3">Top 3</option>
            <option :value="5">Top 5</option>
            <option :value="10">Top 10</option>
          </select>
        </div>
        <div v-if="topCpuConsumers.length" class="consumer-list">
          <div v-for="app in topCpuConsumers" :key="app.app_id" class="consumer-row">
            <span class="consumer-name" :title="app.app_name">{{ app.app_name }}</span>
            <div class="consumer-track"><span class="consumer-fill consumer-fill--cpu" :style="{ width: barWidth(app.cpu_percent, topCpuScale) }" /></div>
            <span class="consumer-value">{{ app.cpu_percent.toFixed(1) }}%</span>
          </div>
        </div>
        <div v-else class="resource-empty">{{ statsLoading ? 'Loading CPU metrics…' : 'No current CPU metrics available' }}</div>
      </a-card>

      <a-card size="small" class="resource-card">
        <div class="resource-header">
          <div>
            <h3>Top Storage Consumers</h3>
            <span class="resource-subtitle">Current app image storage</span>
          </div>
          <select v-model.number="storageTopCount" class="top-count-select" aria-label="Number of top storage consumers">
            <option :value="3">Top 3</option>
            <option :value="5">Top 5</option>
            <option :value="10">Top 10</option>
          </select>
        </div>
        <div v-if="topStorageConsumers.length" class="consumer-list">
          <div v-for="app in topStorageConsumers" :key="app.app_id" class="consumer-row">
            <span class="consumer-name" :title="app.app_name">{{ app.app_name }}</span>
            <div class="consumer-track"><span class="consumer-fill consumer-fill--storage" :style="{ width: barWidth(app.size, topStorageScale) }" /></div>
            <span class="consumer-value">{{ fmtMb(app.size) }}</span>
          </div>
        </div>
        <div v-else class="resource-empty">{{ statsLoading ? 'Loading storage metrics…' : 'No current app image storage metrics available' }}</div>
      </a-card>
    </section>

    <div class="filters">
      <a-input
        v-model:value="searchQuery"
        allow-clear
        class="filter-search"
        placeholder="Search applications or services"
      >
        <template #prefix><SearchOutlined /></template>
      </a-input>
      <a-button @click="searchQuery = ''">Clear</a-button>
      <div class="filters-actions">
        <a-button :loading="loading" @click="load"><template #icon><ReloadOutlined /></template>Refresh</a-button>
        <a-button :disabled="!dockerAvailable" @click="openMarketplace"><template #icon><ShopOutlined /></template>Marketplace</a-button>
        <a-button type="primary" :disabled="!dockerAvailable" @click="openDeploy"><template #icon><PlusOutlined /></template>Add Application</a-button>
      </div>
    </div>

    <!-- Docker unavailable -->
    <a-alert
      v-if="!dockerAvailable"
      type="warning"
      message="Docker is not available on this agent"
      description="This agent can't reach a Docker daemon, so applications can't be deployed or managed here. This is expected if the agent itself is running in a container without the host's Docker socket mounted — see the install docs for enabling it."
      show-icon
      style="margin-bottom: 16px"
    />

    <!-- Error -->
    <a-alert v-if="error" type="error" :message="error" show-icon style="margin-bottom: 16px" />

    <!-- Empty -->
    <a-empty
      v-if="!loading && !error && apps.length === 0"
      style="margin: 60px 0"
      description="No applications deployed"
    >
      <a-button v-if="dockerAvailable" type="primary" @click="openDeploy">
        <template #icon><PlusOutlined /></template>
        Add your first application
      </a-button>
    </a-empty>

    <div v-if="loading && apps.length === 0" class="app-grid" aria-label="Loading applications">
      <div v-for="i in 2" :key="i" class="app-card loading-card"><a-skeleton active :paragraph="{ rows: 4 }" /></div>
    </div>
    <a-empty
      v-else-if="apps.length > 0 && filteredApps.length === 0"
      description="No applications or services match your search"
      class="search-empty"
    />

    <div v-else class="app-grid">
      <article v-for="app in filteredApps" :key="app.appId" class="app-card">
        <div class="card-header">
          <div class="card-header-left">
            <AppstoreOutlined class="card-icon" aria-hidden="true" />
            <div class="app-title-block">
              <span class="app-name">{{ app.appName }}</span>
              <span class="app-summary">
                {{ summaryForApp(fullApp(app)).total }} service{{ summaryForApp(fullApp(app)).total !== 1 ? 's' : '' }}
                · {{ summaryForApp(fullApp(app)).running }} running
              </span>
            </div>
          </div>
          <div class="app-card-actions">
            <a-button
              type="text"
              class="icon-menu-button expand-button"
              :aria-label="collapsedApps.has(app.appId) ? `Expand ${app.appName}` : `Collapse ${app.appName}`"
              :aria-expanded="!collapsedApps.has(app.appId)"
              @click="toggleApp(app.appId)"
            >
              <DownOutlined :class="{ rotated: !collapsedApps.has(app.appId) }" />
            </a-button>
          </div>
        </div>

        <div v-if="!collapsedApps.has(app.appId)" class="card-body">
          <div v-if="app.services.length === 0" class="no-services">No services configured</div>
          <div
            v-for="svc in app.services"
            :key="svc.serviceId ?? svc.serviceName"
            class="service-row"
          >
            <span class="service-state-dot" :class="[`state-${resolveState(svc)}`, { 'socket-active': svc.socketConnected && resolveState(svc) === 'running' }]" :aria-label="STATUS_LABEL[resolveState(svc)]" />
            <div class="svc-identity">
              <button class="service-name service-name-button" type="button" @click="openServiceDetails(fullApp(app), svc)">
                {{ svc.serviceName }}
              </button>
              <span class="service-image" :title="svc.imageName">{{ svc.imageName }}</span>
              <a-tooltip v-if="svc.error" :title="svc.error.message" placement="topLeft">
                <span class="svc-error-hint">{{ svc.error.type }}</span>
              </a-tooltip>
            </div>
            <div class="service-ports">
              <template v-for="port in svc.config.ports ?? []" :key="port">
                <a
                  v-if="portUrl(port)"
                  class="port-tag"
                  :href="portUrl(port)!"
                  target="_blank"
                  rel="noopener noreferrer"
                  :aria-label="`Open ${svc.serviceName} on port ${port}`"
                >{{ port }}</a>
                <span v-else class="port-tag">{{ port }}</span>
              </template>
            </div>
            <div class="svc-controls">
              <a-button
                size="small"
                :type="resolveState(svc) === 'running' ? 'default' : 'primary'"
                :disabled="isServiceBusy(app.appId, svc.serviceName)"
                :loading="isServiceBusy(app.appId, svc.serviceName)"
                @click="doAction(app, svc, resolveState(svc) === 'running' ? 'stop' : 'start')"
              >
                <template #icon><PoweroffOutlined v-if="resolveState(svc) === 'running'" /><PlayCircleOutlined v-else /></template>
                {{ resolveState(svc) === 'running' ? 'Stop' : 'Start' }}
              </a-button>
              <a-button
                size="small"
                :disabled="isServiceBusy(app.appId, svc.serviceName)"
                @click="doAction(app, svc, 'restart')"
              >
                <template #icon><ReloadOutlined /></template>
                Restart
              </a-button>
              <a-dropdown :trigger="['click']">
                <a-button size="small" aria-label="Service actions" title="Service actions">
                  <template #icon><EllipsisOutlined /></template>
                </a-button>
                <template #overlay>
                  <a-menu @click="handleServiceMenuClick($event, fullApp(app), svc)">
                    <a-menu-item key="details"><EyeOutlined /> View details</a-menu-item>
                    <a-menu-item key="edit" :disabled="isServiceBusy(app.appId, svc.serviceName)"><EditOutlined /> Edit configuration</a-menu-item>
                    <a-menu-divider />
                    <a-menu-item key="delete" danger :disabled="isServiceBusy(app.appId, svc.serviceName)"><DeleteOutlined /> Delete service</a-menu-item>
                  </a-menu>
                </template>
              </a-dropdown>
            </div>
          </div>
          <div class="card-footer">
            <a-button size="small" type="default" :disabled="!dockerAvailable" @click="openAddService(fullApp(app))">
              <template #icon><PlusOutlined /></template>
              Add Service
            </a-button>
            <a-button size="small" type="default" @click="openAppDetails(fullApp(app))">
              <template #icon><EditOutlined /></template>
              Edit Application
            </a-button>
            <a-button size="small" type="default" class="view-logs-btn" :disabled="app.services.length === 0" @click="openAppLogs(app)">
              <template #icon><FileTextOutlined /></template>
              View Logs
            </a-button>
          </div>
        </div>
      </article>
    </div>

    <!-- Add Service drawer -->
    <a-drawer
      v-model:open="addSvcDrawerOpen"
      :title="`Add Service to ${addSvcTargetApp?.appName ?? ''}`"
      width="480"
      :body-style="{ paddingBottom: '80px' }"
    >
      <a-form layout="vertical">
        <a-form-item label="Docker image" required>
          <a-select
            v-model:value="addSvcSelectedImage"
            show-search
            :filter-option="filterImageOption"
            placeholder="Select an image…"
            style="width: 100%"
            @change="onImageSelected"
          >
            <a-select-option v-for="img in marketplaceImages" :key="img.id" :value="img.id">
              <div style="display: flex; align-items: center; gap: 8px">
                <span class="img-picker-avatar" :style="{ background: img.color }">{{ img.letter }}</span>
                <span style="font-weight: 500">{{ img.name }}</span>
                <a-tag size="small" style="margin: 0; font-size: 10px">{{ img.category }}</a-tag>
                <span style="color: var(--text-muted); font-family: monospace; font-size: 11px; margin-left: auto">{{ img.image }}</span>
              </div>
            </a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="Service name" required>
          <a-input v-model:value="addSvcForm.serviceName" placeholder="e.g. redis, worker" />
        </a-form-item>
        <a-form-item label="Port mappings">
          <div style="display: flex; flex-direction: column; gap: 6px">
            <div v-for="(port, pi) in addSvcForm.ports" :key="pi" style="display: flex; gap: 8px; align-items: center">
              <a-input v-model:value="port.host" placeholder="Host port" style="flex: 2; font-family: monospace; font-size: 12px" />
              <a-input v-model:value="port.container" placeholder="Container port" style="flex: 3; font-family: monospace; font-size: 12px" />
              <a-button type="text" size="small" danger @click="addSvcForm.ports.splice(pi, 1)">
                <template #icon><DeleteOutlined /></template>
              </a-button>
            </div>
            <a-button type="dashed" size="small" @click="addSvcForm.ports.push({ host: '', container: '' })" style="width: fit-content">
              <template #icon><PlusOutlined /></template> Add port
            </a-button>
          </div>
        </a-form-item>
        <a-form-item label="Environment variables">
          <div style="display: flex; flex-direction: column; gap: 6px">
            <div v-for="(row, i) in addSvcForm.envRows" :key="i" style="display: flex; gap: 8px; align-items: center">
              <a-input v-model:value="row.name" placeholder="NAME" style="flex: 2; font-family: monospace; font-size: 12px" />
              <a-input v-model:value="row.value" placeholder="Value" style="flex: 3; font-family: monospace; font-size: 12px" />
              <a-button type="text" size="small" danger @click="addSvcForm.envRows.splice(i, 1)">
                <template #icon><DeleteOutlined /></template>
              </a-button>
            </div>
            <a-button type="dashed" size="small" @click="addSvcForm.envRows.push({ name: '', value: '' })" style="width: fit-content">
              <template #icon><PlusOutlined /></template> Add variable
            </a-button>
          </div>
        </a-form-item>
        <a-form-item label="Volume mounts">
          <a-textarea v-model:value="addSvcForm.volumes" placeholder="/host/path:/container/path" :rows="2" />
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px">One per line</div>
        </a-form-item>
        <a-form-item label="Restart policy">
          <a-select v-model:value="addSvcForm.restart" style="width: 100%">
            <a-select-option value="unless-stopped">Unless stopped</a-select-option>
            <a-select-option value="always">Always</a-select-option>
            <a-select-option value="on-failure">On failure</a-select-option>
            <a-select-option value="no">No restart</a-select-option>
          </a-select>
        </a-form-item>

        <!-- Container Create Options -->
        <a-collapse :bordered="false" ghost style="margin-top: 8px">
          <a-collapse-panel key="advanced" header="Container Create Options">
            <a-form-item label="Network mode">
              <a-select v-model:value="addSvcForm.networkMode" style="width: 100%">
                <a-select-option value="bridge">bridge (default)</a-select-option>
                <a-select-option value="host">host</a-select-option>
                <a-select-option value="none">none</a-select-option>
              </a-select>
            </a-form-item>
            <a-form-item label="Command">
              <a-input v-model:value="addSvcForm.command" placeholder="Override container CMD" style="font-family: monospace; font-size: 12px" />
            </a-form-item>
            <a-form-item label="Entrypoint">
              <a-input v-model:value="addSvcForm.entrypoint" placeholder="Override ENTRYPOINT" style="font-family: monospace; font-size: 12px" />
            </a-form-item>
            <a-form-item label="User">
              <a-input v-model:value="addSvcForm.user" placeholder="e.g. 1000:1000 or node" />
              <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px">Run as non-root user for security hardening</div>
            </a-form-item>
            <div style="display: flex; gap: 12px">
              <a-form-item label="CPU limit" style="flex: 1">
                <a-input v-model:value="addSvcForm.cpuLimit" placeholder="e.g. 0.5, 2" />
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px">Number of CPUs</div>
              </a-form-item>
              <a-form-item label="Memory limit" style="flex: 1">
                <a-input v-model:value="addSvcForm.memoryLimit" placeholder="e.g. 256M, 1G" />
              </a-form-item>
            </div>
            <a-form-item label="Inter-process communication">
              <a-checkbox v-model:checked="addSvcForm.enableSocketDestination">Enable socket destination</a-checkbox>
              <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px">Mount a Unix socket into the container so the agent can publish data to it</div>
            </a-form-item>
            <a-form-item label="Security">
              <div style="display: flex; flex-direction: column; gap: 8px">
                <a-checkbox v-model:checked="addSvcForm.readonlyRootfs">Read-only root filesystem</a-checkbox>
                <a-tooltip title="Blocked by agent security policy — edge devices cannot run privileged containers">
                  <a-checkbox :disabled="true" :checked="false">
                    Privileged mode
                    <a-tag color="orange" size="small" style="margin-left: 6px">Blocked</a-tag>
                  </a-checkbox>
                </a-tooltip>
              </div>
            </a-form-item>
            <a-form-item label="Health check">
              <a-select v-model:value="addSvcForm.healthcheckType" style="width: 100%">
                <a-select-option value="none">None</a-select-option>
                <a-select-option value="http">HTTP</a-select-option>
                <a-select-option value="tcp">TCP</a-select-option>
                <a-select-option value="exec">Command</a-select-option>
              </a-select>
            </a-form-item>
            <template v-if="addSvcForm.healthcheckType === 'http'">
              <div style="display: flex; gap: 12px">
                <a-form-item label="Path" style="flex: 2">
                  <a-input v-model:value="addSvcForm.healthcheckPath" placeholder="/health" />
                </a-form-item>
                <a-form-item label="Port" style="flex: 1">
                  <a-input-number v-model:value="addSvcForm.healthcheckPort" :min="1" :max="65535" style="width: 100%" placeholder="8080" />
                </a-form-item>
              </div>
            </template>
            <template v-if="addSvcForm.healthcheckType === 'tcp'">
              <a-form-item label="Port">
                <a-input-number v-model:value="addSvcForm.healthcheckPort" :min="1" :max="65535" style="width: 100%" placeholder="8080" />
              </a-form-item>
            </template>
            <template v-if="addSvcForm.healthcheckType === 'exec'">
              <a-form-item label="Command">
                <a-input v-model:value="addSvcForm.healthcheckCommand" placeholder="curl -f http://localhost/health || exit 1" style="font-family: monospace; font-size: 12px" />
              </a-form-item>
            </template>
            <template v-if="addSvcForm.healthcheckType !== 'none'">
              <div style="display: flex; gap: 12px">
                <a-form-item label="Interval (s)" style="flex: 1">
                  <a-input-number v-model:value="addSvcForm.healthcheckInterval" :min="1" style="width: 100%" />
                </a-form-item>
                <a-form-item label="Timeout (s)" style="flex: 1">
                  <a-input-number v-model:value="addSvcForm.healthcheckTimeout" :min="1" style="width: 100%" />
                </a-form-item>
                <a-form-item label="Retries" style="flex: 1">
                  <a-input-number v-model:value="addSvcForm.healthcheckRetries" :min="1" style="width: 100%" />
                </a-form-item>
              </div>
            </template>
          </a-collapse-panel>
        </a-collapse>
      </a-form>
      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <a-button @click="addSvcDrawerOpen = false">Cancel</a-button>
          <a-button type="primary" :loading="addSvcSaving" @click="submitAddService">
            <template #icon><PlusOutlined /></template>
            Add Service
          </a-button>
        </div>
      </template>
    </a-drawer>

    <!-- Edit Service drawer -->
    <a-drawer
      v-model:open="editSvcDrawerOpen"
      :title="`Edit — ${editSvcTargetSvc?.serviceName ?? ''}`"
      width="480"
      :body-style="{ paddingBottom: '80px' }"
    >
      <a-form layout="vertical">
        <a-form-item label="Service name" required>
          <a-input v-model:value="editSvcForm.serviceName" placeholder="e.g. redis, worker" />
        </a-form-item>
        <a-form-item label="Docker image" required>
          <a-input v-model:value="editSvcForm.image" placeholder="redis:7, myregistry/app:latest" style="font-family: monospace; font-size: 12px" />
        </a-form-item>
        <a-form-item label="Port mappings">
          <div style="display: flex; flex-direction: column; gap: 6px">
            <div v-for="(port, pi) in editSvcForm.ports" :key="pi" style="display: flex; gap: 8px; align-items: center">
              <a-input v-model:value="port.host" placeholder="Host port" style="flex: 2; font-family: monospace; font-size: 12px" />
              <a-input v-model:value="port.container" placeholder="Container port" style="flex: 3; font-family: monospace; font-size: 12px" />
              <a-button type="text" size="small" danger @click="editSvcForm.ports.splice(pi, 1)">
                <template #icon><DeleteOutlined /></template>
              </a-button>
            </div>
            <a-button type="dashed" size="small" @click="editSvcForm.ports.push({ host: '', container: '' })" style="width: fit-content">
              <template #icon><PlusOutlined /></template> Add port
            </a-button>
          </div>
        </a-form-item>
        <a-form-item label="Environment variables">
          <div style="display: flex; flex-direction: column; gap: 6px">
            <div v-for="(row, i) in editSvcForm.envRows" :key="i" style="display: flex; gap: 8px; align-items: center">
              <a-input v-model:value="row.name" placeholder="NAME" style="flex: 2; font-family: monospace; font-size: 12px" />
              <a-input v-model:value="row.value" placeholder="Value" style="flex: 3; font-family: monospace; font-size: 12px" />
              <a-button type="text" size="small" danger @click="editSvcForm.envRows.splice(i, 1)">
                <template #icon><DeleteOutlined /></template>
              </a-button>
            </div>
            <a-button type="dashed" size="small" @click="editSvcForm.envRows.push({ name: '', value: '' })" style="width: fit-content">
              <template #icon><PlusOutlined /></template> Add variable
            </a-button>
          </div>
        </a-form-item>
        <a-form-item label="Volume mounts">
          <a-textarea v-model:value="editSvcForm.volumes" placeholder="/host/path:/container/path" :rows="2" />
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px">One per line</div>
        </a-form-item>
        <a-form-item label="Restart policy">
          <a-select v-model:value="editSvcForm.restart" style="width: 100%">
            <a-select-option value="unless-stopped">Unless stopped</a-select-option>
            <a-select-option value="always">Always</a-select-option>
            <a-select-option value="on-failure">On failure</a-select-option>
            <a-select-option value="no">No restart</a-select-option>
          </a-select>
        </a-form-item>

        <!-- Container Create Options -->
        <a-collapse :bordered="false" ghost style="margin-top: 8px">
          <a-collapse-panel key="advanced" header="Container Create Options">
            <a-form-item label="Network mode">
              <a-select v-model:value="editSvcForm.networkMode" style="width: 100%">
                <a-select-option value="bridge">bridge (default)</a-select-option>
                <a-select-option value="host">host</a-select-option>
                <a-select-option value="none">none</a-select-option>
              </a-select>
            </a-form-item>
            <a-form-item label="Command">
              <a-input v-model:value="editSvcForm.command" placeholder="Override container CMD" style="font-family: monospace; font-size: 12px" />
            </a-form-item>
            <a-form-item label="Entrypoint">
              <a-input v-model:value="editSvcForm.entrypoint" placeholder="Override ENTRYPOINT" style="font-family: monospace; font-size: 12px" />
            </a-form-item>
            <a-form-item label="User">
              <a-input v-model:value="editSvcForm.user" placeholder="e.g. 1000:1000 or node" />
              <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px">Run as non-root user for security hardening</div>
            </a-form-item>
            <div style="display: flex; gap: 12px">
              <a-form-item label="CPU limit" style="flex: 1">
                <a-input v-model:value="editSvcForm.cpuLimit" placeholder="e.g. 0.5, 2" />
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px">Number of CPUs</div>
              </a-form-item>
              <a-form-item label="Memory limit" style="flex: 1">
                <a-input v-model:value="editSvcForm.memoryLimit" placeholder="e.g. 256M, 1G" />
              </a-form-item>
            </div>
            <a-form-item label="Inter-process communication">
              <a-checkbox v-model:checked="editSvcForm.enableSocketDestination">Enable socket destination</a-checkbox>
              <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px">Mount a Unix socket into the container so the agent can publish data to it</div>
            </a-form-item>
            <a-form-item label="Security">
              <div style="display: flex; flex-direction: column; gap: 8px">
                <a-checkbox v-model:checked="editSvcForm.readonlyRootfs">Read-only root filesystem</a-checkbox>
                <a-tooltip title="Blocked by agent security policy — edge devices cannot run privileged containers">
                  <a-checkbox :disabled="true" :checked="false">
                    Privileged mode
                    <a-tag color="orange" size="small" style="margin-left: 6px">Blocked</a-tag>
                  </a-checkbox>
                </a-tooltip>
              </div>
            </a-form-item>
            <a-form-item label="Health check">
              <a-select v-model:value="editSvcForm.healthcheckType" style="width: 100%">
                <a-select-option value="none">None</a-select-option>
                <a-select-option value="http">HTTP</a-select-option>
                <a-select-option value="tcp">TCP</a-select-option>
                <a-select-option value="exec">Command</a-select-option>
              </a-select>
            </a-form-item>
            <template v-if="editSvcForm.healthcheckType === 'http'">
              <div style="display: flex; gap: 12px">
                <a-form-item label="Path" style="flex: 2">
                  <a-input v-model:value="editSvcForm.healthcheckPath" placeholder="/health" />
                </a-form-item>
                <a-form-item label="Port" style="flex: 1">
                  <a-input-number v-model:value="editSvcForm.healthcheckPort" :min="1" :max="65535" style="width: 100%" placeholder="8080" />
                </a-form-item>
              </div>
            </template>
            <template v-if="editSvcForm.healthcheckType === 'tcp'">
              <a-form-item label="Port">
                <a-input-number v-model:value="editSvcForm.healthcheckPort" :min="1" :max="65535" style="width: 100%" placeholder="8080" />
              </a-form-item>
            </template>
            <template v-if="editSvcForm.healthcheckType === 'exec'">
              <a-form-item label="Command">
                <a-input v-model:value="editSvcForm.healthcheckCommand" placeholder="curl -f http://localhost/health || exit 1" style="font-family: monospace; font-size: 12px" />
              </a-form-item>
            </template>
            <template v-if="editSvcForm.healthcheckType !== 'none'">
              <div style="display: flex; gap: 12px">
                <a-form-item label="Interval (s)" style="flex: 1">
                  <a-input-number v-model:value="editSvcForm.healthcheckInterval" :min="1" style="width: 100%" />
                </a-form-item>
                <a-form-item label="Timeout (s)" style="flex: 1">
                  <a-input-number v-model:value="editSvcForm.healthcheckTimeout" :min="1" style="width: 100%" />
                </a-form-item>
                <a-form-item label="Retries" style="flex: 1">
                  <a-input-number v-model:value="editSvcForm.healthcheckRetries" :min="1" style="width: 100%" />
                </a-form-item>
              </div>
            </template>
          </a-collapse-panel>
        </a-collapse>
      </a-form>
      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <a-button @click="editSvcDrawerOpen = false">Cancel</a-button>
          <a-button type="primary" :loading="editSvcSaving" @click="submitEditService">
            <template #icon><EditOutlined /></template>
            Save Changes
          </a-button>
        </div>
      </template>
    </a-drawer>

    <!-- App Details drawer -->
    <a-drawer
      v-model:open="appDetailsOpen"
      :title="`Edit — ${appDetailsTarget?.appName ?? ''}`"
      width="480"
      :body-style="{ paddingBottom: '80px' }"
      placement="right"
    >
      <a-form layout="vertical">
        <a-form-item label="Application name" required>
          <a-input v-model:value="appDetailsName" />
        </a-form-item>

        <a-divider orientation="left" style="font-size: 13px; margin: 20px 0 12px">Services</a-divider>

        <div v-if="appDetailsTarget" style="display: flex; flex-direction: column; gap: 8px">
          <div
            v-for="svc in appDetailsTarget.services"
            :key="svc.serviceId ?? svc.serviceName"
            style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; border: 1px solid var(--border-color); border-radius: 6px"
          >
            <div style="flex: 1; min-width: 0">
              <div style="font-weight: 500">{{ svc.serviceName }}</div>
              <div style="font-size: 12px; color: var(--text-tertiary); font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ svc.imageName }}</div>
            </div>
            <a-tag :color="STATUS_COLOR[resolveState(svc)]" style="margin: 0; font-size: 11px">
              {{ STATUS_LABEL[resolveState(svc)] }}
            </a-tag>
            <a-button size="small" @click="appDetailsOpen = false; openEditService(appDetailsTarget!, svc)">
              <template #icon><EditOutlined /></template>
            </a-button>
          </div>
          <div v-if="appDetailsTarget.services.length === 0" style="color: var(--text-muted); padding: 12px 0">
            No services configured
          </div>
        </div>
      </a-form>
      <template #footer>
        <div style="display: flex; justify-content: space-between; gap: 8px">
          <a-button v-if="appDetailsTarget" danger @click="confirmRemoveApp(appDetailsTarget)">
            <template #icon><DeleteOutlined /></template>
            Delete
          </a-button>
          <div style="display: flex; gap: 8px">
            <a-button @click="appDetailsOpen = false">Cancel</a-button>
            <a-button type="primary" :loading="appDetailsSaving" @click="saveAppDetails">
              Save Changes
            </a-button>
          </div>
        </div>
      </template>
    </a-drawer>

    <!-- Deploy drawer -->
    <a-drawer
      v-model:open="drawerOpen"
      title="Add Application"
      width="560"
      :body-style="{ paddingBottom: '80px' }"
    >
      <a-form layout="vertical">

        <!-- App name -->
        <a-form-item label="Application name" required>
          <a-input v-model:value="appName" placeholder="e.g. monitoring-stack, edge-gateway" />
          <div style="font-size: 12px; color: var(--text-tertiary); margin-top: 4px">
            Groups all services below under one application
          </div>
        </a-form-item>

        <a-divider orientation="left" style="font-size: 13px; margin: 20px 0 12px">
          Services
        </a-divider>

        <!-- Service cards -->
        <div v-for="(svc, i) in services" :key="i" class="service-form-card">
          <div class="service-form-header">
            <span style="font-weight: 600; font-size: 13px; color: var(--text-heading)">
              Service {{ i + 1 }}
            </span>
            <a-button
              v-if="services.length > 1"
              size="small"
              danger
              type="text"
              @click="removeService(i)"
            >
              <template #icon><DeleteOutlined /></template>
              Remove
            </a-button>
          </div>

          <a-form-item label="Service name" required style="margin-bottom: 10px">
            <a-input v-model:value="svc.serviceName" placeholder="e.g. nginx, postgres, redis" />
          </a-form-item>

          <a-form-item label="Docker image" required style="margin-bottom: 10px">
            <a-input v-model:value="svc.image" placeholder="nginx:latest, postgres:15, registry/image:tag" style="font-family: monospace; font-size: 12px" />
          </a-form-item>

          <a-form-item label="Port mappings" style="margin-bottom: 10px">
            <div style="display: flex; flex-direction: column; gap: 6px">
              <div v-for="(port, pi) in svc.ports" :key="pi" style="display: flex; gap: 8px; align-items: center">
                <a-input v-model:value="port.host" placeholder="Host port" style="flex: 2; font-family: monospace; font-size: 12px" />
                <a-input v-model:value="port.container" placeholder="Container port" style="flex: 3; font-family: monospace; font-size: 12px" />
                <a-button type="text" size="small" danger @click="svc.ports.splice(pi, 1)">
                  <template #icon><DeleteOutlined /></template>
                </a-button>
              </div>
              <a-button type="dashed" size="small" @click="svc.ports.push({ host: '', container: '' })" style="width: fit-content">
                <template #icon><PlusOutlined /></template> Add port
              </a-button>
            </div>
          </a-form-item>

          <a-form-item label="Environment variables" style="margin-bottom: 10px">
            <div style="display: flex; flex-direction: column; gap: 6px">
              <div v-for="(row, ri) in svc.envRows" :key="ri" style="display: flex; gap: 8px; align-items: center">
                <a-input v-model:value="row.name" placeholder="NAME" style="flex: 2; font-family: monospace; font-size: 12px" />
                <a-input v-model:value="row.value" placeholder="Value" style="flex: 3; font-family: monospace; font-size: 12px" />
                <a-button type="text" size="small" danger @click="svc.envRows.splice(ri, 1)">
                  <template #icon><DeleteOutlined /></template>
                </a-button>
              </div>
              <a-button type="dashed" size="small" @click="svc.envRows.push({ name: '', value: '' })" style="width: fit-content">
                <template #icon><PlusOutlined /></template> Add variable
              </a-button>
            </div>
          </a-form-item>

          <a-form-item label="Volume mounts" style="margin-bottom: 10px">
            <a-textarea
              v-model:value="svc.volumes"
              placeholder="/host/path:/container/path&#10;my-volume:/app/data"
              :rows="2"
            />
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px">One per line</div>
          </a-form-item>

          <a-form-item label="Restart policy" style="margin-bottom: 0">
            <a-select v-model:value="svc.restart" style="width: 100%">
              <a-select-option value="unless-stopped">Unless stopped</a-select-option>
              <a-select-option value="always">Always</a-select-option>
              <a-select-option value="on-failure">On failure</a-select-option>
              <a-select-option value="no">No restart</a-select-option>
            </a-select>
          </a-form-item>

          <!-- Container Create Options -->
          <a-collapse :bordered="false" ghost style="margin-top: 8px">
            <a-collapse-panel key="advanced" header="Container Create Options">
              <a-form-item label="Network mode">
                <a-select v-model:value="svc.networkMode" style="width: 100%">
                  <a-select-option value="bridge">bridge (default)</a-select-option>
                  <a-select-option value="host">host</a-select-option>
                  <a-select-option value="none">none</a-select-option>
                </a-select>
              </a-form-item>
              <a-form-item label="Command">
                <a-input v-model:value="svc.command" placeholder="Override container CMD" style="font-family: monospace; font-size: 12px" />
              </a-form-item>
              <a-form-item label="Entrypoint">
                <a-input v-model:value="svc.entrypoint" placeholder="Override ENTRYPOINT" style="font-family: monospace; font-size: 12px" />
              </a-form-item>
              <a-form-item label="User">
                <a-input v-model:value="svc.user" placeholder="e.g. 1000:1000 or node" />
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px">Run as non-root user for security hardening</div>
              </a-form-item>
              <div style="display: flex; gap: 12px">
                <a-form-item label="CPU limit" style="flex: 1">
                  <a-input v-model:value="svc.cpuLimit" placeholder="e.g. 0.5, 2" />
                  <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px">Number of CPUs</div>
                </a-form-item>
                <a-form-item label="Memory limit" style="flex: 1">
                  <a-input v-model:value="svc.memoryLimit" placeholder="e.g. 256M, 1G" />
                </a-form-item>
              </div>
              <a-form-item label="Inter-process communication">
                <a-checkbox v-model:checked="svc.enableSocketDestination">Enable socket destination</a-checkbox>
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px">Mount a Unix socket into the container so the agent can publish data to it</div>
              </a-form-item>
              <a-form-item label="Security">
                <div style="display: flex; flex-direction: column; gap: 8px">
                  <a-checkbox v-model:checked="svc.readonlyRootfs">Read-only root filesystem</a-checkbox>
                  <a-tooltip title="Blocked by agent security policy — edge devices cannot run privileged containers">
                    <a-checkbox :disabled="true" :checked="false">
                      Privileged mode
                      <a-tag color="orange" size="small" style="margin-left: 6px">Blocked</a-tag>
                    </a-checkbox>
                  </a-tooltip>
                </div>
              </a-form-item>
              <a-form-item label="Health check">
                <a-select v-model:value="svc.healthcheckType" style="width: 100%">
                  <a-select-option value="none">None</a-select-option>
                  <a-select-option value="http">HTTP</a-select-option>
                  <a-select-option value="tcp">TCP</a-select-option>
                  <a-select-option value="exec">Command</a-select-option>
                </a-select>
              </a-form-item>
            </a-collapse-panel>
          </a-collapse>
          <div v-if="svc.healthcheckType !== 'none'" style="margin-top: 4px">
            <div v-if="svc.healthcheckType === 'http'" style="display: flex; gap: 12px">
              <a-form-item label="Path" style="flex: 2">
                <a-input v-model:value="svc.healthcheckPath" placeholder="/health" />
              </a-form-item>
              <a-form-item label="Port" style="flex: 1">
                <a-input-number v-model:value="svc.healthcheckPort" :min="1" :max="65535" style="width: 100%" placeholder="8080" />
              </a-form-item>
            </div>
            <a-form-item v-if="svc.healthcheckType === 'tcp'" label="Port">
              <a-input-number v-model:value="svc.healthcheckPort" :min="1" :max="65535" style="width: 100%" placeholder="8080" />
            </a-form-item>
            <a-form-item v-if="svc.healthcheckType === 'exec'" label="Command">
              <a-input v-model:value="svc.healthcheckCommand" placeholder="curl -f http://localhost/health || exit 1" style="font-family: monospace; font-size: 12px" />
            </a-form-item>
            <div style="display: flex; gap: 12px">
              <a-form-item label="Interval (s)" style="flex: 1">
                <a-input-number v-model:value="svc.healthcheckInterval" :min="1" style="width: 100%" />
              </a-form-item>
              <a-form-item label="Timeout (s)" style="flex: 1">
                <a-input-number v-model:value="svc.healthcheckTimeout" :min="1" style="width: 100%" />
              </a-form-item>
              <a-form-item label="Retries" style="flex: 1">
                <a-input-number v-model:value="svc.healthcheckRetries" :min="1" style="width: 100%" />
              </a-form-item>
            </div>
          </div>
        </div>

        <!-- Add service -->
        <a-button
          block
          style="margin-top: 12px; border-style: dashed"
          @click="addService"
        >
          <template #icon><PlusOutlined /></template>
          Add Another Service
        </a-button>

      </a-form>

      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <a-button @click="drawerOpen = false">Cancel</a-button>
          <a-button type="primary" :loading="deploying" @click="deploy">
            <template #icon><PlayCircleOutlined /></template>
            Deploy
          </a-button>
        </div>
      </template>
    </a-drawer>

    <!-- Marketplace modal -->
    <a-modal
      v-model:open="marketOpen"
      title="App Marketplace"
      :footer="null"
      width="900px"
      :body-style="{ padding: '0', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }"
    >
      <template #title>
        <div style="display: flex; align-items: center; gap: 10px">
          <ShopOutlined style="color: #1677ff; font-size: 18px" />
          <span>App Marketplace</span>
          <span style="font-size: 12px; font-weight: 400; color: var(--text-tertiary); margin-left: 4px">
            One-click deploy for popular IoT apps
          </span>
        </div>
      </template>

      <MarketplaceCatalog v-if="marketOpen" @deploy="deployTemplate" />
    </a-modal>

    <!-- Deploy target picker -->
    <a-modal
      v-model:open="deployTargetOpen"
      :title="`Deploy ${deployTargetTpl?.name ?? ''}`"
      :ok-text="deployTargetMode === 'new' ? 'Continue' : 'Deploy'"
      :confirm-loading="deployTargetBusy"
      @ok="confirmDeployTarget"
      width="440px"
    >
      <div style="margin: 16px 0 20px">
        <a-radio-group v-model:value="deployTargetMode" style="width: 100%">
          <div class="deploy-target-option" :class="{ active: deployTargetMode === 'existing' }" @click="deployTargetMode = 'existing'">
            <a-radio value="existing">Add to existing application</a-radio>
            <a-select
              v-if="deployTargetMode === 'existing'"
              v-model:value="deployTargetAppId"
              style="width: 100%; margin-top: 8px"
              :options="apps.map(a => ({ label: a.appName, value: a.appId }))"
            />
          </div>
          <div class="deploy-target-option" :class="{ active: deployTargetMode === 'new' }" @click="deployTargetMode = 'new'" style="margin-top: 10px">
            <a-radio value="new">Create new application</a-radio>
          </div>
        </a-radio-group>
      </div>
      <div style="font-size: 12px; color: var(--text-tertiary)">
        1 service will be added: <span style="font-family: monospace">{{ deployTargetTpl?.image }}</span>
      </div>
    </a-modal>

    <a-drawer
      v-model:open="serviceDetailsOpen"
      :title="currentServiceDetailsService?.serviceName ?? 'Service details'"
      width="520"
      placement="right"
      :keyboard="true"
      @keydown.esc="serviceDetailsOpen = false"
    >
      <template v-if="currentServiceDetailsApp && currentServiceDetailsService">
        <div class="details-heading">
          <span>Application: {{ currentServiceDetailsApp.appName }}</span>
          <a-tag :color="STATUS_COLOR[resolveState(currentServiceDetailsService)]">
            {{ STATUS_LABEL[resolveState(currentServiceDetailsService)] }}
          </a-tag>
        </div>
        <div class="details-actions">
          <a-button
            type="primary"
            :disabled="!dockerAvailable || isServiceBusy(currentServiceDetailsApp.appId, currentServiceDetailsService.serviceName)"
            :loading="isServiceBusy(currentServiceDetailsApp.appId, currentServiceDetailsService.serviceName)"
            @click="doAction(currentServiceDetailsApp, currentServiceDetailsService, resolveState(currentServiceDetailsService) === 'running' ? 'stop' : 'start')"
          >
            <template #icon><PoweroffOutlined v-if="resolveState(currentServiceDetailsService) === 'running'" /><PlayCircleOutlined v-else /></template>
            {{ resolveState(currentServiceDetailsService) === 'running' ? 'Stop' : 'Start' }}
          </a-button>
          <a-button
            :disabled="!dockerAvailable || isServiceBusy(currentServiceDetailsApp.appId, currentServiceDetailsService.serviceName)"
            @click="doAction(currentServiceDetailsApp, currentServiceDetailsService, 'restart')"
          >
            <template #icon><ReloadOutlined /></template>
            Restart
          </a-button>
          <a-button @click="serviceDetailsOpen = false; openLogs(currentServiceDetailsApp, currentServiceDetailsService)">
            <template #icon><FileTextOutlined /></template>
            Logs
          </a-button>
          <a-button @click="serviceDetailsOpen = false; openEditService(currentServiceDetailsApp, currentServiceDetailsService)">
            <template #icon><EditOutlined /></template>
            Edit
          </a-button>
        </div>

        <a-divider orientation="left">Container</a-divider>
        <a-descriptions :column="1" size="small" bordered>
          <a-descriptions-item label="Image">{{ currentServiceDetailsService.imageName }}</a-descriptions-item>
          <a-descriptions-item label="Container ID">{{ currentServiceDetailsService.containerId || '—' }}</a-descriptions-item>
          <a-descriptions-item label="State">{{ currentServiceDetailsService.status?.state ?? currentServiceDetailsService.serviceStatus ?? currentServiceDetailsService.state ?? 'Unknown' }}</a-descriptions-item>
          <a-descriptions-item v-if="currentServiceDetailsService.status?.health" label="Health">
            {{ currentServiceDetailsService.status.health }}
          </a-descriptions-item>
          <a-descriptions-item v-if="currentServiceDetailsService.status?.message || currentServiceDetailsService.error?.message" label="Message">
            {{ currentServiceDetailsService.status?.message ?? currentServiceDetailsService.error?.message }}
          </a-descriptions-item>
          <a-descriptions-item v-if="currentServiceDetailsService.status?.restartCount !== undefined" label="Restart count">
            {{ currentServiceDetailsService.status.restartCount }}
          </a-descriptions-item>
          <a-descriptions-item v-if="currentServiceDetailsService.status?.exitCode !== undefined" label="Exit code">
            {{ currentServiceDetailsService.status.exitCode }}
          </a-descriptions-item>
        </a-descriptions>

        <a-divider orientation="left">Configuration</a-divider>
        <div class="details-section">
          <div class="details-label">Port mappings</div>
          <span v-if="!currentServiceDetailsService.config.ports?.length" class="details-empty">None</span>
          <div v-else class="details-values">
            <a
              v-for="port in currentServiceDetailsService.config.ports"
              :key="port"
              :href="portUrl(port) ?? undefined"
              :target="portUrl(port) ? '_blank' : undefined"
              :rel="portUrl(port) ? 'noopener noreferrer' : undefined"
              class="port-tag"
            >{{ port }}</a>
          </div>
        </div>
        <div class="details-section">
          <div class="details-label">Environment variables</div>
          <div v-if="Object.keys(currentServiceDetailsService.config.environment ?? {}).length" class="environment-list">
            <div v-for="(value, name) in currentServiceDetailsService.config.environment" :key="name" class="environment-row">
              <code>{{ name }}</code>
              <code>{{ maskedEnvironmentValue(name, value) }}</code>
            </div>
          </div>
          <span v-else class="details-empty">None</span>
        </div>
        <div class="details-section">
          <div class="details-label">Volumes</div>
          <span v-if="!currentServiceDetailsService.config.volumes?.length" class="details-empty">None</span>
          <div v-else class="details-values">
            <code v-for="volume in currentServiceDetailsService.config.volumes" :key="volume" class="details-value">{{ volume }}</code>
          </div>
        </div>
        <div class="details-section">
          <div class="details-label">Restart policy</div>
          <span class="details-value">{{ currentServiceDetailsService.config.restart || 'Default' }}</span>
        </div>
        <div v-if="currentServiceDetailsService.config.networkMode" class="details-section">
          <div class="details-label">Network mode</div>
          <span>{{ currentServiceDetailsService.config.networkMode }}</span>
        </div>
        <div v-if="currentServiceDetailsService.config.command?.length" class="details-section">
          <div class="details-label">Command</div>
          <code>{{ currentServiceDetailsService.config.command.join(' ') }}</code>
        </div>
        <div v-if="currentServiceDetailsService.config.entrypoint?.length" class="details-section">
          <div class="details-label">Entrypoint</div>
          <code>{{ currentServiceDetailsService.config.entrypoint.join(' ') }}</code>
        </div>
        <div v-if="currentServiceDetailsService.config.user" class="details-section">
          <div class="details-label">User</div>
          <code>{{ currentServiceDetailsService.config.user }}</code>
        </div>
        <div v-if="currentServiceDetailsService.config.resources?.limits" class="details-section">
          <div class="details-label">Resource limits</div>
          <span>
            {{ currentServiceDetailsService.config.resources.limits.cpu ? `CPU ${currentServiceDetailsService.config.resources.limits.cpu}` : '' }}
            {{ currentServiceDetailsService.config.resources.limits.memory ? `Memory ${currentServiceDetailsService.config.resources.limits.memory}` : '' }}
          </span>
        </div>
      </template>
    </a-drawer>

    <!-- Log viewer drawer -->
    <a-drawer
      v-model:open="logDrawerOpen"
      width="720"
      :body-style="{ padding: 0, display: 'flex', flexDirection: 'column', height: '100%' }"
      @close="onLogDrawerClose"
    >
      <template #title>
        <div style="display: flex; align-items: center; gap: 10px">
          <span>Logs — {{ logApp?.appName ?? '' }}</span>
          <template v-if="logApp && logApp.services.length > 1">
            <SwapOutlined style="color: var(--text-tertiary); font-size: 13px" />
            <a-select
              :value="logSvc?.serviceName"
              size="small"
              style="min-width: 140px"
              @change="(v: any) => switchService(v)"
            >
              <a-select-option v-for="s in logApp.services" :key="s.serviceName" :value="s.serviceName">
                {{ s.serviceName }}
              </a-select-option>
            </a-select>
          </template>
          <span v-else style="font-weight: 400; color: var(--text-secondary)">/ {{ logSvc?.serviceName ?? '' }}</span>
        </div>
      </template>
      <div class="log-toolbar">
        <div style="display: flex; align-items: center; gap: 8px">
          <a-switch v-model:checked="logFollow" size="small" @change="toggleFollow" />
          <span class="log-toolbar-label">Follow</span>
        </div>
        <div style="display: flex; align-items: center; gap: 8px">
          <a-switch v-model:checked="logAutoScroll" size="small" />
          <span class="log-toolbar-label">Auto-scroll</span>
        </div>
        <a-button size="small" @click="logLines = []">Clear</a-button>
        <span class="log-count">{{ logLines.length }} lines</span>
        <a-button size="small" @click="openLogSearch" title="Search logs">
          <template #icon><SearchOutlined /></template>
        </a-button>
        <a-button v-if="logLines.length > 0" size="small" @click="copyContainerLogs" :title="logCopied ? 'Copied' : 'Copy logs'">
          <template #icon><CheckOutlined v-if="logCopied" /><CopyOutlined v-else /></template>
        </a-button>
      </div>
      <div v-if="logSearchOpen" class="log-search-bar">
        <a-input
          v-model:value="logSearchQuery"
          class="log-search-input"
          size="small"
          placeholder="Search logs…"
          allow-clear
          @keydown.enter.prevent="logSearchNext"
          @keydown.escape.prevent="closeLogSearch"
        />
        <span class="log-search-count">{{ logSearchMatches.length ? `${logSearchIndex + 1} / ${logSearchMatches.length}` : 'No results' }}</span>
        <a-button size="small" :disabled="!logSearchMatches.length" @click="logSearchPrev" title="Previous">
          <template #icon><UpOutlined /></template>
        </a-button>
        <a-button size="small" :disabled="!logSearchMatches.length" @click="logSearchNext" title="Next">
          <template #icon><DownOutlined /></template>
        </a-button>
        <a-button size="small" @click="closeLogSearch" title="Close">
          <template #icon><CloseOutlined /></template>
        </a-button>
      </div>
      <div ref="logOutputEl" class="log-output">
        <div v-if="logLines.length === 0" class="log-empty">Waiting for logs…</div>
        <div
          v-for="(line, i) in logLines"
          :key="i"
          class="log-line"
          :class="line.stream"
        >
          <span v-if="line.ts" class="log-ts">{{ line.ts }}</span>
          <span class="log-msg"><template v-for="(seg, j) in logSegments(line, i)" :key="j"><mark v-if="seg.hit" class="search-hit" :class="{ 'search-current': seg.current }">{{ seg.text }}</mark><template v-else>{{ seg.text }}</template></template></span>
        </div>
      </div>
    </a-drawer>

  </AppLayout>
</template>

<style scoped>
.heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
.heading p { color: var(--text-tertiary); margin: 0; }
.filters { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 14px; }
.filter-search { width: 260px; flex-shrink: 0; }
.filters-actions { display: flex; gap: 8px; margin-left: auto; flex-shrink: 0; }
.stats { margin-bottom: 14px; }
.stats :deep(.ant-card) { border-radius: 9px; border-color: var(--border-color-card); background: var(--bg-subtle); }
.stats :deep(.ant-card-body) { padding: 17px 18px; }
.resource-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}
.resource-card {
  min-width: 0;
  border-radius: 9px;
  border-color: var(--border-color-card);
  background: var(--bg-subtle);
}
.resource-card :deep(.ant-card-body) { padding: 14px 16px; }
.resource-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; min-height: 34px; }
.resource-header h3 { margin: 0; color: var(--text-secondary); font-size: 13px; font-weight: 600; }
.resource-subtitle, .resource-updated { color: var(--text-tertiary); font-size: 11px; }
.resource-updated { text-align: right; white-space: nowrap; }
.cpu-summary { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 4px 0 2px; }
.cpu-summary strong { color: #3cb77d; font-size: 25px; line-height: 1.15; }
.cpu-peak { color: var(--text-tertiary); font-size: 11px; }
.cpu-chart-layout { display: flex; gap: 8px; height: 104px; }
.cpu-y-axis { display: flex; flex-direction: column; justify-content: space-between; padding: 1px 0 15px; color: var(--text-tertiary); font-size: 9px; }
.cpu-chart-wrap { min-width: 0; flex: 1; }
.cpu-chart { display: block; width: 100%; height: 84px; overflow: visible; }
.cpu-grid-line { stroke: var(--border-color); stroke-width: 0.7; }
.cpu-chart-area { fill: rgba(60, 183, 125, 0.14); }
.cpu-chart-line { fill: none; stroke: #3cb77d; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.cpu-chart-point { fill: #3cb77d; stroke: var(--bg-subtle); stroke-width: 0.7; }
.cpu-time-axis { display: flex; justify-content: space-between; color: var(--text-tertiary); font-size: 9px; }
.resource-empty { display: flex; align-items: center; justify-content: center; min-height: 90px; color: var(--text-tertiary); font-size: 12px; text-align: center; }
.storage-layout { display: flex; align-items: center; justify-content: center; gap: 24px; min-height: 116px; }
.storage-donut { display: grid; width: 108px; height: 108px; flex: 0 0 108px; place-items: center; border-radius: 50%; }
.storage-donut-center { display: flex; width: 68px; height: 68px; flex-direction: column; align-items: center; justify-content: center; border-radius: 50%; background: var(--bg-subtle); }
.storage-donut-center strong { color: var(--text-secondary); font-size: 17px; line-height: 1.2; }
.storage-donut-center span { color: var(--text-tertiary); font-size: 10px; }
.storage-legend { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 5px; font-size: 11px; }
.storage-legend-row, .storage-legend-name { display: flex; align-items: center; }
.storage-legend-row { justify-content: space-between; gap: 8px; color: var(--text-secondary); }
.storage-legend-name { min-width: 0; gap: 6px; }
.storage-legend-name i { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; }
.storage-capacity { margin-top: 2px; color: var(--text-tertiary); }
.storage-actions { display: flex; align-items: center; gap: 8px; color: var(--text-tertiary); font-size: 10px; white-space: nowrap; }
.top-count-select { flex: 0 0 auto; border: 1px solid var(--border-color); border-radius: 5px; padding: 3px 6px; background: var(--bg-subtle); color: var(--text-secondary); font-size: 11px; }
.consumer-list { display: flex; max-height: 176px; flex-direction: column; gap: 9px; overflow-y: auto; padding: 6px 0 2px; }
.consumer-row { display: flex; min-width: 0; align-items: center; gap: 9px; }
.consumer-name { width: 84px; flex: 0 1 84px; overflow: hidden; color: var(--text-secondary); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.consumer-track { height: 7px; min-width: 30px; flex: 1; overflow: hidden; border-radius: 5px; background: var(--border-color); }
.consumer-fill { display: block; height: 100%; border-radius: inherit; transition: width 0.35s ease; }
.consumer-fill--cpu { background: #3cb77d; }
.consumer-fill--storage { background: #1677ff; }
.consumer-value { min-width: 56px; color: var(--text-secondary); font-size: 11px; text-align: right; white-space: nowrap; }
.metric-inner { display: flex; align-items: center; gap: 15px; min-height: 66px; }
.metric-icon { width: 50px; height: 50px; flex-shrink: 0; border-radius: 14px; display: inline-flex; align-items: center; justify-content: center; font-size: 23px; }
.icon-apps, .icon-services { background: var(--icon-bg-blue, rgba(22,119,255,0.1)); color: #1677ff; }
.icon-running { background: rgba(60,183,125,0.12); color: #3cb77d; }
.icon-stopped { background: rgba(140,140,140,0.12); color: #8b949e; }
.metric-card :deep(.ant-statistic-title) { color: var(--text-tertiary); }
.metric-card :deep(.ant-statistic-content) { font-size: 23px; }
.search-empty { margin: 44px 0; }
.loading-card { padding: 18px; }
/* ── Card grid ───────────────────────────────────────────── */
.app-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
  gap: 16px;
  align-items: start;
}

.app-card {
  border: 1px solid var(--border-color-card);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-container);
  display: flex;
  flex-direction: column;
  transition: border-color 0.2s;
}

.app-card:hover {
  border-color: var(--border-color-strong);
}

/* ── Card header ─────────────────────────────────────────── */
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 11px 14px;
  gap: 10px;
  background: var(--bg-card-header);
}

.card-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.card-icon {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: var(--bg-selected);
  color: #1677ff;
  font-size: 14px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.app-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.app-title-block { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.app-summary { color: var(--text-tertiary); font-size: 11px; }
.app-card-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.app-status { margin: 0; font-size: 11px; }
.icon-menu-button { color: var(--text-secondary); }
.icon-menu-button:focus-visible, .service-name-button:focus-visible, .svc-controls :deep(.ant-btn:focus-visible) {
  outline: 2px solid #1677ff;
  outline-offset: 2px;
}
.expand-button { width: 28px; height: 28px; }
.expand-button :deep(svg) { transition: transform 0.15s; }
.expand-button :deep(svg.rotated) { transform: rotate(180deg); }

.card-body { padding: 3px 0 10px; }
.service-row {
  display: grid;
  grid-template-columns: 8px minmax(120px, 1fr) minmax(0, auto) auto;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);
}
.service-row:last-of-type { border-bottom: none; }
.service-state-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); }
.service-state-dot.state-running { background: #52c41a; }
.service-state-dot.state-stopped { background: #8c8c8c; }
.service-state-dot.state-error { background: #ff4d4f; }
.service-state-dot.state-creating { background: #faad14; }
.service-state-dot.state-unknown { background: #faad14; }
.svc-identity { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; }
.service-name {
  font-weight: 600;
  font-size: 13px;
  color: var(--text-heading);
}
.service-name-button {
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.service-name-button:hover { color: #1677ff; }
.service-image {
  max-width: 100%;
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.service-ports { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; }
.port-tag {
  display: inline-block;
  font-size: 11px;
  background: var(--bg-selected);
  color: #1677ff;
  border: 1px solid var(--badge-running-border);
  border-radius: 3px;
  padding: 1px 5px;
  white-space: nowrap;
}
a.port-tag { text-decoration: none; }
a.port-tag:hover { border-color: #1677ff; }
.service-status { margin: 0; font-size: 11px; }
.svc-controls { display: flex; align-items: center; gap: 5px; }
.svc-controls :deep(.ant-btn) { display: inline-flex; align-items: center; justify-content: center; }
.svc-error-hint {
  font-size: 11px;
  color: #ff4d4f;
  background: var(--badge-stopped-bg);
  border: 1px solid var(--badge-stopped-border);
  border-radius: 3px;
  padding: 0 5px;
  cursor: help;
  white-space: nowrap;
}
.service-state-dot.socket-active {
  animation: dot-blink 1s step-end infinite;
}
@keyframes dot-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
.no-services { padding: 14px; font-size: 12px; color: var(--text-placeholder); text-align: center; }
.card-footer { padding: 8px 14px 0; display: flex; align-items: center; gap: 8px; }
.card-footer :deep(.ant-btn) { border-color: var(--border-color); }
.card-footer .delete-app-btn { margin-left: auto; }
.card-footer .view-logs-btn { margin-left: auto; }

.details-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--text-secondary); }
.details-heading :deep(.ant-tag) { margin: 0; }
.details-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.details-section { margin: 16px 0; }
.details-label { margin-bottom: 7px; color: var(--text-secondary); font-size: 12px; font-weight: 600; }
.details-value { color: var(--text-primary); }
.details-empty { color: var(--text-muted); font-size: 12px; }
.details-values { display: flex; flex-wrap: wrap; gap: 6px; }
.details-values code, .environment-row code { overflow-wrap: anywhere; }
.environment-list { border: 1px solid var(--border-color); border-radius: 6px; overflow: hidden; }
.environment-row { display: flex; justify-content: space-between; gap: 12px; padding: 8px 10px; border-bottom: 1px solid var(--border-color); }
.environment-row:last-child { border-bottom: 0; }
.environment-row code { min-width: 0; color: var(--text-secondary); font-size: 11px; }

@media (max-width: 1100px) {
  .service-row { grid-template-columns: 8px minmax(0, 1fr) minmax(0, auto); }
  .service-ports { grid-column: 2; }
  .service-status { grid-column: 3; grid-row: 1; justify-self: end; }
  .svc-controls { grid-column: 3; justify-self: end; }
}

@media (max-width: 768px) {
  .heading { align-items: flex-start; flex-direction: column; }
  .metric-inner { gap: 8px; }
  .metric-icon { width: 38px; height: 38px; }
  .resource-grid { grid-template-columns: minmax(0, 1fr); }
}

@media (max-width: 480px) {
  .filters-actions { width: 100%; margin-left: 0; }
  .filters-actions :deep(.ant-btn) { flex: 1; }
  .filter-search { width: 100%; }
  .service-row { grid-template-columns: 8px minmax(0, 1fr) auto; gap: 8px; padding: 9px 10px; }
  .service-status { grid-column: 3; grid-row: 1; }
  .service-ports { grid-column: 2; grid-row: 2; }
  .svc-controls { grid-column: 3; grid-row: 2; }
  .svc-controls :deep(.ant-btn) { padding-inline: 6px; }
  .svc-controls :deep(.ant-btn > span:not(.anticon)) { font-size: 11px; }
  .app-card-actions { gap: 0; }
  .app-status { display: none; }
  .environment-row { align-items: flex-start; flex-direction: column; gap: 4px; }
  .resource-card :deep(.ant-card-body) { padding: 12px; }
  .storage-layout { gap: 14px; }
  .storage-donut { width: 92px; height: 92px; flex-basis: 92px; }
  .storage-donut-center { width: 60px; height: 60px; }
  .consumer-name { width: 72px; flex-basis: 72px; }
  .consumer-row { gap: 7px; }
}

/* ── Deploy form ─────────────────────────────────────────── */
.service-form-card {
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 14px 14px 10px;
  margin-bottom: 12px;
  background: var(--bg-subtle);
}

.service-form-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

/* ── Log viewer ──────────────────────────────────────────── */
.log-toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 16px;
  background: #161b22;
  border-bottom: 1px solid #30363d;
  flex-shrink: 0;
}

.log-toolbar-label {
  font-size: 12px;
  color: #8b949e;
}

.log-count {
  margin-left: auto;
  font-size: 11px;
  color: #484f58;
}

.log-output {
  flex: 1;
  overflow-y: auto;
  background: #0d1117;
  padding: 8px 12px;
  font-family: 'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.6;
}

.log-empty {
  color: #484f58;
  padding: 16px 0;
  text-align: center;
  font-size: 12px;
}

.log-line {
  display: flex;
  gap: 10px;
  padding: 1px 0;
  white-space: pre-wrap;
  word-break: break-all;
}

.log-line.stdout .log-msg { color: #c9d1d9; }
.log-line.stderr .log-msg { color: #ff7b72; }

.log-ts {
  color: #484f58;
  flex-shrink: 0;
  user-select: none;
  font-size: 11px;
  padding-top: 1px;
}

.log-msg {
  flex: 1;
}

.log-search-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 16px;
  background: #1c2128;
  border-bottom: 1px solid #30363d;
  flex-shrink: 0;
}

.log-search-input {
  width: 220px;
}

.log-search-count {
  font-size: 11px;
  color: #8b949e;
  min-width: 70px;
  text-align: center;
}

.log-msg mark.search-hit {
  background: rgba(187, 128, 9, 0.45);
  color: inherit;
  border-radius: 2px;
}

.log-msg mark.search-current {
  background: #e3b341;
  color: #0d1117;
  outline: 1px solid #f2cc60;
}

/* ── Deploy target picker ──────────────────────────────────── */
.deploy-target-option {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px 14px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.deploy-target-option:hover {
  border-color: var(--border-color-strong);
}

.deploy-target-option.active {
  border-color: #1677ff;
  background: var(--bg-selected-light);
}

.img-picker-avatar {
  width: 22px;
  height: 22px;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  font-weight: 700;
  color: #fff;
  font-family: 'SFMono-Regular', Consolas, monospace;
  flex-shrink: 0;
}
</style>
