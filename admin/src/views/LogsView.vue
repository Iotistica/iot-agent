<script setup lang="ts">
import { h, ref, computed, onMounted, onUnmounted } from 'vue'
import { ReloadOutlined } from '@ant-design/icons-vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import { logsApi } from '@/api/logs'
import type { LogMessage, LogLevel, LogSourceType } from '@/api/logs'

const logs = ref<LogMessage[]>([])
const loading = ref(false)
const autoRefresh = ref(false)
let refreshTimer: ReturnType<typeof setInterval> | null = null

const filterLevel = ref<LogLevel | undefined>(undefined)
const filterSource = ref<LogSourceType | undefined>(undefined)
const filterComponent = ref<string | undefined>(undefined)
const filterText = ref('')
const limitOption = ref(200)

const LEVEL_COLOR: Record<LogLevel, string> = {
  error: 'error',
  warn:  'warning',
  info:  'processing',
  debug: '#555',
}

const LEVEL_TEXT_COLOR: Record<LogLevel, string> = {
  error: '#cf1322',
  warn:  '#fa8c16',
  info:  '#1677ff',
  debug: '#999',
}

function fmtTs(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString()
}

function fmtSource(name: string): string {
  return name.replace(/\]\s*\[/g, ' / ')
}

const componentOptions = computed(() => {
  const names = [...new Set(logs.value.map((l) => l.source.name))].sort()
  return names.map((n) => ({ value: n, label: fmtSource(n) }))
})

const filtered = computed(() => {
  const q = filterText.value.trim().toLowerCase()
  const comp = filterComponent.value
  return logs.value.filter((l) => {
    if (comp && l.source.name !== comp) return false
    if (q && !l.message.toLowerCase().includes(q) && !l.source.name.toLowerCase().includes(q)) return false
    return true
  })
})

const hasClientFilter = computed(() => !!filterText.value.trim() || !!filterComponent.value)

const statusText = computed(() => {
  if (hasClientFilter.value) return `Showing ${filtered.value.length} of ${logs.value.length} entries`
  return `Showing ${logs.value.length} entries`
})

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

function getPublishDetails(log: LogMessage): { protocol?: string; bytes?: number; topic?: string; routes?: { destination: string; topic: string }[] } | null {
  const ctx = log.context
  if (!ctx || !ctx.protocol) return null
  const routes = Array.isArray(ctx.externalRoutes)
    ? (ctx.externalRoutes as { destination: string; destinationTopic: string }[]).map(r => ({ destination: r.destination, topic: r.destinationTopic }))
    : []
  return {
    protocol: ctx.protocol as string,
    bytes: typeof ctx.batchBytes === 'number' ? ctx.batchBytes : undefined,
    topic: typeof ctx.endpointTopic === 'string' ? ctx.endpointTopic : undefined,
    routes,
  }
}

function clearFilters() {
  filterLevel.value = undefined
  filterSource.value = undefined
  filterComponent.value = undefined
  filterText.value = ''
  load()
}

async function load() {
  loading.value = true
  try {
    const res = await logsApi.getLogs({
      level: filterLevel.value,
      source: filterSource.value,
      limit: limitOption.value,
    })
    logs.value = res.logs.filter((log) => log.source.type !== 'container').reverse()
  } catch {
    // non-fatal
  } finally {
    loading.value = false
  }
}

function toggleAutoRefresh(on: boolean) {
  autoRefresh.value = on
  if (on) {
    refreshTimer = setInterval(load, 5000)
  } else {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
  }
}

onMounted(load)
onUnmounted(() => { if (refreshTimer) clearInterval(refreshTimer) })
</script>

