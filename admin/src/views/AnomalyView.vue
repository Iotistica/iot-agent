<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { message } from 'ant-design-vue'
import {
  ReloadOutlined,
  DeleteOutlined,
  PlusOutlined,
  SaveOutlined,
  SafetyCertificateOutlined,
  BellOutlined,
  DatabaseOutlined,
  SearchOutlined,
  QuestionCircleOutlined,
  BranchesOutlined,
} from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import SettingsSection from '@/components/settings/SettingsSection.vue'
import SettingsField from '@/components/settings/SettingsField.vue'
import { useProStatus } from '@/composables/useProStatus'
import { useAuth } from '@/composables/useAuth'

const { proInstalled } = useProStatus()
const { hasRole } = useAuth()
import { methodColor } from '@/utils/protocol'
import { anomalyApi, RESOLUTION_REASON_LABELS, type BadActor, type ResolutionReason, type SchemaDriftBaselineRow } from '@/api/anomaly'
import { client as apiClient } from '@/api/client'
import { destinationsApi } from '@/api/destinations'
import { sourcesApi } from '@/api/sources'
import { BUILTIN_ANOMALY_TEMPLATES, type BuiltinAnomalyTemplate } from '@/data/anomalyTemplates'
import type {
  AnomalyBaseline,
  AnomalyConfig,
  AnomalyMetricConfig,
  AnomalyRuleTemplate,
  DetectionMethod,
  Destination,
  EdgeAnomalyEvent,
  EdgeAnomalyIncident,
  EdgeAnomalyAlert,
} from '@/types'

// ── Shared ────────────────────────────────────────────────────────────────────
const activeTab = ref('incidents')

const SEVERITY_TAG_COLOR: Record<string, string> = {
  critical: 'red',
  warning: 'orange',
  info: 'blue',
}

// Strips every embedded "<uuid>_" occurrence from free-text strings (e.g. alert messages).
const GUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_/gi
function stripGuids(text: string): string {
  return text ? text.replace(GUID_ANYWHERE, '') : text
}

function fmtTs(ms: number | string): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString()
}

function fmtNum(n: number | null | undefined, decimals = 3): string {
  if (n == null || isNaN(n)) return '—'
  return n.toFixed(decimals)
}

// Generic debounce keyed by name, so independent debounced actions (one per
// tab's live-filter) don't clobber each other's pending timers.
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
function debounce(key: string, fn: () => void, delayMs = 300) {
  const existing = debounceTimers.get(key)
  if (existing) clearTimeout(existing)
  debounceTimers.set(key, setTimeout(fn, delayMs))
}

// Only one tab is visible at a time, so a single shared interval covers
// "auto-refresh whichever tab is active" — this replaces manual reload buttons.
let tabRefreshTimer: ReturnType<typeof setInterval> | null = null
function startTabAutoRefresh(loadFn: () => void, loadingRef: { value: boolean }, intervalMs = 5000) {
  stopTabAutoRefresh()
  tabRefreshTimer = setInterval(() => {
    if (!loadingRef.value) loadFn()
  }, intervalMs)
}
function stopTabAutoRefresh() {
  if (tabRefreshTimer) {
    clearInterval(tabRefreshTimer)
    tabRefreshTimer = null
  }
}

// ── Warm-up countdown ────────────────────────────────────────────────────────
// Global, agent-uptime-relative alert suppression (default 15 min after agent
// start) — independent of any single metric's baseline/buffer state, so it
// needs its own indicator rather than piggybacking on the Baselines tab.
// Fetched once (absolute end time), then ticks locally every second so the
// countdown is smooth without re-polling the server every second.
const warmupRemainingMs = ref<number | null>(null)
let warmupEndsAt: number | null = null
let warmupTimer: ReturnType<typeof setInterval> | null = null

const warmupCountdownLabel = computed(() => {
  if (!warmupRemainingMs.value) return ''
  const totalSeconds = Math.ceil(warmupRemainingMs.value / 1000)
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
})

function stopWarmupCountdown() {
  if (warmupTimer) {
    clearInterval(warmupTimer)
    warmupTimer = null
  }
}

async function loadWarmupStatus() {
  try {
    const { stats } = await anomalyApi.getStats()
    const remaining = stats.warmupRemainingMs ?? 0
    if (remaining <= 0) {
      warmupRemainingMs.value = null
      stopWarmupCountdown()
      return
    }
    warmupEndsAt = Date.now() + remaining
    warmupRemainingMs.value = remaining
    stopWarmupCountdown()
    warmupTimer = setInterval(() => {
      const left = Math.max(0, (warmupEndsAt ?? 0) - Date.now())
      warmupRemainingMs.value = left > 0 ? left : null
      if (left <= 0) stopWarmupCountdown()
    }, 1000)
  } catch {
    // non-fatal — banner just won't show
  }
}

// ── Edge: Events ──────────────────────────────────────────────────────────────
const edgeEvents = ref<EdgeAnomalyEvent[]>([])
const edgeEventsTotal = ref(0)
const edgeEventsLoading = ref(false)
const edgeEventsSeverity = ref('')
const edgeEventsPage = ref(1)
const PAGE_SIZE = 50

const edgeEventColumns = [
  { title: 'Severity', key: 'severity', width: 100 },
  { title: 'Metric', key: 'metric', ellipsis: true },
  { title: 'Device', key: 'device_name', width: 160, ellipsis: true },
  { title: 'Value', key: 'value', width: 90 },
  { title: 'Score', key: 'score', width: 80 },
  { title: 'Conf', key: 'conf', width: 75 },
  { title: 'Consecutive', key: 'consec', width: 90 },
  { title: 'Time', key: 'time', width: 160 },
]

async function loadEdgeEvents() {
  edgeEventsLoading.value = true
  await ensureEndpointMaps()
  try {
    const r = await anomalyApi.getEdgeEvents({
      severity: edgeEventsSeverity.value || undefined,
      limit: PAGE_SIZE,
      offset: (edgeEventsPage.value - 1) * PAGE_SIZE,
    })
    edgeEvents.value = r.events
    edgeEventsTotal.value = r.total
  } catch { /* non-fatal */ } finally {
    edgeEventsLoading.value = false
  }
}

// ── Edge: Incidents ───────────────────────────────────────────────────────────
const edgeIncidents = ref<EdgeAnomalyIncident[]>([])
const edgeIncidentsTotal = ref(0)
const edgeIncidentsLoading = ref(false)
const edgeIncidentsStatus = ref('')
const edgeIncidentsPage = ref(1)
const resolvingId = ref<string | null>(null)

const edgeIncidentColumns = [
  { title: 'Severity', key: 'severity', width: 95 },
  { title: 'Metric', key: 'metric', ellipsis: true },
  { title: 'Device', key: 'device_name', width: 160, ellipsis: true },
  { title: 'Status', key: 'status', width: 90 },
  { title: 'Events', dataIndex: 'event_count', key: 'event_count', width: 70 },
  { title: 'Score', key: 'score', width: 80 },
  { title: 'First seen', key: 'first_seen', width: 155 },
  { title: 'Last seen', key: 'last_seen', width: 155 },
  { title: '', key: 'actions', width: 90, fixed: 'right' },
]

const INCIDENT_STATUS_COLOR: Record<string, string> = { open: 'orange', active: 'red', resolved: 'green' }

async function loadEdgeIncidents() {
  edgeIncidentsLoading.value = true
  await ensureEndpointMaps()
  try {
    const r = await anomalyApi.getEdgeIncidents({
      status: edgeIncidentsStatus.value || undefined,
      limit: PAGE_SIZE,
      offset: (edgeIncidentsPage.value - 1) * PAGE_SIZE,
    })
    edgeIncidents.value = r.incidents
    edgeIncidentsTotal.value = r.total
  } catch { /* non-fatal */ } finally {
    edgeIncidentsLoading.value = false
  }
}

// Reason is captured (not just a bare confirm) so noisy rules can eventually
// be found by false-positive rate, not just raw incident count — see the
// Bad Actors panel on the Rules tab. Kept to a single required dropdown plus
// optional free-text notes, not a full form, so resolving stays low-friction.
const resolveModalOpen = ref(false)
const resolveModalIncident = ref<EdgeAnomalyIncident | null>(null)
const resolveModalReason = ref<ResolutionReason | undefined>(undefined)
const resolveModalNotes = ref('')

function openResolveModal(incident: EdgeAnomalyIncident) {
  resolveModalIncident.value = incident
  resolveModalReason.value = undefined
  resolveModalNotes.value = ''
  resolveModalOpen.value = true
}

async function confirmResolve() {
  const incident = resolveModalIncident.value
  if (!incident || !resolveModalReason.value) return
  resolvingId.value = incident.incident_id
  try {
    await anomalyApi.resolveIncident(incident.incident_id, resolveModalReason.value, resolveModalNotes.value.trim() || undefined)
    message.success('Incident resolved')
    resolveModalOpen.value = false
    loadEdgeIncidents()
  } catch (err: unknown) {
    message.error((err as { message?: string })?.message ?? 'Failed to resolve')
  } finally {
    resolvingId.value = null
  }
}

// ── Edge: Alerts ──────────────────────────────────────────────────────────────
const edgeAlerts = ref<EdgeAnomalyAlert[]>([])
const edgeAlertsTotal = ref(0)
const edgeAlertsLoading = ref(false)
const edgeAlertsPage = ref(1)

const edgeAlertColumns = [
  { title: 'Severity', key: 'severity', width: 100 },
  { title: 'Metric', key: 'metric', ellipsis: true },
  { title: 'Device', key: 'device_name', width: 160, ellipsis: true },
  { title: 'Score', key: 'score', width: 80 },
  { title: 'Message', dataIndex: 'message', key: 'message', width: 500 },
  { title: 'Time', key: 'time', width: 160 },
]

async function loadEdgeAlerts() {
  edgeAlertsLoading.value = true
  await ensureEndpointMaps()
  try {
    const r = await anomalyApi.getEdgeAlerts({ limit: PAGE_SIZE, offset: (edgeAlertsPage.value - 1) * PAGE_SIZE })
    edgeAlerts.value = r.alerts
    edgeAlertsTotal.value = r.total
  } catch { /* non-fatal */ } finally {
    edgeAlertsLoading.value = false
  }
}

// ── Baselines tab ──────────────────────────────────────────────────────────────
// pendingWindowSize is set whenever a metric's buffer hasn't yet filled to its
// configured windowSize — on synthesized placeholder rows (no real baseline saved
// yet) AND on real baseline rows (saveBaselines() persists as soon as
// buffer.size >= minSamples, which is far below windowSize, so a "real" row can
// still be actively collecting). isSynthetic distinguishes the two: only true for
// placeholder rows with no calculated_at/time_slot of their own.
type BaselineRow = AnomalyBaseline & { pendingWindowSize?: number; isSynthetic?: boolean }
const baselines = ref<BaselineRow[]>([])
const baselinesTotal = ref(0)
const baselinesLoading = ref(false)
const baselinesMetric = ref('')
const baselinesPage = ref(1)

// Live-filter as you type instead of requiring Enter/a manual reload button —
// debounced so every keystroke doesn't fire its own request.
watch(baselinesMetric, () => {
  debounce('baselines-filter', () => {
    baselinesPage.value = 1
    loadBaselines()
  })
})

