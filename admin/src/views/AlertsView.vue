<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { message } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import { eventsApi, RESOLUTION_REASON_LABELS, type ResolutionReason } from '@/api/events'
import { SOURCE_OPTIONS, sourceLabel, sourceColor } from '@/utils/eventSources'
import type { AgentEvent, AgentIncident, AgentAlert } from '@/types'

const SEVERITY_TAG_COLOR: Record<string, string> = {
  critical: 'red',
  warning: 'orange',
  info: 'blue',
}
const SEVERITY_ORDER = ['info', 'warning', 'critical']

function fmtTs(ms: number | string): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString()
}

function stripGuids(text: string): string {
  return text ? text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_/gi, '') : text
}

// ── Auto-refresh ─────────────────────────────────────────────────────────────
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

// ── Shared state ─────────────────────────────────────────────────────────────
const activeTab = ref('events')
const sourceFilter = ref('')
const PAGE_SIZE = 50

const INCIDENT_STATUS_COLOR: Record<string, string> = { open: 'orange', active: 'red', resolved: 'green' }

// ── Events ───────────────────────────────────────────────────────────────────
const events = ref<AgentEvent[]>([])
const eventsTotal = ref(0)
const eventsLoading = ref(false)
const eventsSeverity = ref('')
const eventsPage = ref(1)

const eventColumns = [
  { title: 'Source', key: 'source', width: 120, sorter: (a: AgentEvent, b: AgentEvent) => a.source.localeCompare(b.source) },
  { title: 'Severity', key: 'severity', width: 100, sorter: (a: AgentEvent, b: AgentEvent) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) },
  { title: 'Message', key: 'message', ellipsis: true },
  { title: 'Device', key: 'device_name', width: 160, ellipsis: true },
  { title: 'Time', key: 'time', width: 170, sorter: (a: AgentEvent, b: AgentEvent) => a.timestamp_ms - b.timestamp_ms },
]

async function loadEvents() {
  eventsLoading.value = true
  try {
    const r = await eventsApi.getEvents({
      source: sourceFilter.value || undefined,
      severity: eventsSeverity.value || undefined,
      limit: PAGE_SIZE,
      offset: (eventsPage.value - 1) * PAGE_SIZE,
    })
    events.value = r.events
    eventsTotal.value = r.total
  } catch { /* non-fatal */ } finally {
    eventsLoading.value = false
  }
}

// ── Incidents ────────────────────────────────────────────────────────────────
const incidents = ref<AgentIncident[]>([])
const incidentsTotal = ref(0)
const incidentsLoading = ref(false)
const incidentsStatus = ref('')
const incidentsPage = ref(1)
const resolvingId = ref<string | null>(null)

const incidentColumns = [
  { title: 'Source', key: 'source', width: 120, sorter: (a: AgentIncident, b: AgentIncident) => a.source.localeCompare(b.source) },
  { title: 'Severity', key: 'severity', width: 95, sorter: (a: AgentIncident, b: AgentIncident) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) },
  { title: 'Fingerprint', key: 'fingerprint', ellipsis: true },
  { title: 'Device', key: 'device_name', width: 160, ellipsis: true },
  { title: 'Status', key: 'status', width: 90, sorter: (a: AgentIncident, b: AgentIncident) => a.status.localeCompare(b.status) },
  { title: 'Events', dataIndex: 'event_count', key: 'event_count', width: 70, sorter: (a: AgentIncident, b: AgentIncident) => a.event_count - b.event_count },
  { title: 'First seen', key: 'first_seen', width: 155, sorter: (a: AgentIncident, b: AgentIncident) => a.first_seen - b.first_seen },
  { title: 'Last seen', key: 'last_seen', width: 155, sorter: (a: AgentIncident, b: AgentIncident) => a.last_seen - b.last_seen },
  { title: '', key: 'actions', width: 90, fixed: 'right' as const },
]

async function loadIncidents() {
  incidentsLoading.value = true
  try {
    const r = await eventsApi.getIncidents({
      source: sourceFilter.value || undefined,
      status: incidentsStatus.value || undefined,
      limit: PAGE_SIZE,
      offset: (incidentsPage.value - 1) * PAGE_SIZE,
    })
    incidents.value = r.incidents
    incidentsTotal.value = r.total
  } catch { /* non-fatal */ } finally {
    incidentsLoading.value = false
  }
}

