<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import type { TableColumnType } from 'ant-design-vue'
import { SearchOutlined } from '@ant-design/icons-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import { client } from '@/api/client'
import { pipelineApi, type SubscriptionActivity, type ActivityEvent } from '@/api/pipeline'
import { protocolColor, protocolLabel } from '@/utils/protocol'

const subscriptions = ref<SubscriptionActivity[]>([])
const events = ref<ActivityEvent[]>([])
const loading = ref(true)

// The pipeline's per-reading source identity is built as "<sanitized-name>-<uuid8>"
// for uniqueness (see readExternalNodeCandidate/deviceConfig.name server-side) —
// not the human-friendly name the Sources page shows (metadata.objectName, e.g.
// "AHU-11" vs "ahu_11_5018"). Fetch the device list once and map that exact
// compound string back to the friendly name so both pages agree on what a
// source is called. Falls back to the raw string when nothing matches (e.g. a
// source whose identity isn't device-scoped).
interface DeviceRecord {
  uuid: string
  name: string
  metadata?: Record<string, unknown>
}
const deviceDisplayNameByKey = ref<Map<string, string>>(new Map())
async function ensureDeviceMap() {
  if (deviceDisplayNameByKey.value.size > 0) return
  try {
    const { data } = await client.get<{ devices: DeviceRecord[] }>('/v1/devices')
    const map = new Map<string, string>()
    for (const d of data.devices) {
      const friendly = (d.metadata?.objectName as string | undefined) || d.name
      map.set(`${d.name}-${d.uuid.slice(0, 8)}`, friendly)
    }
    deviceDisplayNameByKey.value = map
  } catch { /* non-fatal — falls back to raw source strings */ }
}
function friendlySource(endpointName: string): string {
  return deviceDisplayNameByKey.value.get(endpointName) || endpointName
}

// Client-side — events is already just the last 100 rows from a 5s poll, so
// there's no round trip to debounce against.
const eventSourceFilter = ref('')
const eventMetricFilter = ref('')
const eventProtocolFilter = ref('')
const filteredEvents = computed(() => {
  const sourceQ = eventSourceFilter.value.trim().toLowerCase()
  const metricQ = eventMetricFilter.value.trim().toLowerCase()
  return events.value.filter((e) =>
    (!sourceQ || friendlySource(e.endpointName).toLowerCase().includes(sourceQ)) &&
    (!metricQ || e.metric.toLowerCase().includes(metricQ)) &&
    (!eventProtocolFilter.value || e.protocol.toLowerCase() === eventProtocolFilter.value)
  )
})

const POLL_MS = 5000
let timer: ReturnType<typeof setInterval> | null = null

async function poll() {
  try {
    const [subs, evts] = await Promise.all([
      pipelineApi.getSubscriptions(),
      pipelineApi.getEvents(100, eventProtocolFilter.value || undefined),
    ])
    subscriptions.value = subs
    events.value = evts
  } catch {
    // non-fatal — keep showing last known state
  } finally {
    loading.value = false
  }
}

// Metric names embed the device's own name for global uniqueness (e.g. BACnet
// object names are "<device>.<point>", sanitized to "<device>_<point>") — the
// Source column already shows the device, so strip whatever prefix the two
// share instead of repeating it in the Metric column. Falls back to the full
// metric name when there's no shared prefix (e.g. system metrics, or a
// fallback source that's just the coarse protocol group name).
function metricLeaf(metric: string, source: string): string {
  let i = 0
  while (i < metric.length && i < source.length && metric[i] === source[i]) i++
  while (i > 0 && metric[i - 1] !== '_') i--
  return i > 0 && i < metric.length ? metric.slice(i) : metric
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2)
  return String(v)
}

// A BAD-quality read with no value at all (the read failed outright — timeout,
// unreachable, etc.) is a different, more common case than a real value that's
// merely flagged bad — collapse the former into one plain "No Value" tag
// instead of a redundant "— BAD" pair.
function isMissingValue(v: unknown): boolean {
  return v === null || v === undefined
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  const diffSec = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000))
  if (diffSec < 5) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// Every column gets an explicit width so the table renders with a fixed
// layout — otherwise ant-design-vue sizes columns from content, and since
// this view refreshes every 5s with metric names/values of varying length,
// columns visibly shift width on each poll. ellipsis truncates long text
// instead of letting it stretch the column back out.
const subscriptionColumns: TableColumnType<SubscriptionActivity>[] = [
  { title: 'Protocol', key: 'protocol', width: 100 },
  { title: 'Source', key: 'source', width: 220, ellipsis: true },
  { title: 'Destination', key: 'destination', width: 180, ellipsis: true },
  { title: 'Last Metric', dataIndex: 'lastMetric', key: 'lastMetric', width: 220, ellipsis: true },
  { title: 'Last Value', key: 'lastValue', width: 140, ellipsis: true },
  { title: 'Unit', key: 'lastUnit', width: 90, ellipsis: true },
  { title: 'Points', dataIndex: 'pointCount', key: 'pointCount', width: 80 },
  { title: 'Last Publish', key: 'lastPublishTime', width: 110 },
]

