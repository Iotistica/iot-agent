<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { mqttApi, type HistoryListEntry } from '@/api/mqtt'

const props = defineProps<{
  topic: string
}>()

const emit = defineEmits<{
  (e: 'select-entry', id: number): void
}>()

const POLL_MS = 5000

const entries = ref<HistoryListEntry[]>([])
const loading = ref(false)
const selectedId = ref<number | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

async function poll() {
  loading.value = true
  try {
    const res = await mqttApi.getHistory(props.topic)
    entries.value = res.entries
  } finally {
    loading.value = false
  }
}

function select(entry: HistoryListEntry) {
  selectedId.value = entry.id
  emit('select-entry', entry.id)
}

function fmtBytes(b: number) {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${b} B`
}

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
    `.${String(ts % 1000).padStart(3, '0')}`
}

function restart() {
  if (timer) clearInterval(timer)
  entries.value = []
  selectedId.value = null
  poll()
  timer = setInterval(poll, POLL_MS)
}

watch(() => props.topic, restart)
onMounted(restart)
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="history">
    <div v-if="entries.length === 0 && !loading" class="history-empty">
      No messages captured yet for this topic since it was selected.
    </div>
    <div
      v-for="entry in entries"
      :key="entry.id"
      class="history-row"
      :class="{ selected: entry.id === selectedId }"
      @click="select(entry)"
    >
      <span class="history-time">{{ fmtTime(entry.ts) }}</span>
      <span class="history-bytes">{{ fmtBytes(entry.bytes) }}</span>
      <span class="history-qos">QoS {{ entry.qos }}</span>
      <span v-if="entry.retain" class="history-retain">R</span>
    </div>
  </div>
</template>

<style scoped>
.history {
  flex: 1;
  overflow: auto;
  padding: 4px 16px 16px;
  display: flex;
  flex-direction: column;
}

.history-empty {
  padding: 24px 0;
  text-align: center;
  color: #aaa;
  font-size: 13px;
}

.history-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 6px 8px;
  font-family: 'SFMono-Regular', 'Consolas', 'Courier New', monospace;
  font-size: 12px;
  border-radius: 4px;
  cursor: pointer;
}
.history-row:hover {
  background: #fafafa;
}
.history-row.selected {
  background: rgba(22, 119, 255, 0.14);
  color: #1677ff;
}

.history-time {
  width: 110px;
  flex-shrink: 0;
}
.history-bytes {
  width: 80px;
  flex-shrink: 0;
  color: #888;
}
.history-qos {
  width: 60px;
  flex-shrink: 0;
  color: #888;
}
.history-retain {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(250, 140, 22, 0.12);
  color: #fa8c16;
}
</style>