// ── Resolve modal ────────────────────────────────────────────────────────────
const resolveModalOpen = ref(false)
const resolveModalIncident = ref<AgentIncident | null>(null)
const resolveModalReason = ref<ResolutionReason | undefined>(undefined)
const resolveModalNotes = ref('')

function openResolveModal(incident: AgentIncident) {
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
    await eventsApi.resolveIncident(incident.incident_id, resolveModalReason.value, resolveModalNotes.value.trim() || undefined)
    message.success('Incident resolved')
    resolveModalOpen.value = false
    loadIncidents()
  } catch (err: unknown) {
    message.error((err as { message?: string })?.message ?? 'Failed to resolve')
  } finally {
    resolvingId.value = null
  }
}

// ── Alerts ───────────────────────────────────────────────────────────────────
const alerts = ref<AgentAlert[]>([])
const alertsTotal = ref(0)
const alertsLoading = ref(false)
const alertsPage = ref(1)

const alertColumns = [
  { title: 'Source', key: 'source', width: 120, sorter: (a: AgentAlert, b: AgentAlert) => a.source.localeCompare(b.source) },
  { title: 'Severity', key: 'severity', width: 100, sorter: (a: AgentAlert, b: AgentAlert) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) },
  { title: 'Device', key: 'device_name', width: 160, ellipsis: true },
  { title: 'Message', key: 'message', ellipsis: true },
  { title: 'Time', key: 'time', width: 170, sorter: (a: AgentAlert, b: AgentAlert) => a.created_at - b.created_at },
]

async function loadAlerts() {
  alertsLoading.value = true
  try {
    const r = await eventsApi.getAlerts({
      source: sourceFilter.value || undefined,
      limit: PAGE_SIZE,
      offset: (alertsPage.value - 1) * PAGE_SIZE,
    })
    alerts.value = r.alerts
    alertsTotal.value = r.total
  } catch { /* non-fatal */ } finally {
    alertsLoading.value = false
  }
}

// ── Tab switching ────────────────────────────────────────────────────────────
function reloadActiveTab() {
  stopTabAutoRefresh()
  if (activeTab.value === 'events') { loadEvents(); startTabAutoRefresh(loadEvents, eventsLoading) }
  else if (activeTab.value === 'incidents') { loadIncidents(); startTabAutoRefresh(loadIncidents, incidentsLoading) }
  else if (activeTab.value === 'alerts') { loadAlerts(); startTabAutoRefresh(loadAlerts, alertsLoading) }
}

function onTabChange(tab: string) {
  activeTab.value = tab
  reloadActiveTab()
}

function onSourceChange() {
  eventsPage.value = 1
  incidentsPage.value = 1
  alertsPage.value = 1
  reloadActiveTab()
}

onMounted(() => {
  loadEvents()
  startTabAutoRefresh(loadEvents, eventsLoading)
})

onUnmounted(() => {
  stopTabAutoRefresh()
})
</script>