const baselineColumns = [
  { title: 'Metric', key: 'metric', ellipsis: true },
  { title: 'Device', key: 'device_id', width: 160, ellipsis: true },
  { title: 'State', dataIndex: 'device_state', key: 'device_state', width: 100 },
  { title: 'Slot', dataIndex: 'time_slot', key: 'time_slot', width: 55 },
  { title: 'Mean', key: 'mean', width: 90 },
  { title: 'Std dev', key: 'std_dev', width: 90 },
  { title: 'Median', key: 'median', width: 90 },
  { title: 'MAD', key: 'mad', width: 90 },
  { title: 'Samples', dataIndex: 'sample_count', key: 'sample_count', width: 80 },
  { title: 'Calculated', key: 'calculated_at', width: 160 },
]

// Maps endpoint UUID → display name (for events/incidents/alerts/baselines metric prefix lookup)
const endpointsByUuid = ref<Map<string, string>>(new Map())
// Maps "endpointUuid::sanitizedPointName" → the raw protocol-native point name
// (BACnet objectName / OPC-UA browseName, e.g. "Space-Temp") as reported by the
// device, for tables that show the point name and would otherwise only have the
// sanitized identifier (lowercased, punctuation stripped) to display.
const pointRawNameByKey = ref<Map<string, string>>(new Map())
// Maps a bare sanitized point name (e.g. "ahu_1_rf_speed") → its owning
// device's display name. Anomaly rules are often saved using this bare,
// already-device-prefixed point name with no separate deviceName recorded on
// the rule itself, so this is how the Rules table recovers "which device is
// this rule actually for" without guessing from the name's word count.
const pointNameToDevice = ref<Map<string, string>>(new Map())

async function ensureEndpointMaps() {
  if (endpointsByUuid.value.size > 0) return
  try {
    const eps = await sourcesApi.getAll()
    const byUuid = new Map<string, string>()
    const rawNameByKey = new Map<string, string>()
    const deviceByPointName = new Map<string, string>()
    for (const ep of eps) {
      const displayName = (ep.metadata?.objectName as string | undefined) || ep.name
      byUuid.set(ep.uuid, displayName)

      for (const dp of (ep.data_points ?? []) as Array<Record<string, unknown>>) {
        const sanitizedName = dp?.name
        const rawName = (dp?.objectName ?? dp?.browseName) as string | undefined
        if (typeof sanitizedName === 'string' && typeof rawName === 'string' && rawName) {
          rawNameByKey.set(`${ep.uuid}::${sanitizedName}`, rawName)
        }
        if (typeof sanitizedName === 'string') {
          deviceByPointName.set(sanitizedName, displayName)
        }
      }
    }
    endpointsByUuid.value = byUuid
    pointRawNameByKey.value = rawNameByKey
    pointNameToDevice.value = deviceByPointName
  } catch { /* non-fatal */ }
}

// The rule's device, either explicitly recorded (record.deviceName) or
// recovered via the bare-point-name lookup above.
function ruleDeviceName(record: AnomalyMetricConfig): string | undefined {
  return record.deviceName || pointNameToDevice.value.get(record.name)
}

// Strips the resolved device's own name from the front of the rule name, the
// same "field carries the device prefix baked in" pattern schema drift has
// (see stripFieldDevicePrefix on the backend) — so Metric name doesn't repeat
// what the new Device column already shows. Falls back to the full name
// unchanged when no device could be resolved, rather than guessing.
function ruleMetricLeaf(record: AnomalyMetricConfig): string {
  const device = ruleDeviceName(record)
  if (!device) return record.name

  const prefix = `${device.toLowerCase().replace(/[\s-]+/g, '_')}_`
  return record.name.toLowerCase().startsWith(prefix) ? record.name.slice(prefix.length) : record.name
}

// The metric's own device UUID segment: metrics are named
// "{agentUuid}_{deviceUuid}_{bare_metric}" — the LAST UUID segment is the
// device's own endpoint UUID (the first is the agent-wide UUID, constant
// across every metric and never a useful lookup key on its own).
function extractDeviceUuid(metric: string): string | undefined {
  const uuidMatches = [...metric.matchAll(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_/gi)]
  return uuidMatches.at(-1)?.[1]
}

