<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { PlusOutlined, EditOutlined, DeleteOutlined, CheckCircleOutlined, StopOutlined } from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import DestinationDrawer from '@/components/destinations/DestinationDrawer.vue'
import type { Destination } from '@/types'
import { destinationsApi } from '@/api/destinations'
import { settingsApi } from '@/api/settings'
import { destinationColor } from '@/utils/protocol'

const rows = ref<Destination[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const drawerOpen = ref(false)
const editing = ref<Destination | null>(null)
const activeType = ref<string | undefined>(undefined)
const search = ref('')
const provisioned = ref(false)
const selectedIds = ref<(string | number)[]>([])
const deleting = ref(false)
const bulkEnabling = ref(false)
const bulkDisabling = ref(false)

const rowSelection = computed(() => ({
  selectedRowKeys: selectedIds.value,
  onChange: (keys: (string | number)[]) => { selectedIds.value = keys },
}))

const availableTypes = computed(() => [...new Set(rows.value.map((r) => r.type))].sort()
  .map(t => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) })))

const filteredRows = computed(() => rows.value.filter(r => {
  const q = search.value.trim().toLowerCase()
  return (!q || [r.name, r.type, r.last_error].some(v => (v || '').toLowerCase().includes(q)))
    && (!activeType.value || r.type === activeType.value)
}))

function clearFilters() { search.value = ''; activeType.value = undefined }

const columns: TableColumnType<Destination>[] = [
  { title: 'Name', dataIndex: 'name', key: 'name', ellipsis: true, sorter: (a, b) => a.name.localeCompare(b.name) },
  { title: 'Type', dataIndex: 'type', key: 'type', width: 110, sorter: (a, b) => a.type.localeCompare(b.type) },
  { title: 'Enabled', dataIndex: 'enabled', key: 'enabled', width: 90, sorter: (a, b) => Number(a.enabled) - Number(b.enabled) },
  { title: 'Last Error', dataIndex: 'last_error', key: 'last_error', ellipsis: true },
  { title: 'Actions', key: 'actions', width: 110, fixed: 'right' },
]

async function load() {
  loading.value = true
  error.value = null
  try {
    rows.value = await destinationsApi.getAll()
  } catch (err: unknown) {
    const e = err as { message?: string }
    error.value = e?.message ?? 'Failed to load destinations'
  } finally {
    loading.value = false
  }
}

async function toggleEnabled(row: Destination) {
  try {
    const updated = await destinationsApi.update(row.id, { enabled: !row.enabled })
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

function openEdit(row: Destination) {
  editing.value = row
  drawerOpen.value = true
}

function confirmDelete(row: Destination) {
  Modal.confirm({
    title: `Delete "${row.name}"?`,
    content: 'This will remove the destination and all associated subscriptions.',
    okType: 'danger',
    okText: 'Delete',
    async onOk() {
      await destinationsApi.delete(row.id)
      message.success('Deleted')
      await load()
    },
  })
}

function confirmDeleteSelected() {
  const count = selectedIds.value.length
  Modal.confirm({
    title: `Delete ${count} destination${count !== 1 ? 's' : ''}?`,
    content: 'This will remove the selected destinations and all their associated subscriptions.',
    okType: 'danger',
    okText: `Delete ${count}`,
    async onOk() {
      deleting.value = true
      try {
        await Promise.allSettled(selectedIds.value.map((id) => destinationsApi.delete(id as number)))
        selectedIds.value = []
        message.success(`Deleted ${count} destination${count !== 1 ? 's' : ''}`)
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
    await Promise.allSettled(ids.map((id) => destinationsApi.update(id, { enabled: true })))
    selectedIds.value = []
    message.success(`Enabled ${ids.length} destination${ids.length !== 1 ? 's' : ''}`)
    await load()
  } finally {
    bulkEnabling.value = false
  }
}

async function bulkDisable() {
  const ids = [...selectedIds.value] as number[]
  bulkDisabling.value = true
  try {
    await Promise.allSettled(ids.map((id) => destinationsApi.update(id, { enabled: false })))
    selectedIds.value = []
    message.success(`Disabled ${ids.length} destination${ids.length !== 1 ? 's' : ''}`)
    await load()
  } finally {
    bulkDisabling.value = false
  }
}

onMounted(async () => {
  const [, settings] = await Promise.allSettled([load(), settingsApi.get()])
  if (settings.status === 'fulfilled') {
    provisioned.value = settings.value.agent?.provisioned ?? false
  }
})
</script>

<template>
  <AppLayout title="Destinations">
    <div class="heading">
      <p>Configure where your data is published.</p>
      <div class="header-actions">
        <template v-if="selectedIds.length > 0">
          <span style="font-size: 13px; color: var(--text-secondary)">{{ selectedIds.length }} selected</span>
          <a-button :loading="bulkEnabling" @click="bulkEnable"><template #icon><CheckCircleOutlined /></template>Enable</a-button>
          <a-button :loading="bulkDisabling" @click="bulkDisable"><template #icon><StopOutlined /></template>Disable</a-button>
          <a-button danger :loading="deleting" @click="confirmDeleteSelected"><template #icon><DeleteOutlined /></template>Delete</a-button>
        </template>
        <a-button type="primary" @click="openCreate"><template #icon><PlusOutlined /></template>New Destination</a-button>
      </div>
    </div>

    <a-alert v-if="error" type="error" :message="error" show-icon style="margin-bottom: 16px" />

    <a-card size="small" class="list-card">
      <div class="filters">
        <a-input v-model:value="search" placeholder="Search name, type…" allow-clear class="search" />
        <a-select v-model:value="activeType" :options="availableTypes" placeholder="All types" allow-clear class="filter" />
        <a-button @click="clearFilters">Clear</a-button>
      </div>
      <div class="toolbar-info">Showing {{ filteredRows.length }} of {{ rows.length }} destinations</div>
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
        <template v-if="column.key === 'type'">
          <a-tag :color="destinationColor(record.type)">{{ record.type }}</a-tag>
          <a-tooltip v-if="record.use_for_commands" title="This destination receives inbound device-write commands">
            <a-tag color="blue" style="font-size:10px;padding:0 4px;height:16px;line-height:16px;border-radius:3px">Commands</a-tag>
          </a-tooltip>
        </template>

        <template v-else-if="column.key === 'enabled'">
          <a-switch
            :checked="record.enabled"
            size="small"
            @change="toggleEnabled(record)"
          />
        </template>

        <template v-else-if="column.key === 'last_error'">
          <a-tooltip v-if="record.last_error" :title="record.last_error">
            <a-tag color="error" style="max-width: 200px; overflow: hidden; text-overflow: ellipsis">
              {{ record.last_error }}
            </a-tag>
          </a-tooltip>
          <span v-else style="color: var(--text-muted)">—</span>
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

    <DestinationDrawer
      v-model:open="drawerOpen"
      :editing="editing"
      :provisioned="provisioned"
      @saved="load"
    />
  </AppLayout>
</template>

<style scoped>
.heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
.heading p { color: var(--text-tertiary); margin: 0; }
.header-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.list-card { border-radius: 9px; }
.list-card :deep(.ant-table-thead > tr > th) { background: var(--bg-table-header); font-size: 12px; font-weight: 650; }
.list-card :deep(.ant-table-tbody > tr:hover > td) { background: var(--bg-table-hover); }
.filters { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.search { width: 300px; max-width: 100%; }
.filter { width: 170px; max-width: 100%; }
.toolbar-info { color: var(--text-tertiary); font-size: 12px; margin-bottom: 10px; }
</style>