<template>
  <AppLayout title="Alerts">
    <div class="heading">
      <p>Events, incidents, and alerts from all agent sources.</p>
    </div>

    <div class="filters" style="margin-bottom: 4px">
      <a-select
        v-model:value="sourceFilter"
        placeholder="All Sources"
        allow-clear
        class="filter"
        @change="onSourceChange"
      >
        <a-select-option v-for="opt in SOURCE_OPTIONS" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </a-select-option>
      </a-select>
    </div>

    <a-tabs :active-key="activeTab" @change="onTabChange">

      <!-- ══ EVENTS ═══════════════════════════════════════════════════════════ -->
      <a-tab-pane key="events" tab="Events">
        <a-card size="small" class="list-card">
          <div class="toolbar-info" style="display: flex; justify-content: space-between; align-items: center">
            <span>{{ eventsTotal }} total · auto-refresh 5s</span>
          </div>
          <div class="filters" style="margin-bottom: 8px">
            <a-select
              v-model:value="eventsSeverity"
              placeholder="All severities"
              allow-clear
              class="filter"
              @change="() => { eventsPage = 1; loadEvents() }"
            >
              <a-select-option value="critical">Critical</a-select-option>
              <a-select-option value="warning">Warning</a-select-option>
              <a-select-option value="info">Info</a-select-option>
            </a-select>
          </div>
          <a-table
            :columns="eventColumns"
            :data-source="events"
            :loading="eventsLoading && events.length === 0"
            :pagination="{ current: eventsPage, pageSize: PAGE_SIZE, total: eventsTotal, showSizeChanger: false, onChange: (p: number) => { eventsPage = p; loadEvents() } }"
            row-key="id"
            size="small"
            :scroll="{ x: true }"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'source'">
                <a-tag :color="sourceColor(record.source)" style="margin: 0">{{ sourceLabel(record.source) }}</a-tag>
              </template>
              <template v-else-if="column.key === 'severity'">
                <a-tag :color="SEVERITY_TAG_COLOR[record.severity]" :class="record.severity === 'critical' ? 'severity-critical' : ''" style="margin: 0">{{ record.severity }}</a-tag>
              </template>
              <template v-else-if="column.key === 'message'">
                <span :title="record.message" style="white-space: normal; word-break: break-word">{{ stripGuids(record.message) }}</span>
              </template>
              <template v-else-if="column.key === 'device_name'">
                {{ record.device_name || '—' }}
              </template>
              <template v-else-if="column.key === 'time'">
                <span style="color: var(--text-tertiary)">{{ fmtTs(record.timestamp_ms) }}</span>
              </template>
            </template>
            <template #emptyText>
              <div style="padding: 24px 0; text-align: center; color: var(--text-muted); font-size: 13px">
                No events yet. Events are recorded when the agent detects anomalies, schema changes, or other notable activity.
              </div>
            </template>
          </a-table>
        </a-card>
      </a-tab-pane>

      <!-- ══ INCIDENTS ════════════════════════════════════════════════════════ -->
      <a-tab-pane key="incidents" tab="Incidents">
        <a-card size="small" class="list-card">
          <div class="toolbar-info" style="display: flex; justify-content: space-between; align-items: center">
            <span>{{ incidentsTotal }} total · auto-refresh 5s</span>
          </div>
          <div class="filters" style="margin-bottom: 8px">
            <a-select
              v-model:value="incidentsStatus"
              placeholder="All statuses"
              allow-clear
              class="filter"
              @change="() => { incidentsPage = 1; loadIncidents() }"
            >
              <a-select-option value="open">Open</a-select-option>
              <a-select-option value="active">Active</a-select-option>
              <a-select-option value="resolved">Resolved</a-select-option>
            </a-select>
          </div>
          <a-table
            :columns="incidentColumns"
            :data-source="incidents"
            :loading="incidentsLoading && incidents.length === 0"
            :pagination="{ current: incidentsPage, pageSize: PAGE_SIZE, total: incidentsTotal, showSizeChanger: false, onChange: (p: number) => { incidentsPage = p; loadIncidents() } }"
            row-key="incident_id"
            size="small"
            :scroll="{ x: true }"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'source'">
                <a-tag :color="sourceColor(record.source)" style="margin: 0">{{ sourceLabel(record.source) }}</a-tag>
              </template>
              <template v-else-if="column.key === 'severity'">
                <a-tag :color="SEVERITY_TAG_COLOR[record.severity]" :class="record.severity === 'critical' && record.status !== 'resolved' ? 'severity-critical' : ''" style="margin: 0">{{ record.severity }}</a-tag>
              </template>
              <template v-else-if="column.key === 'fingerprint'">
                <span :title="record.fingerprint" style="font-family: monospace; font-size: 12px">{{ record.fingerprint.slice(0, 12) }}…</span>
              </template>
              <template v-else-if="column.key === 'device_name'">
                {{ record.device_name || '—' }}
              </template>
              <template v-else-if="column.key === 'status'">
                <a-tag :color="INCIDENT_STATUS_COLOR[record.status]" style="margin: 0">{{ record.status }}</a-tag>
              </template>
              <template v-else-if="column.key === 'first_seen'">
                <span style="color: var(--text-tertiary)">{{ fmtTs(record.first_seen) }}</span>
              </template>
              <template v-else-if="column.key === 'last_seen'">
                <span style="color: var(--text-tertiary)">{{ fmtTs(record.last_seen) }}</span>
              </template>
              <template v-else-if="column.key === 'actions'">
                <a-button
                  v-if="record.status !== 'resolved'"
                  size="small"
                  :loading="resolvingId === record.incident_id"
                  @click="openResolveModal(record)"
                >Resolve</a-button>
                <span v-else style="color: var(--text-tertiary)">—</span>
              </template>
            </template>
            <template #emptyText>
              <div style="padding: 24px 0; text-align: center; color: var(--text-muted); font-size: 13px">
                No incidents yet. Incidents are created when multiple events share the same fingerprint.
              </div>
            </template>
          </a-table>
        </a-card>
      </a-tab-pane>

      <!-- ══ ALERTS ═══════════════════════════════════════════════════════════ -->
      <a-tab-pane key="alerts" tab="Alerts">
        <a-card size="small" class="list-card">
          <div class="toolbar-info" style="display: flex; justify-content: space-between; align-items: center">
            <span>{{ alertsTotal }} total · auto-refresh 5s</span>
          </div>
          <a-table
            :columns="alertColumns"
            :data-source="alerts"
            :loading="alertsLoading && alerts.length === 0"
            :pagination="{ current: alertsPage, pageSize: PAGE_SIZE, total: alertsTotal, showSizeChanger: false, onChange: (p: number) => { alertsPage = p; loadAlerts() } }"
            row-key="alert_id"
            size="small"
            :scroll="{ x: true }"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'source'">
                <a-tag :color="sourceColor(record.source)" style="margin: 0">{{ sourceLabel(record.source) }}</a-tag>
              </template>
              <template v-else-if="column.key === 'severity'">
                <a-tag :color="SEVERITY_TAG_COLOR[record.severity]" :class="record.severity === 'critical' ? 'severity-critical' : ''" style="margin: 0">{{ record.severity }}</a-tag>
              </template>
              <template v-else-if="column.key === 'device_name'">
                {{ record.device_name || '—' }}
              </template>
              <template v-else-if="column.key === 'message'">
                <span :title="record.message" style="white-space: normal; word-break: break-word">{{ stripGuids(record.message) }}</span>
              </template>
              <template v-else-if="column.key === 'time'">
                <span style="color: var(--text-tertiary)">{{ fmtTs(record.created_at) }}</span>
              </template>
            </template>
            <template #emptyText>
              <div style="padding: 24px 0; text-align: center; color: var(--text-muted); font-size: 13px">
                No alerts promoted yet. Alerts are raised when an incident accumulates enough events.
              </div>
            </template>
          </a-table>
        </a-card>
      </a-tab-pane>

    </a-tabs>

    <!-- ── Resolve incident modal ─────────────────────────────────────────── -->
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
        Resolve incident on {{ resolveModalIncident.device_name || 'unknown device' }}.
      </p>
      <a-form layout="vertical">
        <a-form-item label="Reason" required>
          <a-select v-model:value="resolveModalReason" placeholder="Why is this being resolved?" style="width: 100%">
            <a-select-option v-for="(label, value) in RESOLUTION_REASON_LABELS" :key="value" :value="value">
              {{ label }}
            </a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="Notes" style="margin-bottom: 0">
          <a-textarea v-model:value="resolveModalNotes" placeholder="Optional" :rows="2" />
        </a-form-item>
      </a-form>
    </a-modal>
  </AppLayout>
</template>

<style scoped>
.heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
.heading p { color: var(--text-tertiary); margin: 0; }
.list-card { border-radius: 9px; }
.list-card :deep(.ant-table-thead > tr > th) { background: var(--bg-table-header); font-size: 12px; font-weight: 650; }
.list-card :deep(.ant-table-tbody > tr:hover > td) { background: var(--bg-table-hover); }
.filters { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.filter { width: 170px; max-width: 100%; }
.toolbar-info { color: var(--text-tertiary); font-size: 12px; margin-bottom: 10px; }

@keyframes severity-pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 7px 2px rgba(255, 77, 79, 0.75); }
  50%       { opacity: 0; box-shadow: none; }
}
.severity-critical {
  animation: severity-pulse 0.75s ease-in-out infinite;
}
</style>