// Resolve device display name from metric name.
// For endpoint metrics (UUID-prefixed), the device name is the first segment(s) of the
// bare metric after stripping the UUID: "pioneer_gold_1_coil_temp" → "Pioneer Gold 1".
// We identify the device segment by finding where the last known single-word metric
// suffix starts, using the heuristic that device names come before the last two segments.
// Schema-drift device identifiers (e.g. "bms_gateway_5000_bc814573") are
// resolveDeviceId()'s normalized form of the raw BACnet device name, with
// "_{instance}_{8-hex-id}" appended for fleet-wide uniqueness across devices
// that share a display name (see the Pro schema-drift detector). Strip that
// suffix and title-case what's left so these read the same as other device
// labels instead of showing the raw internal identity.
const DRIFT_DEVICE_SUFFIX_RE = /_\d+_[0-9a-f]{8}$/i
const KNOWN_DEVICE_ACRONYMS = new Set(['ahu', 'vav', 'fcu', 'bms', 'hvac', 'rtu'])
function prettifyDriftDeviceId(id: string): string | undefined {
  const stripped = id.replace(DRIFT_DEVICE_SUFFIX_RE, '')
  if (stripped === id) return undefined // no match — not a schema-drift-style device id

  return stripped
    .split('_')
    .filter(Boolean)
    .map((p) => (KNOWN_DEVICE_ACRONYMS.has(p.toLowerCase()) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ')
}

function deviceNameFromMetric(metric: string, fallback: string): string {
  if (!metric) return fallback || '—'

  // Strip UUID prefix to get bare metric name
  const bare = metric.replace(UUID_PREFIX_RE, '')

  // If the bare name changed (i.e., there was a UUID prefix), it's an endpoint metric,
  // named "{agentUuid}_{deviceUuid}_{bare_metric}". Prefer the real device name
  // captured at discovery time (exact casing/format, e.g. "RTU-1") over a guessed
  // reconstruction — the LAST UUID segment is the device's own endpoint UUID, which
  // is what endpointsByUuid is keyed by (the first is the agent-wide UUID, constant
  // across every metric and never a useful lookup key on its own).
  if (bare !== metric) {
    const deviceUuid = extractDeviceUuid(metric)
    const sourceName = deviceUuid ? endpointsByUuid.value.get(deviceUuid) : undefined
    if (sourceName) return sourceName

    // Fallback: reconstruct a best-guess label from the metric's own segments
    // (e.g. "pioneer_gold_1_coil_temp" → "Pioneer Gold 1") when there's no real
    // device metadata to fall back on — everything except the last two
    // underscore-separated tokens (the metric leaf, e.g. "coil_temp").
    const parts = bare.split('_')
    if (parts.length > 2) {
      const deviceParts = parts.slice(0, parts.length - 2)
      const label = deviceParts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
      if (label) return label
    }
  }

  if (!fallback || fallback === 'unknown') return '—'
  if (fallback === 'system' || fallback === 'Agent System') return 'System'
  return prettifyDriftDeviceId(fallback) ?? fallback
}

// Complement of deviceNameFromMetric(): the metric's own leaf (last two
// underscore-separated segments, e.g. "space_temp") with the embedded device
// prefix stripped — for tables that already show a separate Device column, so
// the metric name doesn't redundantly repeat "rtu_1" that's shown right next to it.
// Schema-drift-originated metrics carry the detector's internal "reading:"/"key:"
// namespace tag (see SchemaDriftDetector.extractSchema) instead of a UUID prefix —
// strip that too so these rows read the same as the Schema Drift grid's Field column.
const DRIFT_FIELD_PREFIX_RE = /^(reading|key):/

function metricLeaf(metric: string, deviceName?: string): string {
  const driftStripped = metric.replace(DRIFT_FIELD_PREFIX_RE, '')
  if (driftStripped !== metric) {
    // BACnet (and possibly other protocols) build each reading's field name as
    // "{device}_{object}" before schema drift ever sees it — the device is
    // baked into the field, not tracked separately the way anomaly metrics
    // track it via a UUID key. Since Device already shows in its own column,
    // strip that same device base name from the front of the field here too.
    const deviceBase = deviceName?.replace(DRIFT_DEVICE_SUFFIX_RE, '').toLowerCase()
    if (deviceBase && deviceBase !== deviceName?.toLowerCase() && driftStripped.toLowerCase().startsWith(`${deviceBase}_`)) {
      return driftStripped.slice(deviceBase.length + 1)
    }
    return driftStripped
  }

  const bare = friendlyLabel(metric)
  if (bare === metric) return bare // no UUID prefix — not a device-scoped metric, nothing to trim

  const parts = bare.split('_')
  const leaf = parts.length > 2 ? parts.slice(-2).join('_') : bare

  // Prefer the true protocol-native point name (e.g. "Space-Temp") over the
  // sanitized leaf, when we have it on file for this exact device+point.
  const deviceUuid = extractDeviceUuid(metric)
  const rawName = deviceUuid ? pointRawNameByKey.value.get(`${deviceUuid}::${leaf}`) : undefined
  return rawName || leaf
}

async function loadBaselines() {
  baselinesLoading.value = true
  try {
    await ensureEndpointMaps()
    const filterText = baselinesMetric.value.trim().toLowerCase()
    const [r, progress, cfg] = await Promise.all([
      anomalyApi.getBaselines({ metric: baselinesMetric.value.trim() || undefined, limit: PAGE_SIZE }),
      // Only meaningful on page 1 — prepending in-progress rows to an arbitrary
      // later page would be confusing, so skip fetching/merging past page 1.
      baselinesPage.value === 1 ? anomalyApi.getBaselineProgress() : Promise.resolve([]),
      // Needed to list rules that haven't produced a single sample yet (see
      // notStartedRows below) — reuse the cached config if the Rules/Config tab
      // already loaded it, otherwise fetch it just for this.
      baselinesPage.value === 1 && !config.value ? anomalyApi.getConfig() : Promise.resolve(config.value),
    ])
    if (cfg) config.value = cfg

    const progressByKey = new Map(
      progress.map((p) => [`${p.metricName}::${p.deviceId}::${p.deviceState}`, p]),
    )

    // saveBaselines() persists a real row once buffer.size >= minSamples (default 5),
    // well before the buffer reaches windowSize — so a metric can already have a real
    // baseline row and still be actively collecting toward its full window. Annotate
    // those rows in place instead of treating "a row exists" as "done collecting",
    // otherwise the progress indicator disappears after the very first periodic save.
    const annotatedBaselines: BaselineRow[] = r.baselines.map((b) => {
      const key = `${b.metric}::${b.device_id}::${b.device_state}`
      const p = progressByKey.get(key)
      if (!p || p.bufferSize >= p.windowSize) return b
      return { ...b, sample_count: p.bufferSize, pendingWindowSize: p.windowSize }
    })

    const existingKeys = new Set(r.baselines.map((b) => `${b.metric}::${b.device_id}::${b.device_state}`))
    const pendingRows: BaselineRow[] = progress
      // <= not < : once the buffer fills, it stays visible ("ready, waiting to
      // save") until a real baseline row appears and dedupes it away, rather
      // than vanishing for the gap between filling up and the next periodic save.
      .filter((p) => p.bufferSize <= p.windowSize)
      .filter((p) => !existingKeys.has(`${p.metricName}::${p.deviceId}::${p.deviceState}`))
      .filter((p) => !filterText || p.metricName.toLowerCase().includes(filterText))
      .map((p) => ({
        metric: p.metricName,
        device_id: p.deviceId,
        device_state: p.deviceState,
        time_slot: -1,
        mean: null,
        std_dev: null,
        median: null,
        mad: null,
        sample_count: p.bufferSize,
        calculated_at: 0,
        pendingWindowSize: p.windowSize,
        isSynthetic: true,
      }))

    // A rule that hasn't received a single data point yet has no buffer at all, so
    // it's absent from both `r.baselines` and `progress` — nothing distinguishes
    // "just added, waiting for first reading" from "not configured". Synthesize a
    // 0-sample "Collecting" row straight from the rule config so a brand-new rule
    // shows up immediately instead of appearing to do nothing until data arrives.
    // Real rows are keyed by their canonical name ("{agentUuid}_{endpointUuid}_ahu_1_rf_speed")
    // while a legacy pre-qualified rule's config name is the bare form ("ahu_1_rf_speed") —
    // strip the UUID prefixes the same way the backend's getMetricConfig() does, or a rule
    // that already has real data keeps showing a duplicate "Collecting" ghost row forever.
    const metricNamesWithData = new Set([
      ...r.baselines.map((b) => canonicalBareMetricName(b.metric)),
      ...progress.map((p) => canonicalBareMetricName(p.metricName)),
    ])
    const notStartedRows: BaselineRow[] = (config.value?.metrics ?? [])
      .filter((m) => m.enabled)
      .filter((m) => !metricNamesWithData.has(m.name))
      .filter((m) => !filterText || m.name.toLowerCase().includes(filterText))
      .map((m) => ({
        metric: m.name,
        device_id: m.deviceName ?? '',
        device_state: 'unknown',
        time_slot: -1,
        mean: null,
        std_dev: null,
        median: null,
        mad: null,
        sample_count: 0,
        calculated_at: 0,
        pendingWindowSize: m.windowSize,
        isSynthetic: true,
      }))

    baselines.value = [...notStartedRows, ...pendingRows, ...annotatedBaselines]
    baselinesTotal.value = r.total + pendingRows.length + notStartedRows.length
  } catch { /* non-fatal */ } finally {
    baselinesLoading.value = false
  }
}

const clearingBaselines = ref(false)
const resetBaselinesModalOpen = ref(false)

async function clearAllBaselines() {
  clearingBaselines.value = true
  try {
    const { deleted } = await anomalyApi.clearBaselines()
    message.success(`Cleared ${deleted} baseline${deleted !== 1 ? 's' : ''}`)
    baselines.value = []
    baselinesTotal.value = 0
    resetBaselinesModalOpen.value = false
  } catch (err: unknown) {
    message.error((err as { message?: string })?.message ?? 'Clear failed')
  } finally {
    clearingBaselines.value = false
  }
}

// ── Schema Drift tab ─────────────────────────────────────────────────────────
// Flattened per-field view of the Pro schema drift detector's persisted state:
// established baseline fields alongside fields still accumulating toward
// promotion (see SchemaDriftDetector.handleNewField in iot-agent-pro).
const schemaDriftRows = ref<SchemaDriftBaselineRow[]>([])
const schemaDriftTotal = ref(0)
const schemaDriftLoading = ref(false)
const schemaDriftQuery = ref('')

watch(schemaDriftQuery, () => {
  debounce('schema-drift-filter', () => loadSchemaDriftBaselines())
})

// Matches SchemaDriftDetector's DEFAULT_OPTIONS.adaptivePromotionBatches/
// adaptivePromotionRatio — not currently exposed as per-protocol settings, so
// these are the real thresholds for every source today. Promotion requires
// BOTH: stableBatches >= BATCHES and presenceRatio >= RATIO.
const SCHEMA_DRIFT_PROMOTION_BATCHES = 50
const SCHEMA_DRIFT_PROMOTION_RATIO = 0.6

const schemaDriftColumns = [
  { title: 'Protocol', dataIndex: 'protocol', key: 'protocol', width: 120, ellipsis: true },
  { title: 'Device', key: 'device', width: 200, ellipsis: true },
  { title: 'Field', key: 'field', ellipsis: true },
  { title: 'Status', key: 'status', width: 130 },
  { title: 'Type', key: 'dominantType', width: 90 },
  { title: 'Updated', key: 'updatedAt', width: 160 },
]

async function loadSchemaDriftBaselines() {
  schemaDriftLoading.value = true
  try {
    const r = await anomalyApi.getSchemaDriftBaselines({ q: schemaDriftQuery.value.trim() || undefined })
    schemaDriftRows.value = r.baselines
    schemaDriftTotal.value = r.total
  } catch (err: unknown) {
    message.error((err as { message?: string })?.message ?? 'Failed to load schema drift baselines')
  } finally {
    schemaDriftLoading.value = false
  }
}

const clearingSchemaDrift = ref(false)
const resetSchemaDriftModalOpen = ref(false)

async function clearAllSchemaDriftBaselines() {
  clearingSchemaDrift.value = true
  try {
    const { deleted } = await anomalyApi.clearSchemaDriftBaselines()
    message.success(`Cleared ${deleted} schema-drift baseline${deleted !== 1 ? 's' : ''}`)
    schemaDriftRows.value = []
    schemaDriftTotal.value = 0
    resetSchemaDriftModalOpen.value = false
  } catch (err: unknown) {
    message.error((err as { message?: string })?.message ?? 'Clear failed')
  } finally {
    clearingSchemaDrift.value = false
  }
}

// ── Config tab ─────────────────────────────────────────────────────────────────
const config = ref<AnomalyConfig | null>(null)
const configLoading = ref(false)
const configSaving = ref(false)
const mqttDestinations = ref<Destination[]>([])

const metricDrawerOpen = ref(false)
const editingMetricIdx = ref<number | null>(null)
const metricForm = ref<AnomalyMetricConfig>(blankMetric())
const expectedMin = ref<number | null>(null)
const expectedMax = ref<number | null>(null)

// expected_range is a no-op detector without bounds — surface that before save, not just on submit.
const expectedRangeMissingBounds = computed(() =>
  metricForm.value.methods.includes('expected_range')
  && (expectedMin.value == null || expectedMax.value == null),
)

// ── Rule templates (built-in presets + custom saved templates) ─────────────────
const templateLibraryOpen = ref(false)
const customTemplates = ref<AnomalyRuleTemplate[]>([])
const customTemplatesLoaded = ref(false)
const templatesLoading = ref(false)
const templateSearch = ref('')
const saveTemplateModalOpen = ref(false)
const saveTemplateName = ref('')
const saveTemplateSaving = ref(false)

type TemplateListItem =
  | (BuiltinAnomalyTemplate & { builtin: true })
  | (AnomalyRuleTemplate & { builtin: false; category: 'My templates' })

async function loadTemplates() {
  templatesLoading.value = true
  try {
    customTemplates.value = await anomalyApi.getTemplates()
    customTemplatesLoaded.value = true
  } catch {
    // non-fatal
  } finally {
    templatesLoading.value = false
  }
}

const templateLibrary = computed<TemplateListItem[]>(() => {
  const builtins: TemplateListItem[] = BUILTIN_ANOMALY_TEMPLATES.map((t) => ({ ...t, builtin: true }))
  const custom: TemplateListItem[] = customTemplates.value.map((t) => ({
    ...t,
    builtin: false,
    category: 'My templates',
  }))
  return [...custom, ...builtins]
})

const templatesByCategory = computed(() => {
  const q = templateSearch.value.trim().toLowerCase()
  const filtered = q
    ? templateLibrary.value.filter((t) =>
        t.name.toLowerCase().includes(q) || (t.purpose ?? '').toLowerCase().includes(q),
      )
    : templateLibrary.value

  const groups = new Map<string, TemplateListItem[]>()
  for (const t of filtered) {
    const key = t.category ?? 'Other'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(t)
  }
  return groups
})

function openTemplateLibrary() {
  templateSearch.value = ''
  templateLibraryOpen.value = true
  if (!customTemplatesLoaded.value) loadTemplates()
}

function applyTemplate(template: TemplateListItem) {
  metricForm.value.methods = [...template.methods]
  metricForm.value.threshold = template.threshold

  if (template.builtin) {
    metricForm.value.windowSize = template.windowSize
    metricForm.value.minConfidence = template.minConfidence
    metricForm.value.cooldownMs = template.cooldownMs
    metricForm.value.seasonality = template.seasonality
    expectedMin.value = null
    expectedMax.value = null
  } else {
    metricForm.value.windowSize = template.window_size
    metricForm.value.minConfidence = template.min_confidence ?? 0.7
    metricForm.value.cooldownMs = template.cooldown_ms ?? 300_000
    metricForm.value.seasonality = template.seasonality ?? 'none'
    expectedMin.value = template.expected_range?.[0] ?? null
    expectedMax.value = template.expected_range?.[1] ?? null
  }

  templateLibraryOpen.value = false
  message.success(`Applied template "${template.name}"`)
}

function openSaveTemplateModal() {
  saveTemplateName.value = ''
  saveTemplateModalOpen.value = true
}

async function saveAsTemplate() {
  if (!saveTemplateName.value.trim()) {
    message.error('Template name is required')
    return
  }
  saveTemplateSaving.value = true
  try {
    await anomalyApi.createTemplate({
      name: saveTemplateName.value.trim(),
      category: null,
      purpose: null,
      methods: metricForm.value.methods,
      threshold: metricForm.value.threshold,
      window_size: metricForm.value.windowSize,
      min_confidence: metricForm.value.minConfidence ?? null,
      cooldown_ms: metricForm.value.cooldownMs ?? null,
      seasonality: metricForm.value.seasonality ?? null,
      expected_range: expectedMin.value != null && expectedMax.value != null
        ? [expectedMin.value, expectedMax.value]
        : null,
    })
    message.success('Template saved')
    saveTemplateModalOpen.value = false
    customTemplatesLoaded.value = false
    await loadTemplates()
  } catch (err: unknown) {
    message.error((err as { message?: string })?.message ?? 'Failed to save template')
  } finally {
    saveTemplateSaving.value = false
  }
}

async function deleteTemplate(uuid: string) {
  try {
    await anomalyApi.deleteTemplate(uuid)
    message.success('Template deleted')
    customTemplatesLoaded.value = false
    await loadTemplates()
  } catch (err: unknown) {
    message.error((err as { message?: string })?.message ?? 'Failed to delete template')
  }
}

const DETECTION_METHODS: DetectionMethod[] = [
  'zscore', 'mad', 'iqr', 'expected_range', 'rate_change', 'ewma', 'cusum', 'fusion',
]
const SEASONALITY_OPTIONS = ['none', 'day-night', 'hourly', 'weekly']

// ── Available metric suggestions ───────────────────────────────────────────
type MetricSuggestion = {
  name: string
  score?: number
  deviceState?: string
  unit?: string
  configured: boolean
  endpointName?: string
}
const metricSuggestions = ref<MetricSuggestion[]>([])
const metricSuggestionsLoading = ref(false)

async function loadMetricSuggestions() {
  metricSuggestionsLoading.value = true
  try {
    metricSuggestions.value = await anomalyApi.getMetrics()
  } catch {
    // non-fatal
  } finally {
    metricSuggestionsLoading.value = false
  }
}

// Strip all leading UUID prefixes from canonical metric names so they display readably.
// e.g. "UUID1_UUID2_pioneer_gold_1_coil_temp" → "pioneer_gold_1_coil_temp"
const UUID_PREFIX_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_/gi
function friendlyLabel(name: string | undefined | null): string {
  if (!name) return ''
  return name.replace(UUID_PREFIX_RE, '')
}

// Mirrors selectMetricConfig()'s fallback matching in the backend's metric-router.ts:
// a system metric's canonical key is "{agentUuid}_system_{name}" (e.g.
// "UUID_system_memory_percent"), a distinct pattern from the plain
// "{agentUuid}_{endpointUuid}_{name}" case friendlyLabel() already handles — it has an
// extra "system_" segment friendlyLabel leaves behind. Used only for matching a rule's
// bare config name against real baseline/progress keys (not for display — friendlyLabel
// stays the display-facing one), or a system-scoped rule's placeholder never dedupes
// away once real data exists, the same way ahu_1_rf_speed's rule name once didn't.
function canonicalBareMetricName(name: string): string {
  const systemMatch = name.match(/^[0-9a-f-]{36}_system_(.+)$/i)
  if (systemMatch) return systemMatch[1]
  return friendlyLabel(name)
}

// Build flat sorted list of metric suggestions for the autocomplete dropdown.
// Deduplicate by (endpointName, friendlyLabel) so the same metric from two
// different devices shows as two separate entries.
const metricAutocompleteOptions = computed(() => {
  const q = metricForm.value.name.toLowerCase()

  const seen = new Map<string, MetricSuggestion>()
  for (const s of metricSuggestions.value) {
    const friendly = friendlyLabel(s.name)
    if (!friendly.trim()) continue
    const key = `${s.endpointName ?? ''}|${friendly}`
    const existing = seen.get(key)
    if (!existing || (s.score ?? 0) > (existing.score ?? 0)) {
      seen.set(key, s)
    }
  }

  return Array.from(seen.entries())
    .filter(([, s]) => {
      const friendly = friendlyLabel(s.name)
      const label = s.endpointName ? `${s.endpointName} ${friendly}` : friendly
      return !q || label.toLowerCase().includes(q)
    })
    .sort(([, a], [, b]) => {
      const fa = friendlyLabel(a.name)
      const fb = friendlyLabel(b.name)
      return fa.localeCompare(fb) || (a.endpointName ?? '').localeCompare(b.endpointName ?? '')
    })
    .map(([, s]) => {
      const friendly = friendlyLabel(s.name)
      return {
        value: friendly,
        label: s.endpointName ? `${friendly} · ${s.endpointName}` : friendly,
        suggestion: s,
      }
    })
})

function blankMetric(): AnomalyMetricConfig {
  return {
    name: '',
    enabled: true,
    methods: ['mad'],
    threshold: 3.0,
    windowSize: 120,
    minConfidence: 0.7,
    cooldownMs: 300_000,
    seasonality: 'none',
  }
}

const metricColumns: TableColumnType<AnomalyMetricConfig>[] = [
  { title: 'Metric name', key: 'name', ellipsis: true },
  { title: 'Device', key: 'device', width: 160, ellipsis: true },
  { title: 'Methods', key: 'methods', ellipsis: true },
  { title: 'Threshold', dataIndex: 'threshold', key: 'threshold', width: 100 },
  { title: 'Window', dataIndex: 'windowSize', key: 'windowSize', width: 90 },
  { title: 'Seasonality', key: 'seasonality', width: 110 },
  { title: 'Enabled', key: 'enabled', width: 80 },
  { title: '', key: 'actions', width: 100, fixed: 'right' },
]

async function loadConfig() {
  configLoading.value = true
  try {
    const [cfg, dests] = await Promise.all([
      anomalyApi.getConfig(),
      destinationsApi.getAll(),
    ])
    config.value = cfg
    mqttDestinations.value = dests.filter((d) => d.type === 'mqtt')
  } catch {
    // non-fatal
  } finally {
    configLoading.value = false
  }
}

// Matches the built-in defaults in the anomaly detection engine
// (loadConfigFromTargetState in iot-agent-pro's anomaly/utils.ts) — only the
// detection-tuning fields, not alert routing or retention.
function resetDetectionDefaults() {
  if (!config.value) return
  config.value.sensitivity = 5
  config.value.warmupPeriodMs = 900_000
  config.value.alerts.minConfidence = 0.7
  config.value.alerts.cooldownMs = 300_000
  config.value.alerts.maxQueueSize = 1000
}

async function saveConfig() {
  if (!config.value) return
  configSaving.value = true
  try {
    config.value = await anomalyApi.updateConfig(config.value)
    message.success('Configuration saved')
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Save failed')
  } finally {
    configSaving.value = false
  }
}

// ── Schema Drift settings ────────────────────────────────────────────────────

type DriftAlertType = 'new-field' | 'missing-field' | 'type-drift' | 'rename-candidate'

interface DriftOptions {
  enabled?: boolean
  warmupBatches?: number
  consecutiveMissingThreshold?: number
  alertCooldownMs?: number
  minFieldPresenceRatio?: number
  adaptiveRetireBatches?: number
  alertOnDriftTypes?: DriftAlertType[]
}

const DRIFT_ALERT_TYPE_OPTIONS: { value: DriftAlertType; label: string; hint: string }[] = [
  { value: 'missing-field', label: 'Missing field', hint: 'A field stopped appearing — usually real breakage.' },
  { value: 'type-drift', label: 'Type drift', hint: "A field's value type changed unexpectedly — usually real breakage." },
  { value: 'new-field', label: 'New field', hint: 'A field appeared that wasn’t in the learned baseline — often just normal growth.' },
  { value: 'rename-candidate', label: 'Rename candidate', hint: 'A missing field and a new field look like they might be the same field renamed.' },
]
const DEFAULT_ALERT_DRIFT_TYPES: DriftAlertType[] = ['missing-field', 'type-drift']

interface ProtocolOutput {
  protocol: string
  drift_options?: DriftOptions | null
}

// Drift tuning isn't actually protocol-specific (warmup length, missing-field
// tolerance, cooldown, presence ratio are all general schema-stability
// concepts) — it's stored per-protocol-row alongside genuinely
// protocol-specific fields (socket_path, buffer_capacity) as a storage
// convenience. One control here applies the same values to every pipe.
const globalDrift = ref<DriftOptions>({})
const driftLoading = ref(false)

async function loadDrift() {
  driftLoading.value = true
  try {
    const { data } = await apiClient.get('/v1/protocol-outputs')
    const outputs: ProtocolOutput[] = data.outputs ?? []
    const withDrift = outputs.find((o) => o.drift_options)
    globalDrift.value = withDrift?.drift_options ?? {}
  } catch {
    // non-fatal
  } finally {
    driftLoading.value = false
  }
}

function setDrift<K extends keyof DriftOptions>(key: K, val: DriftOptions[K]) {
  globalDrift.value[key] = val
}

// Single Save for the whole Configuration tab — detection/alert/storage
// settings and schema drift settings are two different API calls under the
// hood (drift tuning lives on endpoint_outputs, not the anomaly config), but
// operators shouldn't have to know that or click two separate Save buttons.
async function saveAllConfig() {
  configSaving.value = true
  try {
    const tasks: Promise<unknown>[] = [
      apiClient.patch('/v1/protocol-outputs/drift', { drift_options: globalDrift.value }),
    ]
    if (config.value) {
      tasks.push(anomalyApi.updateConfig(config.value).then((c) => { config.value = c }))
    }
    await Promise.all(tasks)
    message.success('Configuration saved')
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Save failed')
  } finally {
    configSaving.value = false
  }
}

function openAddMetric() {
  editingMetricIdx.value = null
  metricForm.value = blankMetric()
  expectedMin.value = null
  expectedMax.value = null
  metricDrawerOpen.value = true
  loadMetricSuggestions()
}

function openEditMetric(metric: AnomalyMetricConfig, idx: number) {
  editingMetricIdx.value = idx
  metricForm.value = { ...metric, name: friendlyLabel(metric.name), methods: [...metric.methods] }
  expectedMin.value = metric.expectedRange?.[0] ?? null
  expectedMax.value = metric.expectedRange?.[1] ?? null
  metricDrawerOpen.value = true
  loadMetricSuggestions()
}

async function saveMetric() {
  if (!config.value) return
  if (!metricForm.value.name.trim()) {
    message.error('Metric name is required')
    return
  }
  if (metricForm.value.methods.includes('expected_range')) {
    if (expectedMin.value == null || expectedMax.value == null) {
      message.error('Expected range method requires min/max bounds to be set')
      return
    }
    if (expectedMin.value >= expectedMax.value) {
      message.error('Expected range min must be less than max')
      return
    }
  }
  const entry: AnomalyMetricConfig = {
    ...metricForm.value,
    expectedRange:
      expectedMin.value != null && expectedMax.value != null
        ? [expectedMin.value, expectedMax.value]
        : undefined,
  }
  if (editingMetricIdx.value !== null) {
    config.value.metrics[editingMetricIdx.value] = entry
  } else {
    config.value.metrics.push(entry)
  }
  metricDrawerOpen.value = false
  await saveConfig()
}

async function removeMetric(idx: number) {
  if (!config.value) return
  config.value.metrics.splice(idx, 1)
  await saveConfig()
}

async function toggleMetricEnabled(idx: number) {
  if (!config.value) return
  config.value.metrics[idx].enabled = !config.value.metrics[idx].enabled
  await saveConfig()
}

// ── Bad actors (ISA-18.2-style ranking of noisiest metrics by incident frequency) ──
const badActors = ref<BadActor[]>([])
const badActorsLoading = ref(false)
const badActorsWindowDays = ref(30)

// null = no classified resolutions yet to compute a rate from (distinct from a genuine 0%)
function fpRate(record: BadActor): number | null {
  const classified = record.false_positive_count + record.true_positive_count + record.expected_count + record.accepted_count
  if (classified === 0) return null
  return Math.round((record.false_positive_count / classified) * 100)
}

async function loadBadActors() {
  badActorsLoading.value = true
  try {
    const result = await anomalyApi.getBadActors({ windowDays: badActorsWindowDays.value, limit: 20 })
    badActors.value = result.badActors
  } catch {
    // non-fatal
  } finally {
    badActorsLoading.value = false
  }
}

// ── Tab switching ──────────────────────────────────────────────────────────────
function onTabChange(tab: string) {
  activeTab.value = tab
  stopTabAutoRefresh()
  if (tab === 'events') { loadEdgeEvents(); startTabAutoRefresh(loadEdgeEvents, edgeEventsLoading) }
  else if (tab === 'incidents') { loadEdgeIncidents(); startTabAutoRefresh(loadEdgeIncidents, edgeIncidentsLoading) }
  else if (tab === 'alerts') { loadEdgeAlerts(); startTabAutoRefresh(loadEdgeAlerts, edgeAlertsLoading) }
  else if (tab === 'baselines') { loadBaselines(); startTabAutoRefresh(loadBaselines, baselinesLoading) }
  else if (tab === 'schema-drift') { loadSchemaDriftBaselines(); startTabAutoRefresh(loadSchemaDriftBaselines, schemaDriftLoading) }
  else if (tab === 'config') { loadConfig(); loadDrift() }
  else if (tab === 'rules') { loadConfig(); loadMetricSuggestions(); loadBadActors(); ensureEndpointMaps() }
}

onMounted(() => {
  loadEdgeIncidents()
  startTabAutoRefresh(loadEdgeIncidents, edgeIncidentsLoading)
})
// proInstalled is fetched asynchronously by AppLayout and may not have resolved
// yet when this view mounts (e.g. a direct page load on the Anomalies tab) — a
// one-shot `if (proInstalled.value)` check here can run before that fetch lands
// and never fire again. Watch instead so warmup status loads as soon as the
// pro-installed flag actually becomes true, whenever that happens.
watch(proInstalled, (installed) => {
  if (installed) loadWarmupStatus()
}, { immediate: true })
onUnmounted(() => {
  stopTabAutoRefresh()
  stopWarmupCountdown()
})
</script>

<template>
  <AppLayout title="Analytics">
    <a-alert v-if="!proInstalled" type="info" show-icon style="margin-bottom: 16px">
      <template #message>Catch anomalies before they become failures</template>
      <template #description>
        <div style="margin-top: 4px">
          <strong>Iotistica Agent Pro</strong> adds on-device ML anomaly detection — baseline tracking,
          per-metric alert rules, and trend forecasting that runs entirely on the device with no cloud
          round-trip required. Get notified the moment a sensor drifts outside its normal range.
        </div>
        <div style="margin-top: 12px">
          <a-button
            type="primary"
            size="small"
            href="https://iotistica.com/solutions.html"
            target="_blank"
            rel="noopener"
          >Upgrade to Agent Pro →</a-button>
          <a
            href="https://iotistica.com/solutions.html"
            target="_blank"
            rel="noopener"
            style="margin-left: 16px; font-size: 12px"
          >Compare plans</a>
        </div>
      </template>
    </a-alert>
    <a-tabs :active-key="activeTab" @change="onTabChange">

      <!-- ══ EVENTS ═════════════════════════════════════════════════════════ -->
      <a-tab-pane key="events" tab="Events">
        <div class="toolbar">
          <a-select
            v-model:value="edgeEventsSeverity"
            placeholder="All severities"
            allow-clear
            style="width: 150px"
            @change="() => { edgeEventsPage = 1; loadEdgeEvents() }"
          >
            <a-select-option value="critical">Critical</a-select-option>
            <a-select-option value="warning">Warning</a-select-option>
            <a-select-option value="info">Info</a-select-option>
          </a-select>
          <span style="color: #888; font-size: 12px">{{ edgeEventsTotal }} total · auto-refresh 5s</span>
        </div>
        <a-table
          :columns="edgeEventColumns"
          :data-source="edgeEvents"
          :loading="edgeEventsLoading"
          :pagination="{ current: edgeEventsPage, pageSize: PAGE_SIZE, total: edgeEventsTotal, showSizeChanger: false, onChange: (p: number) => { edgeEventsPage = p; loadEdgeEvents() } }"
          row-key="id"
          size="small"
          :scroll="{ x: true }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'severity'">
              <a-tag :color="SEVERITY_TAG_COLOR[record.severity]" :class="record.severity === 'critical' ? 'severity-critical' : ''" style="font-size: 11px; margin: 0">{{ record.severity }}</a-tag>
            </template>
            <template v-else-if="column.key === 'metric'">
              <span :title="record.metric">{{ metricLeaf(record.metric, record.device_name) }}</span>
            </template>
            <template v-else-if="column.key === 'device_name'">
              <span style="font-size: 12px">{{ deviceNameFromMetric(record.metric, record.device_name) }}</span>
            </template>
            <template v-else-if="column.key === 'value'">
              <span style="font-variant-numeric: tabular-nums">{{ fmtNum(record.observed_value, 3) }}</span>
            </template>
            <template v-else-if="column.key === 'score'">
              <span style="font-variant-numeric: tabular-nums; font-size: 12px">{{ fmtNum(record.anomaly_score, 3) }}</span>
            </template>
            <template v-else-if="column.key === 'conf'">
              <span style="font-size: 12px">{{ Math.round(record.confidence * 100) }}%</span>
            </template>
            <template v-else-if="column.key === 'consec'">
              <span style="font-size: 12px; color: #888">{{ record.consecutive_count }}×</span>
            </template>
            <template v-else-if="column.key === 'time'">
              <span style="color: #888; font-size: 12px">{{ fmtTs(record.timestamp_ms) }}</span>
            </template>
          </template>
          <template #emptyText>
            <div style="padding: 24px 0; text-align: center; color: #aaa; font-size: 13px">
              No anomaly events yet. Events are recorded when the anomaly detection engine triggers.
            </div>
          </template>
        </a-table>
      </a-tab-pane>

      <!-- ══ INCIDENTS ══════════════════════════════════════════════════════ -->
      <a-tab-pane key="incidents" tab="Incidents">
        <div class="toolbar">
          <a-select
            v-model:value="edgeIncidentsStatus"
            placeholder="All statuses"
            allow-clear
            style="width: 150px"
            @change="() => { edgeIncidentsPage = 1; loadEdgeIncidents() }"
          >
            <a-select-option value="open">Open</a-select-option>
            <a-select-option value="active">Active</a-select-option>
            <a-select-option value="resolved">Resolved</a-select-option>
          </a-select>
          <span style="color: #888; font-size: 12px">{{ edgeIncidentsTotal }} total · auto-refresh 5s</span>
        </div>
        <a-table
          :columns="edgeIncidentColumns"
          :data-source="edgeIncidents"
          :loading="edgeIncidentsLoading"
          :pagination="{ current: edgeIncidentsPage, pageSize: PAGE_SIZE, total: edgeIncidentsTotal, showSizeChanger: false, onChange: (p: number) => { edgeIncidentsPage = p; loadEdgeIncidents() } }"
          row-key="incident_id"
          size="small"
          :scroll="{ x: true }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'severity'">
              <a-tag :color="SEVERITY_TAG_COLOR[record.severity]" :class="record.severity === 'critical' ? 'severity-critical' : ''" style="font-size: 11px; margin: 0">{{ record.severity }}</a-tag>
            </template>
            <template v-else-if="column.key === 'metric'">
              <span :title="record.metric">{{ metricLeaf(record.metric, record.device_name) }}</span>
            </template>
            <template v-else-if="column.key === 'device_name'">
              <span style="font-size: 12px">{{ deviceNameFromMetric(record.metric, record.device_name) }}</span>
            </template>
            <template v-else-if="column.key === 'status'">
              <a-tag :color="INCIDENT_STATUS_COLOR[record.status]" style="font-size: 11px">{{ record.status }}</a-tag>
            </template>
            <template v-else-if="column.key === 'score'">
              <span style="font-variant-numeric: tabular-nums; font-size: 12px">{{ fmtNum(record.max_anomaly_score, 3) }}</span>
            </template>
            <template v-else-if="column.key === 'first_seen'">
              <span style="color: #888; font-size: 12px">{{ fmtTs(record.first_seen) }}</span>
            </template>
            <template v-else-if="column.key === 'last_seen'">
              <span style="color: #888; font-size: 12px">{{ fmtTs(record.last_seen) }}</span>
            </template>
            <template v-else-if="column.key === 'actions'">
              <a-button
                v-if="record.status !== 'resolved'"
                size="small"
                :loading="resolvingId === record.incident_id"
                @click="openResolveModal(record)"
              >Resolve</a-button>
              <span v-else style="color: #888; font-size: 12px">—</span>
            </template>
          </template>
          <template #emptyText>
            <div style="padding: 24px 0; text-align: center; color: #aaa; font-size: 13px">
              No incidents yet. Incidents are created when multiple anomaly events share the same fingerprint.
            </div>
          </template>
        </a-table>
      </a-tab-pane>

      <!-- ══ ALERTS (edge) ══════════════════════════════════════════════════ -->
      <a-tab-pane key="alerts" tab="Alerts">
        <div class="toolbar" style="justify-content: flex-end">
          <span style="color: #888; font-size: 12px">{{ edgeAlertsTotal }} total · auto-refresh 5s</span>
        </div>
        <a-table
          :columns="edgeAlertColumns"
          :data-source="edgeAlerts"
          :loading="edgeAlertsLoading"
          :pagination="{ current: edgeAlertsPage, pageSize: PAGE_SIZE, total: edgeAlertsTotal, showSizeChanger: false, onChange: (p: number) => { edgeAlertsPage = p; loadEdgeAlerts() } }"
          row-key="alert_id"
          size="small"
          :scroll="{ x: true }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'severity'">
              <a-tag :color="SEVERITY_TAG_COLOR[record.severity]" :class="record.severity === 'critical' ? 'severity-critical' : ''" style="font-size: 11px; margin: 0">{{ record.severity }}</a-tag>
            </template>
            <template v-else-if="column.key === 'metric'">
              <span :title="record.metric">{{ metricLeaf(record.metric, record.device_name) }}</span>
            </template>
            <template v-else-if="column.key === 'device_name'">
              <span style="font-size: 12px">{{ deviceNameFromMetric(record.metric, record.device_name) }}</span>
            </template>
            <template v-else-if="column.key === 'score'">
              <span style="font-variant-numeric: tabular-nums; font-size: 12px">{{ fmtNum(record.max_anomaly_score, 3) }}</span>
            </template>
            <template v-else-if="column.key === 'message'">
              <span :title="record.message" style="white-space: normal; word-break: break-word">{{ stripGuids(record.message) }}</span>
            </template>
            <template v-else-if="column.key === 'time'">
              <span style="color: #888; font-size: 12px">{{ fmtTs(record.created_at) }}</span>
            </template>
          </template>
          <template #emptyText>
            <div style="padding: 24px 0; text-align: center; color: #aaa; font-size: 13px">
              No alerts promoted yet. Alerts are raised when an incident accumulates enough events (critical: 1, warning: 3, info: 5).
            </div>
          </template>
        </a-table>
      </a-tab-pane>

      <!-- ══ BASELINES ══════════════════════════════════════════════════════ -->
      <a-tab-pane key="baselines" tab="Baselines">
        <div class="toolbar">
          <a-input
            v-model:value="baselinesMetric"
            placeholder="Search by metric…"
            allow-clear
            style="width: 260px"
          >
            <template #prefix><SearchOutlined style="color: #bbb" /></template>
          </a-input>
          <a-space>
            <span style="color: #888; font-size: 12px">{{ baselinesTotal }} total · auto-refresh 5s</span>
            <a-button danger :loading="clearingBaselines" @click="resetBaselinesModalOpen = true">Reset</a-button>
          </a-space>
        </div>
        <a-table
          :columns="baselineColumns"
          :data-source="baselines"
          :loading="baselinesLoading"
          :pagination="{ current: baselinesPage, pageSize: PAGE_SIZE, total: baselinesTotal, showSizeChanger: false, onChange: (p: number) => { baselinesPage = p; loadBaselines() } }"
          :row-key="(record: BaselineRow) => `${record.isSynthetic ? 'pending' : 'done'}::${record.metric}::${record.device_id}::${record.device_state}`"
          size="small"
          :scroll="{ x: true }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'metric'">
              <span :title="record.metric" style="font-size: 12px">{{ metricLeaf(record.metric) }}</span>
            </template>
            <template v-else-if="column.key === 'device_id'">
              <span :title="record.device_id" style="font-size: 12px">{{ deviceNameFromMetric(record.metric, record.device_id) }}</span>
            </template>
            <template v-else-if="column.key === 'device_state'">
              <a-tooltip
                v-if="warmupRemainingMs"
                :title="`Agent-wide warmup, ${warmupCountdownLabel} left — not specific to this rule. Alerts pause for every metric for 15 minutes after the agent starts, to avoid false positives from startup noise. Baseline collection isn't affected.`"
              >
                <a-tag color="orange" style="font-size: 10px">Warming up</a-tag>
              </a-tooltip>
              <a-tag v-else-if="record.pendingWindowSize" color="blue" style="font-size: 10px">Collecting</a-tag>
              <span v-else style="font-size: 12px">{{ record.device_state }}</span>
            </template>
            <template v-else-if="column.key === 'time_slot'">
              <span style="font-size: 12px">{{ record.isSynthetic ? '—' : record.time_slot }}</span>
            </template>
            <template v-else-if="column.key === 'sample_count'">
              <span style="font-variant-numeric: tabular-nums; font-size: 12px">
                {{ record.pendingWindowSize ? `${record.sample_count} / ${record.pendingWindowSize}` : record.sample_count }}
              </span>
            </template>
            <template v-else-if="column.key === 'mean'">
              <span style="font-variant-numeric: tabular-nums; font-size: 12px">{{ fmtNum(record.mean, 3) }}</span>
            </template>
            <template v-else-if="column.key === 'std_dev'">
              <span style="font-variant-numeric: tabular-nums; font-size: 12px">{{ fmtNum(record.std_dev, 3) }}</span>
            </template>
            <template v-else-if="column.key === 'median'">
              <span style="font-variant-numeric: tabular-nums; font-size: 12px">{{ fmtNum(record.median, 3) }}</span>
            </template>
            <template v-else-if="column.key === 'mad'">
              <span style="font-variant-numeric: tabular-nums; font-size: 12px">{{ fmtNum(record.mad, 3) }}</span>
            </template>
            <template v-else-if="column.key === 'calculated_at'">
              <span style="color: #888; font-size: 12px">{{ record.isSynthetic ? '—' : fmtTs(record.calculated_at) }}</span>
            </template>
          </template>
          <template #emptyText>
            <div style="padding: 24px 0; text-align: center; color: #aaa; font-size: 13px">
              No baselines yet — baselines are built up as metric data flows through the anomaly detection engine.
            </div>
          </template>
        </a-table>
      </a-tab-pane>

      <!-- ══ SCHEMA DRIFT ═══════════════════════════════════════════════════ -->
      <a-tab-pane key="schema-drift" tab="Schema Drift">
        <a-alert
          v-if="!proInstalled"
          type="info"
          show-icon
          message="Schema drift detection requires Iotistica Agent Pro"
          style="margin-bottom: 12px"
        />
        <div class="toolbar">
          <a-input
            v-model:value="schemaDriftQuery"
            placeholder="Search by protocol, device, or field…"
            allow-clear
            style="width: 300px"
          >
            <template #prefix><SearchOutlined style="color: #bbb" /></template>
          </a-input>
          <a-space>
            <span style="color: #888; font-size: 12px">{{ schemaDriftTotal }} total · auto-refresh 5s</span>
            <a-button danger :loading="clearingSchemaDrift" @click="resetSchemaDriftModalOpen = true">Reset</a-button>
          </a-space>
        </div>
        <a-table
          :columns="schemaDriftColumns"
          :data-source="schemaDriftRows"
          :loading="schemaDriftLoading"
          :pagination="{ pageSize: PAGE_SIZE, showSizeChanger: false }"
          :row-key="(record: SchemaDriftBaselineRow) => `${record.protocol}::${record.device ?? ''}::${record.field}`"
          size="small"
          :scroll="{ x: true }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'device'">
              <span style="font-size: 12px">{{ record.device ?? '—' }}</span>
            </template>
            <template v-else-if="column.key === 'field'">
              <span :title="record.field" style="font-size: 12px">{{ record.field }}</span>
            </template>
            <template v-else-if="column.key === 'status'">
              <a-tag v-if="record.status === 'baseline'" color="green" style="font-size: 10px">Baseline</a-tag>
              <a-tooltip
                v-else
                :title="`Seen ${record.stableBatches} of ${record.windowSize ?? '?'} batches since first appearing (${record.presenceRatio != null ? Math.round(record.presenceRatio * 100) : '?'}% presence). Promotes once occurrence count reaches ${SCHEMA_DRIFT_PROMOTION_BATCHES} AND presence reaches ${Math.round(SCHEMA_DRIFT_PROMOTION_RATIO * 100)}% — a field that's only present some of the time (e.g. an intermittent fault/alarm point) can stay pending indefinitely even past ${SCHEMA_DRIFT_PROMOTION_BATCHES} occurrences.`"
              >
                <a-tag color="blue" style="font-size: 10px">
                  Pending {{ record.presenceRatio != null ? Math.round(record.presenceRatio * 100) + '%' : `${record.stableBatches}/${SCHEMA_DRIFT_PROMOTION_BATCHES}` }}
                </a-tag>
              </a-tooltip>
            </template>
            <template v-else-if="column.key === 'dominantType'">
              <span style="font-size: 12px; color: #888">{{ record.dominantType ?? '—' }}</span>
            </template>
            <template v-else-if="column.key === 'updatedAt'">
              <span style="color: #888; font-size: 12px">{{ record.updatedAt ? fmtTs(record.updatedAt) : '—' }}</span>
            </template>
          </template>
          <template #emptyText>
            <div style="padding: 24px 0; text-align: center; color: #aaa; font-size: 13px">
              No schema drift baselines yet — agent is still learning.
            </div>
          </template>
        </a-table>
      </a-tab-pane>

      <!-- ══ RULES ══════════════════════════════════════════════════════════ -->
      <a-tab-pane key="rules" tab="Rules">
        <a-card size="small" style="margin-bottom: 16px">
          <div class="toolbar">
            <span style="color: #888; font-size: 13px">
              <strong>Noisy Metrics (Bad Actors)</strong> — Metrics ranked by incident frequency, regardless of incident validity.
              Frequently firing metrics are candidates for tuning under ISA-18.2 alarm rationalization principles.
            </span>
            <a-select v-model:value="badActorsWindowDays" size="small" style="width: 110px" @change="loadBadActors">
              <a-select-option :value="7">Last 7 days</a-select-option>
              <a-select-option :value="30">Last 30 days</a-select-option>
              <a-select-option :value="90">Last 90 days</a-select-option>
            </a-select>
          </div>
          <a-table
            :data-source="badActors"
            :loading="badActorsLoading"
            :pagination="false"
            row-key="metric"
            size="small"
          >
            <a-table-column key="metric" title="Metric" data-index="metric">
              <template #default="{ record }">{{ metricLeaf(record.metric, record.device_name) }}</template>
            </a-table-column>
            <a-table-column key="device_name" title="Device" data-index="device_name">
              <template #default="{ record }">{{ deviceNameFromMetric(record.metric, record.device_name) }}</template>
            </a-table-column>
            <a-table-column key="incident_count" title="Incidents" data-index="incident_count" :width="90" />
            <a-table-column key="total_events" title="Total Events" data-index="total_events" :width="110" />
            <a-table-column key="severity" title="Severity">
              <template #default="{ record }">
                <a-tag v-if="record.critical_count" color="red">{{ record.critical_count }} critical</a-tag>
                <a-tag v-if="record.warning_count" color="orange">{{ record.warning_count }} warning</a-tag>
                <a-tag v-if="record.info_count" color="blue">{{ record.info_count }} info</a-tag>
              </template>
            </a-table-column>
            <a-table-column key="status" title="Open / Resolved">
              <template #default="{ record }">{{ record.open_count }} open · {{ record.resolved_count }} resolved</template>
            </a-table-column>
            <a-table-column key="fpRate" title="False Positive Rate">
              <template #default="{ record }">
                <span v-if="fpRate(record) === null" style="color: #ccc">— no reasons recorded yet</span>
                <a-tag v-else :color="fpRate(record)! >= 50 ? 'red' : fpRate(record)! >= 20 ? 'orange' : 'green'">
                  {{ fpRate(record) }}%
                </a-tag>
              </template>
            </a-table-column>
            <a-table-column key="last_seen" title="Last Seen">
              <template #default="{ record }">{{ fmtTs(record.last_seen) }}</template>
            </a-table-column>
            <template #emptyText>
              <div style="padding: 24px 0; text-align: center; color: #aaa; font-size: 13px">
                No incidents in this window — nothing to rank yet.
              </div>
            </template>
          </a-table>
        </a-card>

        <a-spin :spinning="configLoading">
          <template v-if="config">
            <div class="toolbar">
              <span style="color: #888; font-size: 13px">
                Per-metric anomaly detection rules — thresholds, methods, and seasonality.
              </span>
              <a-button type="primary" @click="openAddMetric">
                <template #icon><PlusOutlined /></template>
                Add rule
              </a-button>
            </div>

            <a-table
              :columns="metricColumns"
              :data-source="config.metrics"
              :pagination="false"
              row-key="name"
              size="middle"
            >
              <template #bodyCell="{ column, record, index }">
                <template v-if="column.key === 'name'">
                  <span :title="record.name" style="font-size: 12px">{{ ruleMetricLeaf(record) }}</span>
                </template>
                <template v-else-if="column.key === 'device'">
                  <span style="font-size: 12px">{{ ruleDeviceName(record) || '—' }}</span>
                </template>
                <template v-else-if="column.key === 'enabled'">
                  <a-switch
                    :checked="record.enabled"
                    size="small"
                    @change="toggleMetricEnabled(index)"
                  />
                </template>

                <template v-else-if="column.key === 'methods'">
                  <a-tag
                    v-for="m in record.methods"
                    :key="m"
                    :color="methodColor(m)"
                    style="font-size: 11px; margin: 1px"
                  >{{ m }}</a-tag>
                </template>

                <template v-else-if="column.key === 'seasonality'">
                  <span style="color: #888; font-size: 12px">{{ record.seasonality || 'none' }}</span>
                </template>

                <template v-else-if="column.key === 'actions'">
                  <a-space>
                    <a-button size="small" @click="openEditMetric(record, index)">Edit</a-button>
                    <a-button size="small" danger @click="removeMetric(index)">
                      <template #icon><DeleteOutlined /></template>
                    </a-button>
                  </a-space>
                </template>
              </template>
              <template #emptyText>
                <div style="padding: 24px 0; text-align: center; color: #aaa; font-size: 13px">
                  No metric rules yet — click "Add rule" to define anomaly detection for a metric.
                </div>
              </template>
            </a-table>
          </template>

          <div v-else-if="!configLoading" style="padding: 48px 0; text-align: center; color: #aaa; font-size: 13px">
            No configuration loaded — check the agent connection.
          </div>
        </a-spin>
      </a-tab-pane>

      <!-- ══ CONFIG ══════════════════════════════════════════════════════════ -->
      <a-tab-pane key="config" tab="Configuration">
        <a-spin :spinning="configLoading">
          <template v-if="config">
            <div class="settings-page">
              <a-alert
                type="info"
                show-icon
                message="Anomaly detection is enabled or disabled in Settings → Features."
                style="margin-bottom: 20px"
              />

              <!-- Detection settings -->
              <SettingsSection
                title="Anomaly detection settings"
                subtitle="Configure how anomalies are detected and scored."
              >
                <template #icon><SafetyCertificateOutlined /></template>

                <a-row :gutter="[20, 20]">
                  <a-col :xs="24" :sm="12" :lg="8">
                    <SettingsField label="Sensitivity (1–10)" tooltip="Higher sensitivity flags smaller deviations as anomalies.">
                      <div class="sensitivity-control">
                        <div class="sensitivity-control__row">
                          <a-slider
                            v-model:value="config.sensitivity"
                            :min="1"
                            :max="10"
                            style="flex: 1"
                          />
                          <a-input-number v-model:value="config.sensitivity" :min="1" :max="10" style="width: 64px" />
                        </div>
                        <div class="sensitivity-control__scale">
                          <span>1 · Low</span>
                          <span>10 · High</span>
                        </div>
                      </div>
                    </SettingsField>
                  </a-col>
                  <a-col :xs="24" :sm="12" :lg="8">
                    <SettingsField
                      label="Warm-up period (ms)"
                      tooltip="Time to collect baseline data before detection starts."
                      helper="Time to collect baseline data before detection starts."
                    >
                      <a-input-number v-model:value="config.warmupPeriodMs" :min="0" :step="60000" placeholder="900000" />
                    </SettingsField>
                  </a-col>
                  <a-col :xs="24" :sm="12" :lg="8">
                    <SettingsField
                      label="Min confidence"
                      tooltip="Minimum confidence score to consider an anomaly."
                      helper="Minimum confidence score to consider an anomaly."
                    >
                      <a-input-number v-model:value="config.alerts.minConfidence" :min="0" :max="1" :step="0.05" />
                    </SettingsField>
                  </a-col>
                  <a-col :xs="24" :sm="12" :lg="8">
                    <SettingsField
                      label="Cooldown (ms)"
                      tooltip="Minimum time between anomaly detections."
                      helper="Minimum time between anomaly detections."
                    >
                      <a-input-number v-model:value="config.alerts.cooldownMs" :min="0" :step="60000" />
                    </SettingsField>
                  </a-col>
                  <a-col :xs="24" :sm="12" :lg="8">
                    <SettingsField
                      label="Max queue size"
                      tooltip="Maximum number of items in the anomaly queue."
                      helper="Maximum number of items in the anomaly queue."
                    >
                      <a-input-number v-model:value="config.alerts.maxQueueSize" :min="1" />
                    </SettingsField>
                  </a-col>
                </a-row>
              </SettingsSection>

              <!-- Alert routing -->
              <SettingsSection
                title="Alert routing"
                subtitle="Configure how and where alerts are delivered."
              >
                <template #icon><BellOutlined /></template>

                <a-row :gutter="[20, 20]">
                  <a-col :xs="24" :sm="12" :lg="8">
                    <SettingsField label="Enable MQTT alerts">
                      <a-switch v-model:checked="config.alerts.mqtt" />
                    </SettingsField>
                  </a-col>
                  <a-col :xs="24" :sm="12" :lg="8">
                    <SettingsField
                      label="MQTT destination"
                      tooltip="Local broker from the Destinations page (standalone mode)."
                      helper="Local broker from the Destinations page (standalone mode)."
                    >
                      <a-select
                        :value="config.alerts.alertDestinationId"
                        allow-clear
                        :disabled="!config.alerts.mqtt"
                        placeholder="None (use cloud MQTT)"
                        @change="(v: number | null) => { config!.alerts.alertDestinationId = v ?? undefined }"
                      >
                        <a-select-option v-for="d in mqttDestinations" :key="d.id" :value="d.id">
                          {{ d.name }}
                        </a-select-option>
                      </a-select>
                    </SettingsField>
                  </a-col>
                  <a-col :xs="24" :sm="12" :lg="8">
                    <SettingsField
                      label="Alert topic"
                      tooltip="Topic to publish to when a destination is selected."
                      helper="Topic to publish to when a destination is selected."
                    >
                      <a-input
                        :value="config.alerts.alertTopic ?? ''"
                        :disabled="!config.alerts.mqtt"
                        placeholder="iotistica/alerts/anomaly"
                        @change="(e: Event) => { config!.alerts.alertTopic = (e.target as HTMLInputElement).value || undefined }"
                      />
                    </SettingsField>
                  </a-col>
                </a-row>
              </SettingsSection>

              <!-- Storage & retention -->
              <SettingsSection
                title="Storage & retention"
                subtitle="Configure how long data is kept."
              >
                <template #icon><DatabaseOutlined /></template>

                <a-row :gutter="[20, 20]">
                  <a-col :xs="24" :sm="12" :lg="8">
                    <SettingsField label="Baseline retention (days)" helper="How long baselines are kept.">
                      <a-input-number
                        :value="config.storage?.retention"
                        :min="1"
                        @change="(v: number) => { if (!config!.storage) config!.storage = { retention: v }; else config!.storage.retention = v }"
                      />
                    </SettingsField>
                  </a-col>
                  <a-col :xs="24" :sm="12" :lg="8">
                    <SettingsField label="Baseline max age (days)" helper="Maximum age of baselines used for detection.">
                      <a-input-number
                        :value="config.storage?.baselineMaxAgeDays"
                        :min="1"
                        placeholder="7"
                        @change="(v: number) => { if (!config!.storage) config!.storage = { retention: 30, baselineMaxAgeDays: v }; else config!.storage.baselineMaxAgeDays = v }"
                      />
                    </SettingsField>
                  </a-col>
                  <a-col :xs="24" :sm="12" :lg="8">
                    <SettingsField label="Min samples for baseline" helper="Minimum samples required to create a baseline.">
                      <a-input-number
                        :value="config.storage?.minSamples"
                        :min="1"
                        placeholder="5"
                        @change="(v: number) => { if (!config!.storage) config!.storage = { retention: 30, minSamples: v }; else config!.storage.minSamples = v }"
                      />
                    </SettingsField>
                  </a-col>
                  <a-col :xs="24" :sm="12" :lg="8">
                    <SettingsField label="Event retention (days)" helper="How long events are kept.">
                      <a-input-number
                        :value="config.storage?.eventRetentionDays"
                        :min="1"
                        :placeholder="String(config.storage?.retention ?? 30)"
                        @change="(v: number) => { if (!config!.storage) config!.storage = { retention: 30, eventRetentionDays: v }; else config!.storage.eventRetentionDays = v }"
                      />
                    </SettingsField>
                  </a-col>
                  <a-col :xs="24" :sm="12" :lg="8">
                    <SettingsField label="Incident retention (days)" helper="How long incidents are kept.">
                      <a-input-number
                        :value="config.storage?.incidentRetentionDays"
                        :min="1"
                        :placeholder="String(config.storage?.retention ?? 30)"
                        @change="(v: number) => { if (!config!.storage) config!.storage = { retention: 30, incidentRetentionDays: v }; else config!.storage.incidentRetentionDays = v }"
                      />
                    </SettingsField>
                  </a-col>
                  <a-col :xs="24" :sm="12" :lg="8">
                    <SettingsField label="Alert retention (days)" helper="How long alerts are kept.">
                      <a-input-number
                        :value="config.storage?.alertRetentionDays"
                        :min="1"
                        :placeholder="String(config.storage?.retention ?? 30)"
                        @change="(v: number) => { if (!config!.storage) config!.storage = { retention: 30, alertRetentionDays: v }; else config!.storage.alertRetentionDays = v }"
                      />
                    </SettingsField>
                  </a-col>
                </a-row>

                <a-alert
                  type="info"
                  show-icon
                  message="Retention settings control how long data is kept. Items are automatically pruned based on age, regardless of whether they are open/active."
                  class="settings-page__notice"
                />
              </SettingsSection>

              <!-- Schema drift settings -->
              <SettingsSection
                title="Schema drift"
                subtitle="Controls how the agent detects unexpected changes in the fields it publishes. Settings take effect after the agent restarts."
              >
                <template #icon><BranchesOutlined /></template>
                <template #extra>
                  <div class="drift-enabled-toggle">
                    <span class="drift-enabled-toggle__label">Enabled</span>
                    <a-switch
                      :checked="globalDrift.enabled !== false"
                      size="small"
                      @change="(v: boolean) => setDrift('enabled', v)"
                    />
                  </div>
                </template>

                <a-spin :spinning="driftLoading">
                  <a-row :gutter="[20, 20]">
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField
                        label="Warmup batches"
                        tooltip="How many times a device must be observed before its baseline is learned. Counted per device — a device that reports rarely just takes longer in wall-clock time to finish warmup, not more attempts."
                      >
                        <a-input-number
                          :value="globalDrift.warmupBatches ?? 20"
                          :min="1" :max="500"
                          @change="(v: number) => setDrift('warmupBatches', v)"
                        />
                      </SettingsField>
                    </a-col>
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField
                        label="Missing threshold"
                        tooltip="How many consecutive times a device must be observed without a previously-known field before it's flagged as removed (critical severity). Higher values tolerate more occasional gaps before alerting."
                      >
                        <a-input-number
                          :value="globalDrift.consecutiveMissingThreshold ?? 10"
                          :min="1" :max="1000"
                          @change="(v: number) => setDrift('consecutiveMissingThreshold', v)"
                        />
                      </SettingsField>
                    </a-col>
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField
                        label="Alert cooldown (ms)"
                        tooltip="Minimum time between repeat alerts for the same field on the same device. Prevents a single ongoing drift from spamming repeated alerts. In milliseconds — 1800000 = 30 minutes."
                      >
                        <a-input-number
                          :value="globalDrift.alertCooldownMs ?? 1800000"
                          :min="0" :step="60000"
                          @change="(v: number) => setDrift('alertCooldownMs', v)"
                        />
                      </SettingsField>
                    </a-col>
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField
                        label="Min presence ratio"
                        tooltip="During warmup, the fraction of a device's observations a field must appear in to be included in its baseline. 0.5 means a field must be present at least half the time to count — filters out fields that only show up sporadically."
                      >
                        <a-input-number
                          :value="globalDrift.minFieldPresenceRatio ?? 0.5"
                          :min="0" :max="1" :step="0.05" :precision="2"
                          @change="(v: number) => setDrift('minFieldPresenceRatio', v)"
                        />
                      </SettingsField>
                    </a-col>
                    <a-col :xs="24" :sm="12" :lg="8">
                      <SettingsField
                        label="Retire threshold"
                        tooltip="The number of consecutive times a baseline field can be missing before it's removed from the learned schema. This value is intentionally set much higher than the missing-field alert threshold, so a temporary issue—such as a bad reload or a short data gap—won't cause the system to forget a field it has already learned is normally present."
                      >
                        <a-input-number
                          :value="globalDrift.adaptiveRetireBatches ?? 250"
                          :min="1" :max="10000"
                          @change="(v: number) => setDrift('adaptiveRetireBatches', v)"
                        />
                      </SettingsField>
                    </a-col>
                  </a-row>

                  <div class="drift-alert-on">
                    <div class="drift-alert-on__label">
                      Alert on
                      <a-tooltip title="Every drift type is always logged and shows up in the Schema Drift baseline history regardless of this setting — this only controls which ones also raise an alert (Events/Incidents/Alerts, same pipeline anomalies use).">
                        <QuestionCircleOutlined class="drift-alert-on__info" />
                      </a-tooltip>
                    </div>
                    <a-checkbox-group
                      :value="globalDrift.alertOnDriftTypes ?? DEFAULT_ALERT_DRIFT_TYPES"
                      class="drift-alert-on__group"
                      @change="(v: DriftAlertType[]) => setDrift('alertOnDriftTypes', v)"
                    >
                      <a-checkbox v-for="opt in DRIFT_ALERT_TYPE_OPTIONS" :key="opt.value" :value="opt.value">
                        {{ opt.label }}
                        <a-tooltip :title="opt.hint">
                          <QuestionCircleOutlined class="drift-alert-on__info drift-alert-on__info--sm" />
                        </a-tooltip>
                      </a-checkbox>
                    </a-checkbox-group>
                  </div>
                </a-spin>
              </SettingsSection>

              <div v-if="hasRole('operator')" class="settings-page__actions">
                <a-button @click="resetDetectionDefaults">
                  <template #icon><ReloadOutlined /></template>
                  Reset to default
                </a-button>
                <a-button type="primary" :loading="configSaving" @click="saveAllConfig">
                  <template #icon><SaveOutlined /></template>
                  Save configuration
                </a-button>
              </div>
            </div>
          </template>

          <div v-else-if="!configLoading" style="color: #888; padding: 48px 0; text-align: center">
            Configuration not available. Click the tab to load.
          </div>
        </a-spin>
      </a-tab-pane>

    </a-tabs>

    <!-- ── Resolve incident modal ───────────────────────────────────────────── -->
    <a-modal
      :open="resolveModalOpen"
      title="Resolve incident"
      ok-text="Resolve"
      :confirm-loading="!!resolvingId"
      :ok-button-props="{ disabled: !resolveModalReason }"
      @ok="confirmResolve"
      @cancel="resolveModalOpen = false"
    >
      <p v-if="resolveModalIncident" style="margin-bottom: 16px">
        Mark "{{ friendlyLabel(resolveModalIncident.metric) }}" on
        {{ deviceNameFromMetric(resolveModalIncident.metric, resolveModalIncident.device_name) }} as resolved.
      </p>
      <a-form layout="vertical">
        <a-form-item label="Reason" required>
          <a-select v-model:value="resolveModalReason" placeholder="Why is this being resolved?" style="width: 100%">
            <a-select-option v-for="(label, value) in RESOLUTION_REASON_LABELS" :key="value" :value="value">
              {{ label }}
            </a-select-option>
          </a-select>
          <div style="font-size: 12px; color: #888; margin-top: 4px">
            Used to spot noisy rules later (see Bad Actors on the Rules tab) — not shown anywhere else right now.
          </div>
        </a-form-item>
        <a-form-item label="Notes" style="margin-bottom: 0">
          <a-textarea v-model:value="resolveModalNotes" placeholder="Optional" :rows="2" />
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- ── Reset baselines modal ────────────────────────────────────────────── -->
    <a-modal
      :open="resetBaselinesModalOpen"
      title="Reset all baselines?"
      ok-text="Reset"
      ok-type="danger"
      :confirm-loading="clearingBaselines"
      @ok="clearAllBaselines"
      @cancel="resetBaselinesModalOpen = false"
    >
      <p>Deletes saved baselines and clears live buffers — the detection engine relearns from scratch.</p>
    </a-modal>

    <!-- ── Reset schema-drift baselines modal ───────────────────────────────── -->
    <a-modal
      :open="resetSchemaDriftModalOpen"
      title="Reset all schema-drift baselines?"
      ok-text="Reset"
      ok-type="danger"
      :confirm-loading="clearingSchemaDrift"
      @ok="clearAllSchemaDriftBaselines"
      @cancel="resetSchemaDriftModalOpen = false"
    >
      <p>Deletes saved schema-drift baselines and clears every endpoint's live state — every device relearns its schema from scratch (fresh warmup window per device).</p>
    </a-modal>

    <!-- ── Metric config drawer ─────────────────────────────────────────────── -->
    <a-drawer
      :open="metricDrawerOpen"
      :title="editingMetricIdx !== null ? 'Edit rule' : 'Add rule'"
      width="480"
      @close="metricDrawerOpen = false"
    >
      <template #extra>
        <a-button @click="openTemplateLibrary">Use a template</a-button>
      </template>

      <a-form layout="vertical">
        <a-form-item label="Metric name" required>
          <a-auto-complete
            v-model:value="metricForm.name"
            :options="metricAutocompleteOptions"
            placeholder="e.g. cpu_usage, temperature"
            :filter-option="false"
            allow-clear
            style="width: 100%"
          >
            <template #option="{ value: val, suggestion }">
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px">
                <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ val }}</span>
                <div style="display: flex; align-items: center; gap: 4px; flex-shrink: 0">
                  <span
                    v-if="suggestion?.endpointName"
                    style="font-size: 11px; color: #888"
                  >{{ suggestion.endpointName }}</span>
                  <a-tag
                    v-if="suggestion?.configured"
                    color="purple"
                    style="font-size: 10px; line-height: 16px; padding: 0 4px; margin: 0"
                  >configured</a-tag>
                </div>
              </div>
            </template>
          </a-auto-complete>
          <div style="font-size: 11px; color: #888; margin-top: 4px">
            <a-spin v-if="metricSuggestionsLoading" size="small" />
            <template v-else-if="metricSuggestions.length">
              {{ metricSuggestions.length }} metric{{ metricSuggestions.length !== 1 ? 's' : '' }} found —
              type to filter, or enter a custom name
            </template>
            <template v-else>No metrics flowing yet — enter a name manually</template>
          </div>
        </a-form-item>

        <a-form-item label="Device name (optional)" extra="Scopes this rule to a specific device. Leave empty to match all.">
          <a-input v-model:value="metricForm.deviceName" placeholder="e.g. BACnet-Controller-1" />
        </a-form-item>

        <a-form-item label="Seasonality">
          <a-select v-model:value="metricForm.seasonality" style="width: 160px">
            <a-select-option v-for="s in SEASONALITY_OPTIONS" :key="s" :value="s">
              {{ s }}
            </a-select-option>
          </a-select>
        </a-form-item>

        <a-form-item label="Detection methods">
          <a-checkbox-group v-model:value="metricForm.methods" style="display: flex; flex-wrap: wrap; gap: 8px">
            <a-checkbox v-for="m in DETECTION_METHODS" :key="m" :value="m">{{ m }}</a-checkbox>
          </a-checkbox-group>
        </a-form-item>

        <a-row :gutter="12">
          <a-col :span="12">
            <a-form-item label="Threshold (σ / MAD multiplier)">
              <a-input-number
                v-model:value="metricForm.threshold"
                :min="0.1"
                :step="0.5"
                style="width: 100%"
              />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="Window size (samples)">
              <a-input-number
                v-model:value="metricForm.windowSize"
                :min="5"
                :step="10"
                style="width: 100%"
              />
            </a-form-item>
          </a-col>
        </a-row>

        <a-row :gutter="12">
          <a-col :span="12">
            <a-form-item label="Min confidence (0–1)">
              <a-input-number
                v-model:value="metricForm.minConfidence"
                :min="0"
                :max="1"
                :step="0.05"
                style="width: 100%"
              />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="Cooldown (ms)">
              <a-input-number
                v-model:value="metricForm.cooldownMs"
                :min="0"
                :step="60000"
                style="width: 100%"
              />
            </a-form-item>
          </a-col>
        </a-row>

        <a-form-item
          label="Expected range (optional hard min/max bounds)"
          :validate-status="expectedRangeMissingBounds ? 'error' : ''"
          :help="expectedRangeMissingBounds
            ? 'expected_range is selected as a detection method — fill in both bounds or it will never alert'
            : 'Leave both blank to skip hard bounds. Also used by zscore/mad to suppress false positives within these bounds.'"
        >
          <a-row :gutter="8">
            <a-col :span="12">
              <a-input-number
                v-model:value="expectedMin"
                placeholder="Min"
                style="width: 100%"
              />
            </a-col>
            <a-col :span="12">
              <a-input-number
                v-model:value="expectedMax"
                placeholder="Max"
                style="width: 100%"
              />
            </a-col>
          </a-row>
        </a-form-item>

        <a-form-item label="Enabled">
          <a-switch v-model:checked="metricForm.enabled" />
        </a-form-item>
      </a-form>

      <template #footer>
        <a-space style="display: flex; justify-content: space-between; width: 100%">
          <a-button @click="openSaveTemplateModal">Save as template</a-button>
          <a-space>
            <a-button @click="metricDrawerOpen = false">Cancel</a-button>
            <a-button type="primary" @click="saveMetric">
              {{ editingMetricIdx !== null ? 'Update' : 'Add' }}
            </a-button>
          </a-space>
        </a-space>
      </template>
    </a-drawer>

    <!-- ── Template library picker ──────────────────────────────────────────── -->
    <a-drawer
      :open="templateLibraryOpen"
      title="Choose a template"
      width="480"
      @close="templateLibraryOpen = false"
    >
      <a-input
        v-model:value="templateSearch"
        placeholder="Search templates…"
        allow-clear
        style="margin-bottom: 16px"
      >
        <template #prefix><SearchOutlined /></template>
      </a-input>

      <a-spin v-if="templatesLoading" />
      <template v-else>
        <div v-for="[category, templates] in templatesByCategory" :key="category" style="margin-bottom: 20px">
          <div style="font-weight: 600; font-size: 12px; color: #888; text-transform: uppercase; margin-bottom: 8px">
            {{ category }}
          </div>
          <div
            v-for="t in templates"
            :key="t.builtin ? t.id : t.uuid"
            style="border: 1px solid #eee; border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; cursor: pointer"
            @click="applyTemplate(t)"
          >
            <div style="display: flex; align-items: center; justify-content: space-between">
              <span style="font-weight: 500">{{ t.name }}</span>
              <DeleteOutlined
                v-if="!t.builtin"
                style="color: #999"
                @click.stop="deleteTemplate(t.uuid)"
              />
            </div>
            <div v-if="t.purpose" style="font-size: 12px; color: #888; margin: 4px 0">{{ t.purpose }}</div>
            <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px">
              <a-tag v-for="m in t.methods" :key="m" :color="methodColor(m)" style="font-size: 10px">{{ m }}</a-tag>
            </div>
          </div>
        </div>
        <a-empty v-if="templatesByCategory.size === 0" description="No templates found" />
      </template>
    </a-drawer>

    <!-- ── Save current rule as template ────────────────────────────────────── -->
    <a-modal
      :open="saveTemplateModalOpen"
      title="Save as template"
      ok-text="Save"
      :confirm-loading="saveTemplateSaving"
      @ok="saveAsTemplate"
      @cancel="saveTemplateModalOpen = false"
    >
      <a-form layout="vertical">
        <a-form-item label="Template name" required>
          <a-input
            v-model:value="saveTemplateName"
            placeholder="e.g. My zone temperature preset"
            @press-enter="saveAsTemplate"
          />
        </a-form-item>
      </a-form>
      <p style="font-size: 12px; color: #888">
        Saves the current methods, threshold, window size, min confidence, cooldown, seasonality,
        and expected range as a reusable template under "My templates".
      </p>
    </a-modal>
  </AppLayout>
