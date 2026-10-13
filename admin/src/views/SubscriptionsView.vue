<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { PlusOutlined, EditOutlined, DeleteOutlined, CheckCircleOutlined, StopOutlined } from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import SubscriptionDrawer from '@/components/subscriptions/SubscriptionDrawer.vue'
import type { Destination, Subscription } from '@/types'
import { subscriptionsApi } from '@/api/subscriptions'
import { destinationsApi } from '@/api/destinations'
import { settingsApi } from '@/api/settings'
import { sourcesApi } from '@/api/sources'
import { protocolColor, destinationColor } from '@/utils/protocol'
import { buildIotisticaTopicBase } from '@/utils/mqtt'

const rows = ref<Subscription[]>([])
const destinations = ref<Destination[]>([])
const deviceNames = ref<string[]>([])
const metricNames = ref<string[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const drawerOpen = ref(false)
const editing = ref<Subscription | null>(null)
const iotisticaTopicBase = ref<string | null>(null)
const selectedIds = ref<(string | number)[]>([])
const deleting = ref(false)
const bulkEnabling = ref(false)
const bulkDisabling = ref(false)

const rowSelection = computed(() => ({
  selectedRowKeys: selectedIds.value,
  onChange: (keys: (string | number)[]) => { selectedIds.value = keys },
}))

const destMap = computed<Record<number, Destination>>(() =>
  Object.fromEntries(destinations.value.map((d) => [d.id, d])),
)

const search = ref('')
const destFilter = ref<number | undefined>(undefined)
const filteredRows = computed(() => rows.value.filter(r => {
  const q = search.value.trim().toLowerCase()
  const destName = destMap.value[r.publish_destination_id]?.name ?? ''
  return (!q || [destName, r.publish_topic, r.payload_format].some(v => (v || '').toLowerCase().includes(q)))
    && (!destFilter.value || r.publish_destination_id === destFilter.value)
}))
const destOptions = computed(() => destinations.value.map(d => ({ value: d.id, label: d.name })))
function clearFilters() { search.value = ''; destFilter.value = undefined }

const columns: TableColumnType<Subscription>[] = [
  { title: 'Destination', key: 'destination', width: 180, sorter: (a, b) => (destMap.value[a.publish_destination_id]?.name ?? '').localeCompare(destMap.value[b.publish_destination_id]?.name ?? '') },
  { title: 'Type', key: 'dest_type', width: 120 },
  { title: 'Topic', key: 'topic', sorter: (a, b) => (a.publish_topic ?? '').localeCompare(b.publish_topic ?? '') },
  { title: 'Protocol', dataIndex: 'topics', key: 'topics', width: 160 },
  { title: 'Format', dataIndex: 'payload_format', key: 'payload_format', width: 100, sorter: (a, b) => (a.payload_format ?? '').localeCompare(b.payload_format ?? '') },
  { title: 'Compression', dataIndex: 'compression', key: 'compression', width: 160 },
  { title: 'Enabled', dataIndex: 'enabled', key: 'enabled', width: 90, sorter: (a, b) => Number(a.enabled) - Number(b.enabled) },
  { title: 'Actions', key: 'actions', width: 110, fixed: 'right' },
]

async function load() {
  loading.value = true
  error.value = null
  try {
    const [subs, dests, settings, endpoints] = await Promise.all([
      subscriptionsApi.getAll(),
      destinationsApi.getAll(),
      settingsApi.get(),
      sourcesApi.getAll().catch(() => []),
    ])
    rows.value = subs
    destinations.value = dests
    deviceNames.value = endpoints.map((e) => e.name)
    metricNames.value = endpoints.flatMap((e) =>
      ((e.data_points ?? []) as { name?: string }[]).map((dp) => dp.name).filter((n): n is string => !!n),
    )
    const { uuid, tenantId } = settings.agent ?? {}
    if (uuid && tenantId) iotisticaTopicBase.value = buildIotisticaTopicBase(uuid, tenantId)
  } catch (err: unknown) {
    const e = err as { message?: string }
    error.value = e?.message ?? 'Failed to load'
  } finally {
    loading.value = false
  }
}

async function toggleEnabled(row: Subscription) {
  try {
    const updated = await subscriptionsApi.update(row.id, { enabled: !row.enabled })
    const idx = rows.value.findIndex((r) => r.id === row.id)
    if (idx !== -1) rows.value[idx] = updated
  } catch {
    message.error('Failed to update')
  }
}

function openCreate() {
  editing.value = null
  drawerOpen.value = true
}

function openEdit(row: Subscription) {
  editing.value = row
  drawerOpen.value = true
}

function confirmDelete(row: Subscription) {
  Modal.confirm({
    title: 'Delete this subscription?',
    okType: 'danger',
    okText: 'Delete',
    async onOk() {
      await subscriptionsApi.delete(row.id)
      message.success('Deleted')
      await load()
    },
  })
}

function confirmDeleteSelected() {
  const count = selectedIds.value.length
  Modal.confirm({
    title: `Delete ${count} subscription${count !== 1 ? 's' : ''}?`,
    okType: 'danger',
    okText: `Delete ${count}`,
    async onOk() {
      deleting.value = true
      try {
        await Promise.allSettled(selectedIds.value.map((id) => subscriptionsApi.delete(id as number)))
        selectedIds.value = []
        message.success(`Deleted ${count} subscription${count !== 1 ? 's' : ''}`)
        await load()
      } finally {
        deleting.value = false
      }
    },
  })
}

async function bulkEnable() {
  const ids = [...selectedIds.value] as number[]
  bulkEnabling.value = true
  try {
    await Promise.allSettled(ids.map((id) => subscriptionsApi.update(id, { enabled: true })))
    selectedIds.value = []
    message.success(`Enabled ${ids.length} subscription${ids.length !== 1 ? 's' : ''}`)
    await load()
  } finally {
    bulkEnabling.value = false
  }
}

async function bulkDisable() {
  const ids = [...selectedIds.value] as number[]
  bulkDisabling.value = true
  try {
    await Promise.allSettled(ids.map((id) => subscriptionsApi.update(id, { enabled: false })))
    selectedIds.value = []
    message.success(`Disabled ${ids.length} subscription${ids.length !== 1 ? 's' : ''}`)
    await load()
  } finally {
    bulkDisabling.value = false
  }
}

onMounted(load)
</script>

<template>
  <AppLayout title="Subscriptions">
    <div class="heading">
      <p>Map sources and metrics to destinations.</p>
      <div class="header-actions">
        <template v-if="selectedIds.length > 0">
          <span style="font-size: 13px; color: #666">{{ selectedIds.length }} selected</span>
          <a-button :loading="bulkEnabling" @click="bulkEnable"><template #icon><CheckCircleOutlined /></template>Enable</a-button>
          <a-button :loading="bulkDisabling" @click="bulkDisable"><template #icon><StopOutlined /></template>Disable</a-button>
          <a-button danger :loading="deleting" @click="confirmDeleteSelected"><template #icon><DeleteOutlined /></template>Delete</a-button>
        </template>
        <a-button type="primary" :disabled="destinations.length === 0" @click="openCreate"><template #icon><PlusOutlined /></template>New Subscription</a-button>
      </div>
    </div>

    <a-alert v-if="destinations.length === 0 && !loading" type="warning" message="Create a destination first before adding subscriptions." show-icon style="margin-bottom: 16px" />
    <a-alert v-if="error" type="error" :message="error" show-icon style="margin-bottom: 16px" />

    <a-card size="small" class="list-card">
      <div class="filters">
        <a-input v-model:value="search" placeholder="Search destination, topic, format…" allow-clear class="search" />
        <a-select v-model:value="destFilter" :options="destOptions" placeholder="All destinations" allow-clear class="filter" />
        <a-button @click="clearFilters">Clear</a-button>
      </div>
      <div class="toolbar-info">Showing {{ filteredRows.length }} of {{ rows.length }} subscriptions</div>
      <a-table
        :columns="columns"
        :data-source="filteredRows"
        :loading="loading"
        :pagination="{ pageSize: 20, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'] }"
        :row-selection="rowSelection"
        row-key="id"
        size="small"
      >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'destination'">
          <span v-if="destMap[record.publish_destination_id]">
            {{ destMap[record.publish_destination_id].name }}
          </span>
          <span v-else style="color: #999">ID {{ record.publish_destination_id }}</span>
        </template>

        <template v-else-if="column.key === 'dest_type'">
          <a-tag v-if="destMap[record.publish_destination_id]"
            :color="destinationColor(destMap[record.publish_destination_id].type)"
            style="margin: 0"
          >
            {{ destMap[record.publish_destination_id].type }}
          </a-tag>
          <span v-else style="color: #999">—</span>
        </template>

        <template v-else-if="column.key === 'topic'">
          <span v-if="record.route_json?.topic">
            {{ record.route_json.topic }}
          </span>
          <span v-else style="color: #999">—</span>
        </template>

        <template v-else-if="column.key === 'topics'">
          <template v-if="record.topics?.length">
            <a-tag v-for="t in record.topics" :key="t" :color="protocolColor(t)" style="margin-bottom: 2px">{{ t }}</a-tag>
          </template>
          <span v-else style="color: #999">all</span>
        </template>

        <template v-else-if="column.key === 'payload_format'">
          {{ record.payload_format === 'custom' ? 'Iotistica' : record.payload_format === 'ml' ? 'ML / Training' : record.payload_format }}
        </template>

        <template v-else-if="column.key === 'compression'">
          <span v-if="record.compression">{{ record.compression }}</span>
          <span v-else style="color: #999">none</span>
        </template>

        <template v-else-if="column.key === 'enabled'">
          <a-switch
            :checked="record.enabled"
            size="small"
            @change="toggleEnabled(record)"
          />
        </template>

        <template v-else-if="column.key === 'actions'">
          <a-space>
            <a-button size="small" @click="openEdit(record)">
              <template #icon><EditOutlined /></template>
            </a-button>
            <a-button size="small" danger @click="confirmDelete(record)">
              <template #icon><DeleteOutlined /></template>
            </a-button>
          </a-space>
        </template>
      </template>
    </a-table>
    </a-card>

    <SubscriptionDrawer
      v-model:open="drawerOpen"
      :editing="editing"
      :destinations="destinations"
      :device-names="deviceNames"
      :metric-names="metricNames"
      :iotistica-topic-base="iotisticaTopicBase ?? undefined"
      @saved="load"
    />
  </AppLayout>
</template>

<style scoped>
.heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
.heading p { color: #777; margin: 0; }
.header-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.list-card { border-radius: 9px; }
.list-card :deep(.ant-table-thead > tr > th) { background: #f7f9fc; font-size: 12px; font-weight: 650; }
.list-card :deep(.ant-table-tbody > tr:hover > td) { background: #f5f9ff; }
.filters { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.search { width: 300px; max-width: 100%; }
.filter { width: 170px; max-width: 100%; }
.toolbar-info { color: #888; font-size: 12px; margin-bottom: 10px; }
</style>
