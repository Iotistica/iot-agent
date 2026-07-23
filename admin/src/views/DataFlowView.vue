<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import type { TableColumnType } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import { pipelineApi, type SubscriptionActivity, type ActivityEvent } from '@/api/pipeline'

const subscriptions = ref<SubscriptionActivity[]>([])
const events = ref<ActivityEvent[]>([])
const loading = ref(true)

const POLL_MS = 5000
let timer: ReturnType<typeof setInterval> | null = null

async function poll() {
  try {
    const [subs, evts] = await Promise.all([
      pipelineApi.getSubscriptions(),
      pipelineApi.getEvents(100),
    ])
    subscriptions.value = subs
    events.value = evts
  } catch {
    // non-fatal — keep showing last known state
  } finally {
    loading.value = false
  }
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

const subscriptionColumns: TableColumnType<SubscriptionActivity>[] = [
  { title: 'Source', key: 'source' },
  { title: 'Destination', key: 'destination' },
  { title: 'Last Metric', dataIndex: 'lastMetric', key: 'lastMetric' },
  { title: 'Last Value', key: 'lastValue' },
  { title: 'Points', dataIndex: 'pointCount', key: 'pointCount', width: 80 },
  { title: 'Last Publish', key: 'lastPublishTime', width: 110 },
]

const eventColumns: TableColumnType<ActivityEvent>[] = [
  { title: 'Time', key: 'time', width: 90 },
  { title: 'Source', key: 'source' },
  { title: 'Metric', dataIndex: 'metric', key: 'metric' },
  { title: 'Value', key: 'value' },
  { title: 'Destination', dataIndex: 'destinationName', key: 'destinationName' },
]

onMounted(() => {
  poll()
  timer = setInterval(poll, POLL_MS)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <AppLayout title="Data Flow">

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
        row-key="key"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'source'">
            <a-tag color="blue">{{ record.protocol }}</a-tag>
            {{ record.endpointName }}
          </template>
          <template v-else-if="column.key === 'destination'">
            {{ record.destinationName }}
            <a-tag style="margin-left: 4px">{{ record.destinationType }}</a-tag>
          </template>
          <template v-else-if="column.key === 'lastValue'">
            <a-tag v-if="record.lastQuality === 'BAD' && isMissingValue(record.lastValue)" color="red">No Value</a-tag>
            <template v-else>
              <span style="font-family: monospace">{{ fmtValue(record.lastValue) }}</span>
              <a-tag v-if="record.lastQuality === 'BAD'" color="red" style="margin-left: 4px">BAD</a-tag>
            </template>
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
      <a-table
        :columns="eventColumns"
        :data-source="events"
        :loading="loading"
        :pagination="{ pageSize: 20, size: 'small' }"
        row-key="id"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'time'">
            {{ fmtTime(record.timestamp) }}
          </template>
          <template v-else-if="column.key === 'source'">
            <a-tag color="blue">{{ record.protocol }}</a-tag>
            {{ record.endpointName }}
          </template>
          <template v-else-if="column.key === 'value'">
            <a-tag v-if="record.quality === 'BAD' && isMissingValue(record.value)" color="red">No Value</a-tag>
            <template v-else>
              <span style="font-family: monospace">{{ fmtValue(record.value) }}</span>
              <a-tag v-if="record.quality === 'BAD'" color="red" style="margin-left: 4px">BAD</a-tag>
            </template>
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