const eventColumns: TableColumnType<ActivityEvent>[] = [
  { title: 'Time', key: 'time', width: 90 },
  { title: 'Protocol', key: 'protocol', width: 100 },
  { title: 'Source', key: 'source', width: 220, ellipsis: true },
  { title: 'Metric', dataIndex: 'metric', key: 'metric', width: 220, ellipsis: true },
  { title: 'Value', key: 'value', width: 140, ellipsis: true },
  { title: 'Unit', key: 'unit', width: 90, ellipsis: true },
  { title: 'Destination', dataIndex: 'destinationName', key: 'destinationName', width: 160, ellipsis: true },
]

// Events are now fetched pre-filtered by protocol server-side (see poll()), so
// changing the dropdown must trigger an immediate refetch instead of waiting
// up to POLL_MS for the next tick to show the newly-scoped results.
watch(eventProtocolFilter, () => { poll() })

onMounted(() => {
  ensureDeviceMap()
  poll()
  timer = setInterval(poll, POLL_MS)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <AppLayout title="Live View">

    <a-alert
      type="info"
      show-icon
      message="Live view of data moving from Sources through Subscriptions to Destinations"
      description="Updates every 5 seconds. Shows the last value published per subscription, plus a rolling feed of recent publish activity."
      style="margin-bottom: 16px"
    />

    <a-card title="Active Subscriptions" size="small" style="margin-bottom: 16px">
      <a-table
        :columns="subscriptionColumns"
        :data-source="subscriptions"
        :loading="loading"
        :pagination="false"
        :scroll="{ x: true }"
        row-key="key"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'protocol'">
            <a-tag :color="protocolColor(record.protocol)">{{ protocolLabel(record.protocol) }}</a-tag>
          </template>
          <template v-else-if="column.key === 'source'">
            {{ friendlySource(record.endpointName) }}
          </template>
          <template v-else-if="column.key === 'destination'">
            {{ record.destinationName }}
            <a-tag style="margin-left: 4px">{{ record.destinationType }}</a-tag>
          </template>
          <template v-else-if="column.key === 'lastMetric'">
            {{ metricLeaf(record.lastMetric, record.endpointName) }}
          </template>
          <template v-else-if="column.key === 'lastValue'">
            <a-tag v-if="record.lastQuality === 'BAD' && isMissingValue(record.lastValue)" color="red">No Value</a-tag>
            <template v-else>
              <span style="font-family: monospace">{{ fmtValue(record.lastValue) }}</span>
              <a-tag v-if="record.lastQuality === 'BAD'" color="red" style="margin-left: 4px">BAD</a-tag>
            </template>
          </template>
          <template v-else-if="column.key === 'lastUnit'">
            {{ record.lastUnit || '—' }}
          </template>
          <template v-else-if="column.key === 'lastPublishTime'">
            {{ fmtTime(record.lastPublishTime) }}
          </template>
        </template>
        <template #emptyText>
          <div style="padding: 24px 0; text-align: center; color: #aaa; font-size: 13px">
            No data has been published yet — check that a Source, Subscription, and Destination are all configured and enabled.
          </div>
        </template>
      </a-table>
    </a-card>

    <a-card title="Recent Activity" size="small">
      <div style="display: flex; gap: 12px; margin-bottom: 12px">
        <a-input
          v-model:value="eventSourceFilter"
          placeholder="Search by source…"
          allow-clear
          style="width: 260px"
        >
          <template #prefix><SearchOutlined style="color: #bbb" /></template>
        </a-input>
        <a-input
          v-model:value="eventMetricFilter"
          placeholder="Search by metric…"
          allow-clear
          style="width: 260px"
        >
          <template #prefix><SearchOutlined style="color: #bbb" /></template>
        </a-input>
        <a-select
          v-model:value="eventProtocolFilter"
          placeholder="All protocols"
          allow-clear
          style="width: 180px"
        >
          <a-select-option value="modbus">Modbus</a-select-option>
          <a-select-option value="opcua">OPC-UA</a-select-option>
          <a-select-option value="mqtt">MQTT</a-select-option>
          <a-select-option value="bacnet">BACnet</a-select-option>
        </a-select>
      </div>
      <a-table
        :columns="eventColumns"
        :data-source="filteredEvents"
        :loading="loading"
        :pagination="{ pageSize: 20, size: 'small' }"
        :scroll="{ x: true }"
        row-key="id"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'time'">
            {{ fmtTime(record.timestamp) }}
          </template>
          <template v-else-if="column.key === 'protocol'">
            <a-tag :color="protocolColor(record.protocol)">{{ protocolLabel(record.protocol) }}</a-tag>
          </template>
          <template v-else-if="column.key === 'source'">
            {{ friendlySource(record.endpointName) }}
          </template>
          <template v-else-if="column.key === 'metric'">
            {{ metricLeaf(record.metric, record.endpointName) }}
          </template>
          <template v-else-if="column.key === 'value'">
            <a-tag v-if="record.quality === 'BAD' && isMissingValue(record.value)" color="red">No Value</a-tag>
            <template v-else>
              <span style="font-family: monospace">{{ fmtValue(record.value) }}</span>
              <a-tag v-if="record.quality === 'BAD'" color="red" style="margin-left: 4px">BAD</a-tag>
            </template>
          </template>
          <template v-else-if="column.key === 'unit'">
            {{ record.unit || '—' }}
          </template>
        </template>
        <template #emptyText>
          <div style="padding: 24px 0; text-align: center; color: #aaa; font-size: 13px">
            No recent activity yet
          </div>
        </template>
      </a-table>
    </a-card>

  </AppLayout>
</template>
