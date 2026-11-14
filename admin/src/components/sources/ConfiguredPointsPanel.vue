<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { message, type TableColumnType } from 'ant-design-vue'
import { CopyOutlined } from '@ant-design/icons-vue'
import { sourcesApi, type ConfiguredPoint } from '@/api/sources'
import type { Endpoint } from '@/types'
import { copyText } from '@/utils/clipboard'
import { protocolColor, protocolLabel } from '@/utils/protocol'

const props = withDefaults(defineProps<{
  sources: Endpoint[]
  showSource?: boolean
  revision?: number
  visible?: boolean
  filters?: { search: string; protocol?: string; source?: string; identity?: string }
}>(), { visible: true })
const emit = defineEmits<{ countChange: [state: { count: number; total: number; loading: boolean; error: string }] }>()

type PointRow = ConfiguredPoint & { key: string; source: Endpoint }
const rows = ref<PointRow[]>([])
const loading = ref(false)
const error = ref('')
const search = ref('')
const status = ref<string | undefined>()
let generation = 0

function identityLabel(point: ConfiguredPoint): string {
  if (point.identityStatus === 'resolved') return 'Assigned'
  if (point.identityStatus === 'deferred' || point.identityReason === 'not-found') return 'Pending'
  return 'Unresolvable'
}

function statusReason(reason: string | null): string | undefined {
  return reason === 'namespace-evidence-required'
    ? 'Current namespace evidence is unavailable; an identity may already exist.'
    : reason || undefined
}

function addressText(address: ConfiguredPoint['protocolAddress']): string {
  return address === null ? '—' : typeof address === 'string' ? address : JSON.stringify(address)
}

const filtered = computed(() => {
  const q = (props.filters ? props.filters.search : search.value).trim().toLowerCase()
  const identity = props.filters ? props.filters.identity : status.value
  return rows.value.filter(row => (!identity || identityLabel(row) === identity)
    && (!props.filters?.protocol || row.source.protocol === props.filters.protocol)
    && (!props.filters?.source || row.source.uuid === props.filters.source)
    && (!q || [row.name, row.source.name, row.source.protocol, addressText(row.protocolAddress), row.pointUuid, row.deviceName, row.deviceUuid]
      .some(value => value?.toLowerCase().includes(q))))
})

const columns = computed<TableColumnType<PointRow>[]>(() => [
  ...(props.showSource ? [{ title: 'Protocol', key: 'protocol', width: 105 }] : []),
  ...(props.showSource ? [{ title: 'Source', key: 'source', width: 150, sorter: (a: PointRow, b: PointRow) => a.source.name.localeCompare(b.source.name) }] : []),
  { title: 'Point', key: 'name', dataIndex: 'name', width: 150, sorter: (a, b) => a.name.localeCompare(b.name) },
  { title: 'Protocol address', key: 'address', width: 200, ellipsis: true },
  { title: 'Address Status', key: 'canonical', width: 130 },
  { title: 'Identity', key: 'identity', width: 120 },
  { title: 'Point UUID', key: 'uuid', width: 150 },
  { title: 'Device', key: 'device', width: 110 },
])

async function copyPointUuid(uuid: string) {
  try {
    if (!await copyText(uuid)) throw new Error('Clipboard copy failed')
    message.success('Point UUID copied')
  } catch {
    message.error('Unable to copy Point UUID')
  }
}

async function load() {
  const request = ++generation
  const sources = [...props.sources]
  loading.value = true
  error.value = ''
  const results: Array<{ source: Endpoint; points?: ConfiguredPoint[]; failed?: boolean }> = []
  let next = 0
  const workers = Array.from({ length: Math.min(8, sources.length) }, async () => {
    while (next < sources.length) {
      const source = sources[next++]
      try {
        results.push({ source, points: await sourcesApi.getPoints(source.uuid) })
      } catch {
        results.push({ source, failed: true })
      }
    }
  })
  await Promise.all(workers)
  if (request !== generation) return
  const failed = results.filter(result => result.failed).map(result => result.source.name)
  error.value = failed.length ? `Unable to load points for: ${failed.join(', ')}` : ''
  rows.value = results.flatMap(({ source, points }) =>
    (points ?? []).map((point, index) => ({ ...point, source, key: `${source.uuid}:${index}` })))
    .sort((a, b) => a.source.name.localeCompare(b.source.name) || a.name.localeCompare(b.name))
  loading.value = false
}

watch(() => [props.sources.map(source => source.uuid).join('\0'), props.revision], () => { void load() }, { immediate: true })
watch([() => filtered.value.length, () => rows.value.length, loading, error], ([count, total, isLoading, loadError]) => {
  emit('countChange', { count, total, loading: isLoading, error: loadError })
}, { immediate: true })
onBeforeUnmount(() => { generation++ })
</script>

<template>
  <div v-if="visible">
    <a-alert v-if="error" type="warning" show-icon :message="error" style="margin-bottom: 12px" />
    <a-space v-if="!filters" wrap style="margin-bottom: 12px">
      <a-input v-model:value="search" placeholder="Search points, source, address or UUID" allow-clear style="width: 260px" />
      <a-select v-model:value="status" placeholder="All identities" allow-clear style="width: 150px"
        :options="['Assigned', 'Pending', 'Unresolvable'].map(value => ({ value, label: value }))" />
      <a-button :loading="loading" @click="load">Refresh</a-button>
    </a-space>
    <a-table :columns="columns" :data-source="filtered" :loading="loading" row-key="key" size="small"
      :scroll="{ x: showSource ? 1135 : 930 }" :pagination="{ pageSize: 20, showSizeChanger: true }">
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'protocol'"><a-tag :color="protocolColor(record.source.protocol)">{{ protocolLabel(record.source.protocol) }}</a-tag></template>
        <template v-else-if="column.key === 'source'">{{ record.source.name }}</template>
        <template v-else-if="column.key === 'address'"><span :title="addressText(record.protocolAddress)">{{ addressText(record.protocolAddress) }}</span></template>
        <template v-else-if="column.key === 'canonical'">
          <a-tooltip :title="statusReason(record.canonicalReason)">{{ record.canonicalStatus }}</a-tooltip>
        </template>
        <template v-else-if="column.key === 'identity'">
          <a-tooltip :title="statusReason(record.identityReason)">{{ identityLabel(record) }}</a-tooltip>
        </template>
        <template v-else-if="column.key === 'uuid'">
          <template v-if="record.pointUuid">
            <span :title="record.pointUuid">{{ record.pointUuid.length > 16 ? `${record.pointUuid.slice(0, 8)}…` : record.pointUuid }}</span>
            <a-tooltip title="Copy point UUID">
              <a-button type="text" size="small" aria-label="Copy point UUID" @click.stop="copyPointUuid(record.pointUuid)">
                <template #icon><CopyOutlined /></template>
              </a-button>
            </a-tooltip>
          </template>
          <span v-else>—</span>
        </template>
        <template v-else-if="column.key === 'device'"><span :title="record.deviceUuid">{{ record.deviceName || '—' }}</span></template>
      </template>
      <template #emptyText>No configured points found.</template>
    </a-table>
  </div>
</template>
