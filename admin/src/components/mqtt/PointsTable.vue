<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { SearchOutlined, PushpinOutlined, PushpinFilled } from '@ant-design/icons-vue'
import type { TableColumnType } from 'ant-design-vue'
import {
  filterPointRows,
  pointDetailFields,
  type PointDetail,
  type PointQuality,
  type PointRow,
} from '@/utils/mqtt-points'

const props = defineProps<{
  rows: PointRow[]
  details: Map<string, PointDetail>
  topic: string
}>()

const search = ref('')
const qualityFilter = ref<PointQuality | 'all'>('all')
// Owned here instead of left to a-table's uncontrolled default: live points
// update every poll, so `rows`/`filtered` get a brand-new array reference
// every few seconds even when the actual point set is unchanged — a-table's
// built-in expand-state tracking resets on that reference churn. Keeping
// the expanded keys in our own ref, independent of the data prop, means an
// expanded row stays open across refreshes instead of snapping shut.
const expandedKeys = ref<string[]>([])

// Pinning is the durable form of "stay open" — survives not just data
// polls but tab switches and actual browser reloads, via localStorage,
// keyed per topic so pins on one topic don't leak into another. Keyed by
// point NAME (not PointRow.key, which embeds an array index) since that's
// what's stable across a page reload where in-memory indices don't carry
// over. A watcher below forcibly re-asserts pinned rows into expandedKeys
// on every data refresh, as a belt-and-suspenders guarantee independent of
// whatever a-table does internally with expandedRowKeys on dataSource change.
const pinnedNames = ref<Set<string>>(new Set())

function pinnedStorageKey(topic: string): string {
  return `iotistica-mqtt-explorer-pinned:${topic}`
}