<template>
  <AppLayout title="Logs">
    <div class="heading">
      <p>Live log stream from agent services.</p>
      <div class="header-actions">
        <a-button :icon="h(ReloadOutlined)" :loading="loading" @click="load">Refresh</a-button>
        <a-switch :checked="autoRefresh" checked-children="Auto" un-checked-children="Auto" @change="toggleAutoRefresh" />
      </div>
    </div>

    <div class="filters">
      <a-input v-model:value="filterText" placeholder="Filter message / source…" allow-clear class="search" />
      <a-select v-model:value="filterLevel" placeholder="All levels" allow-clear class="filter" @change="load">
        <a-select-option value="error">Error</a-select-option>
        <a-select-option value="warn">Warn</a-select-option>
        <a-select-option value="info">Info</a-select-option>
        <a-select-option value="debug">Debug</a-select-option>
      </a-select>
      <a-select v-model:value="filterSource" placeholder="All sources" allow-clear class="filter" @change="load">
        <a-select-option value="system">System</a-select-option>
        <a-select-option value="manager">Manager</a-select-option>
      </a-select>
      <a-select v-model:value="filterComponent" :options="componentOptions" placeholder="All components" allow-clear class="filter" />
      <a-select v-model:value="limitOption" class="filter-small" @change="load">
        <a-select-option :value="100">100 rows</a-select-option>
        <a-select-option :value="200">200 rows</a-select-option>
        <a-select-option :value="500">500 rows</a-select-option>
        <a-select-option :value="1000">1000 rows</a-select-option>
      </a-select>
      <a-button @click="clearFilters">Clear</a-button>
    </div>
    <div class="toolbar-info">{{ statusText }}</div>

    <!-- Log table -->
    <div
      style="
        font-family: 'Cascadia Code', 'Fira Code', 'Courier New', monospace;
        font-size: 12px;
        background: #0d1117;
        border-radius: 6px;
        padding: 8px 0;
        overflow-x: auto;
      "
    >
      <div
        v-if="loading && filtered.length === 0"
        style="text-align: center; color: #555; padding: 40px"
      >
        Loading…
      </div>
      <div
        v-else-if="filtered.length === 0"
        style="text-align: center; color: #555; padding: 40px"
      >
        No log entries
      </div>

      <div
        v-for="log in filtered"
        :key="log.id ?? log.timestamp"
        style="
          display: flex;
          align-items: flex-start;
          gap: 10px;
          padding: 2px 14px;
          line-height: 1.5;
          border-bottom: 1px solid #161b22;
        "
        :style="log.level === 'error' ? 'background: rgba(207,19,34,0.06)' : log.level === 'warn' ? 'background: rgba(250,140,22,0.04)' : ''"
      >
        <!-- Timestamp -->
        <span style="color: #484f58; white-space: nowrap; flex-shrink: 0">
          {{ fmtDate(log.timestamp) }}&nbsp;{{ fmtTs(log.timestamp) }}
        </span>

        <!-- Level badge -->
        <a-tag
          :color="LEVEL_COLOR[log.level]"
          style="flex-shrink: 0; margin: 0; font-size: 11px; line-height: 18px; padding: 0 5px"
        >
          {{ log.level.toUpperCase() }}
        </a-tag>

        <!-- Source -->
        <span style="color: #6e7681; white-space: nowrap; flex-shrink: 0; min-width: 120px">
          {{ fmtSource(log.source.name) }}
          <span v-if="log.serviceName" style="color: #484f58"> · {{ log.serviceName }}</span>
        </span>

        <!-- Message -->
        <div style="min-width: 0">
          <span :style="{ color: LEVEL_TEXT_COLOR[log.level] || '#e6edf3', wordBreak: 'break-all' }">
            {{ log.message }}
          </span>
          <div v-if="getPublishDetails(log)" style="color: #6e7681; font-size: 11px; margin-top: 1px">
            <a-tag color="blue" style="margin: 0 4px 0 0; font-size: 10px; line-height: 16px; padding: 0 4px">{{ getPublishDetails(log)!.protocol }}</a-tag>
            <span v-if="getPublishDetails(log)!.bytes" style="margin-right: 6px">{{ fmtBytes(getPublishDetails(log)!.bytes!) }}</span>
            <span v-if="getPublishDetails(log)!.topic" style="color: #484f58">{{ getPublishDetails(log)!.topic }}</span>
            <template v-if="getPublishDetails(log)!.routes?.length">
              <span v-for="(r, i) in getPublishDetails(log)!.routes" :key="i" style="margin-left: 6px; color: #484f58">
                → {{ r.destination }}: <span style="color: #6e7681">{{ r.topic }}</span>
              </span>
            </template>
          </div>
        </div>
      </div>
    </div>
  </AppLayout>
</template>

<style scoped>
.heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
.heading p { color: var(--text-tertiary); margin: 0; }
.header-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.filters { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.search { width: 300px; max-width: 100%; }
.filter { width: 170px; max-width: 100%; }
.filter-small { width: 120px; max-width: 100%; }
.toolbar-info { color: var(--text-tertiary); font-size: 12px; margin-bottom: 10px; }
</style>
