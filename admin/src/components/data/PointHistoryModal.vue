<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { pipelineApi } from '@/api/pipeline'
import { pointHistory, toHistorySamples, type HistorySample } from '@/utils/point-history'
import type { DataExplorerPointRow } from '@/utils/data-explorer-point-key'

const props = defineProps<{ open: boolean; point: DataExplorerPointRow | null }>()
const emit = defineEmits<{ 'update:open': [boolean] }>()
const loading = ref(false)
const error = ref('')
const samples = ref<HistorySample[]>([])
let requestId = 0
let timer: ReturnType<typeof setInterval> | undefined

async function load() {
  const point = props.point
  if (!props.open || !point) return
  const id = ++requestId
  try {
    const [buffered, events] = await Promise.all([
      pipelineApi.getPointHistory(point.key),
      pipelineApi.getEvents(2000, point.protocol),
    ])
    if (id !== requestId) return
    const fromBuffer = toHistorySamples(buffered)
    samples.value = fromBuffer.length ? fromBuffer : pointHistory(events, point)
    error.value = ''
  } catch {
    if (id === requestId) error.value = 'Unable to load point history.'
  } finally {
    if (id === requestId) loading.value = false
  }
}

watch(() => [props.open, props.point] as const, ([open, point]) => {
  requestId++
  if (timer) clearInterval(timer)
  timer = undefined
  samples.value = []
  error.value = ''
  loading.value = open && !!point
  if (open && point) {
    void load()
    timer = setInterval(load, 5000)
  }
}, { immediate: true })
onUnmounted(() => { requestId++; if (timer) clearInterval(timer) })

const chart = computed(() => {
  const data = samples.value
  if (!data.length) return null
  const values = data.map(p => p.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const low = min === max ? min - 1 : min
  const high = min === max ? max + 1 : max
  const start = data[0].ts
  const end = data[data.length - 1].ts
  const range = end - start || 1
  const points = data.map(p => {
    const x = 52 + ((p.ts - start) / range) * 536
    const y = 16 + (1 - (p.value - low) / (high - low)) * 132
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const yTicks = [high, (low + high) / 2, low].map((value, i) => ({ y: 16 + i * 66, label: value.toFixed(2) }))
  const xTicks = Array.from({ length: 5 }, (_, i) => ({
    x: 52 + i * 134,
    label: new Date(start + (end - start) * i / 4).toLocaleTimeString(),
  }))
  return {
    points, yTicks, xTicks,
    stats: { Min: min, Max: max, Avg: values.reduce((a, b) => a + b, 0) / values.length, Current: values[values.length - 1] },
  }
})
</script>

<template>
  <a-modal :open="open" :title="`History — ${point?.normalizedName || point?.rawPointName || point?.rawObjectName || point?.metric || ''}`" :footer="null" width="720px" destroy-on-close @cancel="emit('update:open', false)">
    <p class="history-note">Recent published readings (up to the last hour) held in memory; history resets when the agent restarts. Boolean values are shown as 0 or 1.</p>
    <div v-if="loading" class="history-empty"><a-spin /></div>
    <a-alert v-else-if="error" type="error" :message="error" />
    <div v-else-if="!chart" class="history-empty">No numeric or boolean history available yet.</div>
    <template v-else>
      <div class="history-chart">
        <svg viewBox="0 0 600 192" style="width:100%;display:block" role="img" aria-label="Recent point values over time">
          <template v-for="tick in chart.yTicks" :key="tick.y">
            <line x1="52" :y1="tick.y" x2="588" :y2="tick.y" stroke="#333" stroke-width="1" />
            <text x="46" :y="tick.y" text-anchor="end" dominant-baseline="middle" font-size="11" fill="#aaa" font-family="monospace">{{ tick.label }}</text>
          </template>
          <line x1="52" y1="162" x2="588" y2="162" stroke="#444" stroke-width="1" />
          <template v-for="tick in chart.xTicks" :key="tick.x">
            <line :x1="tick.x" y1="162" :x2="tick.x" y2="167" stroke="#888" stroke-width="1" />
            <text :x="tick.x" y="179" text-anchor="middle" font-size="10" fill="#aaa">{{ tick.label }}</text>
          </template>
          <polyline :points="chart.points" fill="none" stroke="#1890ff" stroke-width="1.5" stroke-linejoin="round" />
          <circle v-if="samples.length === 1" :cx="chart.points.split(',')[0]" :cy="chart.points.split(',')[1]" r="3" fill="#1890ff" />
        </svg>
      </div>
      <div class="history-stats">
        <div v-for="(value, label) in chart.stats" :key="label" class="history-stat">
          <div>{{ label }}</div>
          <strong>{{ value.toFixed(2) }} {{ point?.unit || '' }}</strong>
        </div>
      </div>
    </template>
  </a-modal>
</template>

<style scoped>
.history-note { color: var(--text-tertiary); font-size: 12px; }
.history-empty { text-align: center; padding: 40px 0; color: var(--text-placeholder); }
.history-chart { border: 1px solid #333; border-radius: 4px; background: #1a1a1a; overflow: hidden; }
.history-stats { display: flex; margin-top: 14px; border: 1px solid #333; border-radius: 4px; background: #1a1a1a; overflow: hidden; }
.history-stat { flex: 1; text-align: center; padding: 10px 0; border-right: 1px solid #333; color: #aaa; font-size: 11px; }
.history-stat:last-child { border-right: 0; }
.history-stat strong { color: #1890ff; font: 600 14px monospace; }
</style>
