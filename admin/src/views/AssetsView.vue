<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import AssetDrawer from '@/components/assets/AssetDrawer.vue'
import type { Asset } from '@/types'
import { assetsApi } from '@/api/assets'

const CRITICALITY_TAG_COLOR: Record<string, string> = {
  critical: 'red',
  high: 'orange',
  medium: 'blue',
  low: 'default',
}

const rows = ref<Asset[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const drawerOpen = ref(false)
const editing = ref<Asset | null>(null)

const columns: TableColumnType<Asset>[] = [
  { title: 'Name', dataIndex: 'name', key: 'name', ellipsis: true, minWidth: 160 },
  { title: 'Equipment Type', dataIndex: 'asset_type', key: 'asset_type', width: 130, ellipsis: true },
  { title: 'Criticality', key: 'criticality', width: 100 },
  { title: 'Metrics', key: 'metrics', width: 90 },
  { title: 'Manufacturer / Model', key: 'manufacturer', width: 180, ellipsis: true },
  { title: 'Location', dataIndex: 'location', key: 'location', width: 140, ellipsis: true },
  { title: 'Actions', key: 'actions', width: 120, fixed: 'right' },
]

async function load() {
  loading.value = true
  error.value = null
  try {
    rows.value = await assetsApi.getAll()
  } catch (err: unknown) {
    const e = err as { message?: string }
    error.value = e?.message ?? 'Failed to load assets'
  } finally {
    loading.value = false
  }
}

function openCreate() {
  editing.value = null
  drawerOpen.value = true
}

function openEdit(row: Asset) {
  editing.value = row
  drawerOpen.value = true
}

function confirmDelete(row: Asset) {
  Modal.confirm({
    title: `Delete "${row.name}"?`,
    content: row.metrics.length ? `This also removes its ${row.metrics.length} metric binding${row.metrics.length !== 1 ? 's' : ''}.` : undefined,
    okType: 'danger',
    okText: 'Delete',
    async onOk() {
      await assetsApi.remove(row.uuid)
      message.success('Deleted')
      await load()
    },
  })
}

function manufacturerModel(row: Asset): string {
  if (row.manufacturer && row.model) return `${row.manufacturer} / ${row.model}`
  return row.manufacturer || row.model || '—'
}

onMounted(load)
</script>

<template>
  <AppLayout title="Assets">
    <div class="toolbar">
      <span style="color: #888; font-size: 13px">
        The equipment behind your metrics — criticality drives how maintenance rules prioritize.
      </span>
      <a-button type="primary" @click="openCreate">
        <template #icon><PlusOutlined /></template>
        New Asset
      </a-button>
    </div>

    <a-alert v-if="error" type="error" :message="error" show-icon style="margin-bottom: 16px" />

    <a-table
      :columns="columns"
      :data-source="rows"
      :loading="loading"
      :pagination="false"
      :scroll="{ x: 'max-content' }"
      row-key="uuid"
      size="middle"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'criticality'">
          <a-tag :color="CRITICALITY_TAG_COLOR[record.criticality]">{{ record.criticality }}</a-tag>
        </template>

        <template v-else-if="column.key === 'metrics'">
          <span style="color: #888; font-size: 12px">{{ record.metrics.length }}</span>
        </template>

        <template v-else-if="column.key === 'manufacturer'">
          <span style="font-size: 12px">{{ manufacturerModel(record) }}</span>
        </template>

        <template v-else-if="column.key === 'actions'">
          <a-space>
            <a-button size="small" @click="openEdit(record)">Edit</a-button>
            <a-button size="small" danger @click="confirmDelete(record)">
              <template #icon><DeleteOutlined /></template>
            </a-button>
          </a-space>
        </template>
      </template>

      <template #emptyText>
        <div style="padding: 24px 0; text-align: center; color: #aaa; font-size: 13px">
          No assets yet — add one to start tying metrics to real equipment.
        </div>
      </template>
    </a-table>

    <AssetDrawer
      v-model:open="drawerOpen"
      :editing="editing"
      @saved="load"
    />
  </AppLayout>
</template>

<style scoped>
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  gap: 8px;
}
</style>
