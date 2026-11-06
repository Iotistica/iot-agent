<script setup lang="ts">
import { protocolColor, protocolLabel } from '@/utils/protocol'

interface Point {
  protocol: string
  endpointName: string
  metric: string
  normalizedName?: string
  rawPointName?: string
  rawObjectName?: string
  value: unknown
  quality?: string
  unit?: string
  timestamp: string
  destinationName: string
}

defineProps<{
  open: boolean
  point: Point | null
  sourceName: string
  now: number
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

function pointName(point: Point) {
  return point.normalizedName || point.rawPointName || point.rawObjectName || point.metric
}

function originalName(point: Point) {
  return point.rawPointName || point.rawObjectName || point.metric
}

function valueText(value: unknown) {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2)
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function age(timestamp: string, now: number) {
  const ms = new Date(timestamp).getTime()
  if (!Number.isFinite(ms)) return 'Unknown'
  const seconds = Math.max(0, Math.floor((now - ms) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function close() {
  emit('update:open', false)
}
</script>

<template>
  <a-drawer
    :open="open"
    title="Point details"
    width="520"
    @close="close"
  >
    <a-descriptions v-if="point" :column="2" size="small" bordered style="margin-bottom: 24px">
      <a-descriptions-item label="Point" :span="2">{{ pointName(point) }}</a-descriptions-item>
      <a-descriptions-item label="Original name" :span="2">{{ originalName(point) }}</a-descriptions-item>
      <a-descriptions-item label="Source" :span="2">{{ sourceName }}</a-descriptions-item>
      <a-descriptions-item label="Protocol">
        <a-tag :color="protocolColor(point.protocol)" style="margin: 0">{{ protocolLabel(point.protocol) }}</a-tag>
      </a-descriptions-item>
      <a-descriptions-item label="Quality">{{ point.quality || 'Not provided' }}</a-descriptions-item>
      <a-descriptions-item label="Latest value">{{ valueText(point.value) }}</a-descriptions-item>
      <a-descriptions-item label="Unit">{{ point.unit || '—' }}</a-descriptions-item>
      <a-descriptions-item label="Last observed" :span="2">
        {{ point.timestamp }} ({{ age(point.timestamp, now) }})
      </a-descriptions-item>
      <a-descriptions-item label="Destination" :span="2">{{ point.destinationName }}</a-descriptions-item>
      <a-descriptions-item label="Metric key" :span="2"><span class="mono-text">{{ point.metric }}</span></a-descriptions-item>
    </a-descriptions>
  </a-drawer>
</template>

<style scoped>
.mono-text {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-all;
}
</style>
