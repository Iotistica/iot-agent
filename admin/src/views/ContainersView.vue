<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
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
  SearchOutlined,
  RocketOutlined,
  EllipsisOutlined,
  DownOutlined,
  EyeOutlined,
  BarsOutlined,
} from '@ant-design/icons-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import { containersApi, templatesApi } from '@/api/containers'
import type { ContainerApp, ContainerService, AppTemplate } from '@/api/containers'
import { useDockerStatus } from '@/composables/useDockerStatus'

const { dockerAvailable } = useDockerStatus()

// ── State ─────────────────────────────────────────────────────────────────────

const apps = ref<ContainerApp[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const actionInFlight = ref<Record<string, boolean>>({})
const searchQuery = ref('')
const viewMode = ref<'grid' | 'list'>('grid')
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

onMounted(() => { load(); startRefresh() })
onUnmounted(() => { stopRefresh(); if (logEs) { logEs.close(); logEs = null } })

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

// ── Status helpers ─────────────────────────────────────────────────────────────

type RunState = 'running' | 'stopped' | 'error' | 'creating' | 'unknown'

function resolveState(svc: ContainerService): RunState {
  // status can be a ServiceStatus object OR a raw Docker string ("running", "exited", etc.)
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

const CATEGORY_COLOR: Record<string, string> = {
  Automation:   'orange',
  Monitoring:   'blue',
  'Time Series':'purple',
  MQTT:         'cyan',
  Management:   'geekblue',
  'IoT Platform':'green',
  Database:     'red',
  AI:           'volcano',
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

function handleAppMenu(key: string, app: ContainerApp) {
  if (key === 'edit') openAppDetails(apps.value.find(item => item.appId === app.appId) ?? app)
  if (key === 'toggle') toggleApp(app.appId)
  if (key === 'delete') confirmRemoveApp(app)
}

function handleAppMenuClick(event: { key: string | number }, app: ContainerApp) {
  handleAppMenu(String(event.key), app)
}

function handleServiceMenu(key: string, app: ContainerApp, svc: ContainerService) {
  if (key === 'details') openServiceDetails(app, svc)
  if (key === 'logs') openLogs(app, svc)
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
    title: `Remove "${app.appName}"?`,
    content: 'All services in this application will be stopped and removed.',
    okType: 'danger',
    okText: 'Remove',
    async onOk() {
      try {
        await containersApi.remove(app.appId)
        message.success(`${app.appName} removed`)
        await load()
      } catch (e: unknown) {
        message.error((e as any)?.message ?? 'Remove failed')
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

function openAddService(app: ContainerApp) {
  addSvcTargetApp.value = app
  addSvcForm.value = emptyService()
  addSvcDrawerOpen.value = true
}

async function submitAddService() {
  const app = addSvcTargetApp.value
  if (!app) return
  if (!addSvcForm.value.serviceName.trim()) { message.error('Service name is required'); return }
  if (!addSvcForm.value.image.trim()) { message.error('Docker image is required'); return }

  const ports = parseLines(addSvcForm.value.ports)
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
    ports: formatLines(c.ports),
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

  const ports = parseLines(editSvcForm.value.ports)
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
  logDrawerOpen.value = true
  connectLogs(app.appId, svc.serviceName)
}

function onLogDrawerClose() {
  if (logEs) { logEs.close(); logEs = null }
}

function toggleFollow() {
  if (!logApp.value || !logSvc.value) return
  connectLogs(logApp.value.appId, logSvc.value.serviceName)
}

watch(logLines, () => {
  if (logAutoScroll.value) nextTick(() => {
    if (logOutputEl.value) logOutputEl.value.scrollTop = logOutputEl.value.scrollHeight
  })
}, { deep: false })

// ── Marketplace modal ─────────────────────────────────────────────────────────

const marketOpen = ref(false)
const marketTemplates = ref<AppTemplate[]>([])
const marketCategories = ref<string[]>(['All'])
const marketCategory = ref('All')
const marketSearch = ref('')
const marketLoading = ref(false)

const filteredTemplates = computed(() => {
  return marketTemplates.value.filter(t => {
    const matchCat = marketCategory.value === 'All' || t.category === marketCategory.value
    const q = marketSearch.value.toLowerCase()
    const matchQ = !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.category.toLowerCase().includes(q)
    return matchCat && matchQ
  })
})

async function openMarketplace() {
  marketOpen.value = true
  if (marketTemplates.value.length > 0) return
  marketLoading.value = true
  try {
    const data = await templatesApi.getAll()
    marketTemplates.value = data.templates
    marketCategories.value = data.categories
  } catch {
    // non-fatal
  } finally {
    marketLoading.value = false
  }
}

// ── Deploy target picker (marketplace) ───────────────────────────────────────

const deployTargetOpen = ref(false)
const deployTargetTpl = ref<AppTemplate | null>(null)
const deployTargetMode = ref<'new' | 'existing'>('new')
const deployTargetAppId = ref<number | null>(null)
const deployTargetBusy = ref(false)

function deployTemplate(tpl: AppTemplate) {
  if (apps.value.length === 0) {
    deployTemplateAsNewApp(tpl)
    return
  }
  deployTargetTpl.value = tpl
  deployTargetMode.value = 'new'
  deployTargetAppId.value = apps.value[0]?.appId ?? null
  deployTargetOpen.value = true
}

function deployTemplateAsNewApp(tpl: AppTemplate) {
  marketOpen.value = false
  deployTargetOpen.value = false
  appName.value = tpl.appName
  services.value = tpl.services.map(s => ({
    ...emptyService(),
    serviceName: s.serviceName,
    image: s.image,
    ports: (s.ports ?? []).join('\n'),
    volumes: (s.volumes ?? []).join('\n'),
    envRows: envToRows(s.environment),
    restart: s.restart ?? 'unless-stopped',
  }))
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
    for (const s of tpl.services) {
      const ports = s.ports ?? []
      const volumes = s.volumes ?? []
      await containersApi.addService(targetAppId, {
        serviceName: s.serviceName,
        imageName: s.image,
        state: 'running',
        config: {
          image: s.image,
          ...(ports.length ? { ports } : {}),
          ...(s.environment && Object.keys(s.environment).length ? { environment: s.environment } : {}),
          ...(volumes.length ? { volumes } : {}),
          restart: s.restart ?? 'unless-stopped',
        },
      })
    }
    message.success(`${tpl.name} added to ${apps.value.find(a => a.appId === targetAppId)?.appName ?? 'app'}`)
  } catch (e: unknown) {
    message.error((e as any)?.message ?? 'Failed to add services')
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
  ports: string
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
    serviceName: '', image: '', ports: '', envRows: [], volumes: '', restart: 'unless-stopped',
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

function rowsToEnv(rows: { name: string; value: string }[]): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const k = row.name.trim()
    if (k) out[k] = row.value
  }
  return Object.keys(out).length ? out : undefined
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
        const ports = parseLines(svc.ports)
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
      <div class="header-actions">
        <a-button :loading="loading" @click="load"><template #icon><ReloadOutlined /></template>Refresh</a-button>
        <a-button :disabled="!dockerAvailable" @click="openMarketplace"><template #icon><ShopOutlined /></template>Marketplace</a-button>
        <a-button type="primary" :disabled="!dockerAvailable" @click="openDeploy"><template #icon><PlusOutlined /></template>Add Application</a-button>
      </div>
    </div>

    <div class="summary-toolbar">
      <div class="summary-stats" aria-label="Application summary">
        <span class="summary-stat"><strong>{{ apps.length }}</strong> apps</span>
        <span class="summary-stat"><strong>{{ totalServices }}</strong> services</span>
        <span class="summary-stat status-running"><a-badge status="success" /><strong>{{ totalRunning }}</strong> running</span>
        <span class="summary-stat status-stopped"><a-badge status="default" /><strong>{{ totalStopped }}</strong> stopped</span>
      </div>
      <div class="summary-controls">
        <a-input
          v-model:value="searchQuery"
          allow-clear
          class="app-search"
          placeholder="Search applications or services"
          aria-label="Search applications or services"
        >
          <template #prefix><SearchOutlined /></template>
        </a-input>
        <a-radio-group v-model:value="viewMode" button-style="solid" aria-label="Application view">
          <a-radio-button value="grid" aria-label="Grid view"><AppstoreOutlined /></a-radio-button>
          <a-radio-button value="list" aria-label="List view"><BarsOutlined /></a-radio-button>
        </a-radio-group>
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

    <div v-else class="app-grid" :class="{ 'app-grid--list': viewMode === 'list' }">
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
            <a-dropdown :trigger="['click']">
              <a-button type="text" class="icon-menu-button" aria-label="Application actions" title="Application actions">
                <EllipsisOutlined />
              </a-button>
              <template #overlay>
                <a-menu @click="handleAppMenuClick($event, app)">
                  <a-menu-item key="edit"><EditOutlined /> Edit application</a-menu-item>
                  <a-menu-divider />
                  <a-menu-item key="delete" danger><DeleteOutlined /> Delete application</a-menu-item>
                </a-menu>
              </template>
            </a-dropdown>
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
            <span class="service-state-dot" :class="`state-${resolveState(svc)}`" :aria-label="STATUS_LABEL[resolveState(svc)]" />
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
            <a-tag :color="STATUS_COLOR[resolveState(svc)]" class="service-status">
              {{ STATUS_LABEL[resolveState(svc)] }}
            </a-tag>
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
              <a-tooltip title="View service details">
                <a-button size="small" aria-label="View service details" @click="openServiceDetails(fullApp(app), svc)">
                  <template #icon><EyeOutlined /></template>
                </a-button>
              </a-tooltip>
              <a-dropdown :trigger="['click']">
                <a-button size="small" aria-label="Service actions" title="Service actions">
                  <template #icon><EllipsisOutlined /></template>
                </a-button>
                <template #overlay>
                  <a-menu @click="handleServiceMenuClick($event, fullApp(app), svc)">
                    <a-menu-item key="details"><EyeOutlined /> View details</a-menu-item>
                    <a-menu-item key="logs"><FileTextOutlined /> View logs</a-menu-item>
                    <a-menu-item key="edit" :disabled="isServiceBusy(app.appId, svc.serviceName)"><EditOutlined /> Edit configuration</a-menu-item>
                    <a-menu-item key="restart" :disabled="isServiceBusy(app.appId, svc.serviceName)"><ReloadOutlined /> Restart</a-menu-item>
                    <a-menu-divider />
                    <a-menu-item key="delete" danger :disabled="isServiceBusy(app.appId, svc.serviceName)"><DeleteOutlined /> Delete service</a-menu-item>
                  </a-menu>
                </template>
              </a-dropdown>
            </div>
          </div>
          <div class="card-footer">
            <a-button size="small" type="dashed" :disabled="!dockerAvailable" @click="openAddService(fullApp(app))">
              <template #icon><PlusOutlined /></template>
              Add Service
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
        <a-form-item label="Service name" required>
          <a-input v-model:value="addSvcForm.serviceName" placeholder="e.g. redis, worker" />
        </a-form-item>
        <a-form-item label="Docker image" required>
          <a-input v-model:value="addSvcForm.image" placeholder="redis:7, myregistry/app:latest" style="font-family: monospace; font-size: 12px" />
        </a-form-item>
        <a-form-item label="Port mappings">
          <a-textarea v-model:value="addSvcForm.ports" placeholder="6379:6379&#10;8080:80" :rows="2" />
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px">One per line — host:container</div>
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
          <a-textarea v-model:value="editSvcForm.ports" placeholder="6379:6379&#10;8080:80" :rows="2" />
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px">One per line — host:container</div>
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
        <div style="display: flex; justify-content: flex-end; gap: 8px">
          <a-button @click="appDetailsOpen = false">Cancel</a-button>
          <a-button type="primary" :loading="appDetailsSaving" @click="saveAppDetails">
            Save Changes
          </a-button>
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
            <a-textarea
              v-model:value="svc.ports"
              placeholder="8080:80&#10;8443:443"
              :rows="2"
            />
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px">One per line — host:container</div>
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
              <template v-if="svc.healthcheckType === 'http'">
                <div style="display: flex; gap: 12px">
                  <a-form-item label="Path" style="flex: 2">
                    <a-input v-model:value="svc.healthcheckPath" placeholder="/health" />
                  </a-form-item>
                  <a-form-item label="Port" style="flex: 1">
                    <a-input-number v-model:value="svc.healthcheckPort" :min="1" :max="65535" style="width: 100%" placeholder="8080" />
                  </a-form-item>
                </div>
              </template>
              <template v-if="svc.healthcheckType === 'tcp'">
                <a-form-item label="Port">
                  <a-input-number v-model:value="svc.healthcheckPort" :min="1" :max="65535" style="width: 100%" placeholder="8080" />
                </a-form-item>
              </template>
              <template v-if="svc.healthcheckType === 'exec'">
                <a-form-item label="Command">
                  <a-input v-model:value="svc.healthcheckCommand" placeholder="curl -f http://localhost/health || exit 1" style="font-family: monospace; font-size: 12px" />
                </a-form-item>
              </template>
              <template v-if="svc.healthcheckType !== 'none'">
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
              </template>
            </a-collapse-panel>
          </a-collapse>
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

      <!-- Search bar -->
      <div style="padding: 16px 20px 0; flex-shrink: 0">
        <a-input
          v-model:value="marketSearch"
          placeholder="Search apps…"
          allow-clear
          size="large"
        >
          <template #prefix><SearchOutlined style="color: var(--text-placeholder)" /></template>
        </a-input>
      </div>

      <!-- Category tabs -->
      <div style="padding: 0 20px; flex-shrink: 0; border-bottom: 1px solid var(--border-color); margin-top: 12px">
        <a-tabs v-model:activeKey="marketCategory" size="small" :tab-bar-style="{ marginBottom: 0 }">
          <a-tab-pane v-for="cat in marketCategories" :key="cat" :tab="cat" />
        </a-tabs>
      </div>

      <!-- Cards -->
      <div style="flex: 1; overflow-y: auto; padding: 20px">
        <a-spin :spinning="marketLoading">
          <div v-if="filteredTemplates.length === 0 && !marketLoading" style="text-align: center; padding: 48px 0; color: var(--text-placeholder)">
            No apps found
          </div>
          <div class="market-grid">
            <div
              v-for="tpl in filteredTemplates"
              :key="tpl.id"
              class="market-card"
              @click="deployTemplate(tpl)"
            >
              <div class="market-card-top">
                <div
                  class="market-avatar"
                  :style="{ background: tpl.color }"
                >{{ tpl.letter }}</div>
                <div class="market-meta">
                  <div class="market-name">{{ tpl.name }}</div>
                  <a-tag :color="CATEGORY_COLOR[tpl.category] ?? 'default'" style="font-size: 11px; line-height: 18px; padding: 0 6px; margin: 0">
                    {{ tpl.category }}
                  </a-tag>
                </div>
              </div>
              <div class="market-desc">{{ tpl.description }}</div>
              <div class="market-footer">
                <span class="market-image">{{ tpl.services[0]?.image }}</span>
                <a-button type="primary" size="small" class="market-deploy-btn">
                  <template #icon><RocketOutlined /></template>
                  Deploy
                </a-button>
              </div>
            </div>
          </div>
        </a-spin>
      </div>
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
        {{ deployTargetTpl?.services.length === 1 ? '1 service' : `${deployTargetTpl?.services.length} services` }}
        will be added: <span style="font-family: monospace">{{ deployTargetTpl?.services.map(s => s.serviceName).join(', ') }}</span>
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
      :title="`Logs — ${logSvc?.serviceName ?? ''}`"
      width="720"
      :body-style="{ padding: 0, display: 'flex', flexDirection: 'column', height: '100%' }"
      @close="onLogDrawerClose"
    >
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
          <span class="log-msg">{{ line.msg }}</span>
        </div>
      </div>
    </a-drawer>

  </AppLayout>
</template>

<style scoped>
.heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
.heading p { color: var(--text-tertiary); margin: 0; }
.header-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.summary-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.summary-stats, .summary-controls { display: flex; align-items: center; gap: 12px; }
.summary-stat { display: inline-flex; align-items: center; gap: 5px; color: var(--text-tertiary); font-size: 12px; white-space: nowrap; }
.summary-stat strong { color: var(--text-primary); font-weight: 600; }
.summary-controls { min-width: 0; }
.app-search { width: 260px; }
.search-empty { margin: 44px 0; }
.loading-card { padding: 18px; }
/* ── Card grid ───────────────────────────────────────────── */
.app-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
  gap: 16px;
  align-items: start;
}
.app-grid--list { grid-template-columns: 1fr; }

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
  grid-template-columns: 8px minmax(120px, 1fr) minmax(0, auto) auto auto;
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
.no-services { padding: 14px; font-size: 12px; color: var(--text-placeholder); text-align: center; }
.card-footer { padding: 8px 14px 0; }

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
  .summary-toolbar { align-items: stretch; flex-direction: column; }
  .summary-stats { flex-wrap: wrap; gap: 8px 14px; }
  .summary-controls { width: 100%; }
  .app-search { flex: 1; width: auto; }
  .app-grid { grid-template-columns: minmax(0, 1fr); }
}

@media (max-width: 480px) {
  .header-actions { width: 100%; }
  .header-actions :deep(.ant-btn) { flex: 1; }
  .service-row { grid-template-columns: 8px minmax(0, 1fr) auto; gap: 8px; padding: 9px 10px; }
  .service-status { grid-column: 3; grid-row: 1; }
  .service-ports { grid-column: 2; grid-row: 2; }
  .svc-controls { grid-column: 3; grid-row: 2; }
  .svc-controls :deep(.ant-btn) { padding-inline: 6px; }
  .svc-controls :deep(.ant-btn > span:not(.anticon)) { font-size: 11px; }
  .app-card-actions { gap: 0; }
  .app-status { display: none; }
  .environment-row { align-items: flex-start; flex-direction: column; gap: 4px; }
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

/* ── Marketplace ─────────────────────────────────────────── */
.market-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 14px;
}

.market-card {
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 16px;
  background: var(--bg-container);
  display: flex;
  flex-direction: column;
  gap: 10px;
  cursor: pointer;
  transition: box-shadow 0.18s, border-color 0.18s, transform 0.12s;
}

.market-card:hover {
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
  border-color: #1677ff;
  transform: translateY(-1px);
}

.market-card-top {
  display: flex;
  align-items: center;
  gap: 12px;
}

.market-avatar {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  letter-spacing: 0.5px;
  flex-shrink: 0;
  font-family: 'SFMono-Regular', Consolas, monospace;
}

.market-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.market-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-heading);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.market-desc {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
  flex: 1;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.market-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 2px;
}

.market-image {
  font-size: 10px;
  color: var(--text-muted);
  font-family: monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.market-deploy-btn {
  flex-shrink: 0;
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
</style>