</template>

<style scoped>
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  gap: 8px;
  flex-wrap: wrap;
}

@keyframes severity-pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 7px 2px rgba(255, 77, 79, 0.75); }
  50%       { opacity: 0;   box-shadow: none; }
}

.severity-critical {
  animation: severity-pulse 0.75s ease-in-out infinite;
}

.settings-page {
  max-width: 1440px;
  margin: 0;
}

.settings-page__notice {
  margin-top: 20px;
}

.settings-page__actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 4px;
  padding-top: 16px;
  border-top: 1px solid rgba(5, 5, 5, 0.06);
}

.sensitivity-control {
  width: 100%;
  max-width: 320px;
}

.sensitivity-control__row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.sensitivity-control__scale {
  display: flex;
  justify-content: space-between;
  font-size: 12.5px;
  color: #767676;
  margin-top: 5px;
  line-height: 1.5;
}

.drift-enabled-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
}

.drift-enabled-toggle__label {
  font-size: 12.5px;
  color: #767676;
}

.drift-alert-on {
  margin-top: 20px;
}

.drift-alert-on__label {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}

.drift-alert-on__info {
  color: #999;
  font-size: 12px;
  margin-left: 4px;
  cursor: help;
}

.drift-alert-on__info--sm {
  font-size: 11px;
}

.drift-alert-on__group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
}

.drift-alert-on__group :deep(.ant-checkbox-wrapper) {
  margin-inline-start: 0;
}
</style>