function loadPinned(topic: string): Set<string> {
  try {
    const raw = localStorage.getItem(pinnedStorageKey(topic))
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

function savePinned(topic: string, names: Set<string>) {
  try {
    localStorage.setItem(pinnedStorageKey(topic), JSON.stringify([...names]))
  } catch {
    // storage unavailable/full/private-mode — pin still works for this session, just won't survive a reload
  }
}

function isPinned(row: PointRow): boolean {
  return pinnedNames.value.has(row.name)
}

function togglePin(row: PointRow) {
  const next = new Set(pinnedNames.value)
  if (next.has(row.name)) {
    next.delete(row.name)
  } else {
    next.add(row.name)
    if (!expandedKeys.value.includes(row.key)) expandedKeys.value = [...expandedKeys.value, row.key]
  }
  pinnedNames.value = next
  savePinned(props.topic, next)
}

watch(() => props.topic, (topic) => {
  pinnedNames.value = topic ? loadPinned(topic) : new Set()
  expandedKeys.value = []
}, { immediate: true })

// Re-assert on every poll: whatever a-table's expandedRowKeys ends up as,
// every currently-pinned point's row key must be in it. `immediate: true`
// matters here — without it, this only reacts to FUTURE changes to rows/
// pinnedNames, missing the pinned names the topic-watcher above just loaded
// from localStorage during this same setup (that assignment happens before
// this watcher even exists), so a freshly-loaded page showed pinned rows
// collapsed until the next live data tick happened to trigger this.
watch([() => props.rows, pinnedNames], () => {
  if (pinnedNames.value.size === 0) return
  const missing = props.rows
    .filter((r) => pinnedNames.value.has(r.name) && !expandedKeys.value.includes(r.key))
    .map((r) => r.key)
  if (missing.length > 0) expandedKeys.value = [...expandedKeys.value, ...missing]
}, { immediate: true })

const filtered = computed(() => filterPointRows(props.rows, search.value, qualityFilter.value))

// Explicit widths so the table doesn't shift as values/names change length
// on each poll — same convention as LiveView.vue's subscription/event tables.
const columns: TableColumnType<PointRow>[] = [
  { title: 'Point', key: 'name', width: 260, ellipsis: true },
  { title: 'Value', key: 'value', width: 140, ellipsis: true },
  { title: 'Unit', key: 'unit', width: 90, ellipsis: true },
  { title: 'Quality', key: 'quality', width: 100 },
  { title: '', key: 'pin', width: 40 },
]

const qualityTagColor: Record<PointQuality, string> = {
  good: 'green',
  degraded: 'orange',
  bad: 'red',
  unknown: 'default',
}

function qualityColor(quality: PointQuality): string {
  return qualityTagColor[quality]
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2)
  return String(v)
}

function detailFor(row: PointRow) {
  const detail = props.details.get(row.key)
  return detail ? pointDetailFields(detail) : []
}
</script>

<template>
  <div class="points-table">
    <div class="filter-row">
      <a-input v-model:value="search" placeholder="Search points…" allow-clear style="width: 260px">
        <template #prefix><SearchOutlined style="color: #bbb" /></template>
      </a-input>
      <a-select v-model:value="qualityFilter" style="width: 160px">
        <a-select-option value="all">All qualities</a-select-option>
        <a-select-option value="good">Good</a-select-option>
        <a-select-option value="degraded">Degraded</a-select-option>
        <a-select-option value="bad">Bad</a-select-option>
        <a-select-option value="unknown">Unknown</a-select-option>
      </a-select>
    </div>

    <a-table
      v-model:expandedRowKeys="expandedKeys"
      :columns="columns"
      :data-source="filtered"
      :pagination="{ pageSize: 20, size: 'small' }"
      :scroll="{ x: true }"
      row-key="key"
      size="small"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'name'">
          <div class="point-cell">
            <div class="point-primary" :title="record.name">{{ record.name }}</div>
            <div v-if="record.rawName && record.rawName !== record.name" class="point-secondary" :title="record.rawName">
              {{ record.rawName }}
            </div>
          </div>
        </template>
        <template v-else-if="column.key === 'value'">
          <a-tag v-if="record.hasError" color="red">Error</a-tag>
          <span v-else style="font-family: monospace">{{ fmtValue(record.value) }}</span>
        </template>
        <template v-else-if="column.key === 'unit'">
          {{ record.unit || '—' }}
        </template>
        <template v-else-if="column.key === 'quality'">
          <a-tag :color="qualityColor(record.quality)">{{ record.quality }}</a-tag>
        </template>
        <template v-else-if="column.key === 'pin'">
          <button
            class="pin-btn"
            :class="{ pinned: isPinned(record) }"
            :title="isPinned(record) ? 'Unpin — stop keeping this point\'s detail open' : 'Pin — keep this point\'s detail open across refreshes'"
            @click.stop="togglePin(record)"
          >
            <PushpinFilled v-if="isPinned(record)" />
            <PushpinOutlined v-else />
          </button>
        </template>
      </template>

      <template #expandedRowRender="{ record }">
        <div class="detail-grid">
          <template v-for="field in detailFor(record)" :key="field.label">
            <div class="detail-label">{{ field.label }}</div>
            <div class="detail-value">{{ field.value }}</div>
          </template>
          <div v-if="detailFor(record).length === 0" class="detail-empty">No additional metadata on this point.</div>
        </div>
      </template>

      <template #emptyText>
        <div style="padding: 24px 0; text-align: center; color: #aaa; font-size: 13px">
          No points match the current filter
        </div>
      </template>
    </a-table>
  </div>
</template>

<style scoped>
.points-table {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 16px 16px;
  flex: 1;
  overflow: auto;
}

.filter-row {
  display: flex;
  gap: 8px;
}

.point-cell {
  line-height: 1.3;
}
.pin-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: #ccc;
  font-size: 14px;
  line-height: 1;
}
.pin-btn:hover {
  color: #1677ff;
}
.pin-btn.pinned {
  color: #1677ff;
}
.point-primary {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.point-secondary {
  font-size: 11px;
  color: #666;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-grid {
  display: grid;
  grid-template-columns: 160px 1fr;
  row-gap: 6px;
  column-gap: 16px;
  padding: 4px 8px;
  font-size: 12px;
}
.detail-label {
  color: #888;
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.04em;
  align-self: center;
}
.detail-value {
  font-family: 'SFMono-Regular', 'Consolas', 'Courier New', monospace;
  word-break: break-all;
}
.detail-empty {
  grid-column: 1 / -1;
  color: #aaa;
  font-size: 12px;
}
</style>
