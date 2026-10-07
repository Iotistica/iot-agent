<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { CopyOutlined, CheckOutlined } from '@ant-design/icons-vue'
import { mqttApi, type TopicNode, type HistoryEntry, type CompressionSnapshot } from '@/api/mqtt'
import { parsePointsPayload } from '@/utils/mqtt-points'
import { estimateDeflateRatio, type CompressionEstimate } from '@/utils/compression-estimate'
import PointsTable from './PointsTable.vue'
import MessageHistory from './MessageHistory.vue'

const props = defineProps<{
  node: TopicNode | null
}>()

const copied = ref(false)
const activeTab = ref<'points' | 'raw' | 'history'>('raw')
// null = viewing the live message; set = viewing a specific historical snapshot
// selected from the History tab. Both Points and Raw JSON read whichever is
// current via the effective* computeds below — History is the selector for
// which message those two tabs display, not a third independent view.
const historyOverride = ref<HistoryEntry | null>(null)

// Latest compression result the publish pipeline recorded for this exact
// destination topic, if any — only topics actually fed by a publish
// subscription get one (see ActivityMonitor.recordCompression()). Polled on
// the same 5s cadence as the rest of the stats row (driven by the parent's
// own poll replacing `node`) so it doesn't look frozen next to Messages/
// Total bytes/Last received, which update live from the node prop directly.
const compression = ref<CompressionSnapshot | null>(null)
const COMPRESSION_POLL_MS = 5000
let compressionTimer: ReturnType<typeof setInterval> | null = null

function pollCompression() {
  if (!props.node) return
  mqttApi.getCompression(props.node.fullTopic).then((res) => { compression.value = res.snapshot })
}

function restartCompressionPoll() {
  if (compressionTimer) clearInterval(compressionTimer)
  compression.value = null
  if (!props.node) return
  pollCompression()
  compressionTimer = setInterval(pollCompression, COMPRESSION_POLL_MS)
}

onMounted(restartCompressionPoll)
onUnmounted(() => { if (compressionTimer) clearInterval(compressionTimer) })
// 'json' with no deflate/msgpack is the "no compression configured" default —
// only show the stat when something beyond that is actually in effect.
const compressionApplied = computed(() =>
  compression.value !== null && (compression.value.method !== 'json' || compression.value.savedBytes > 0)
)

const effectiveText = computed(() => historyOverride.value?.text ?? props.node?.lastMessage ?? '')
const effectiveType = computed(() => historyOverride.value?.messageType ?? props.node?.messageType)
const effectiveTruncated = computed(() => historyOverride.value?.truncated ?? props.node?.truncated ?? false)

// When a JSON payload has no real compression applied yet, estimate what
// enabling 'json+deflate' on the subscription would save — computed
// entirely client-side against the exact bytes currently on screen (no
// backend round-trip). Only relevant for JSON payloads with nothing
// already applied; once real stats exist, those take precedence.
const suggestedCompression = ref<CompressionEstimate | null>(null)
let compressionEstimateToken = 0
watch([effectiveText, effectiveType, compressionApplied], async ([text, type, applied]) => {
  if (type !== 'json' || applied || !text) {
    suggestedCompression.value = null
    return
  }
  const token = ++compressionEstimateToken
  const result = await estimateDeflateRatio(text)
  if (token !== compressionEstimateToken) return // a different payload was selected while this was running
  suggestedCompression.value = result
}, { immediate: true })

const parsedPoints = computed(() => parsePointsPayload(effectiveText.value))

const prettyJson = computed(() => {
  if (!effectiveText.value) return null
  if (effectiveType.value !== 'json') return null
  // A truncated JSON message was cut mid-structure server-side — parsing it
  // here would always throw, so skip straight to the raw-text fallback
  // instead of attempting (and silently failing) to pretty-print it.
  if (effectiveTruncated.value) return null
  try {
    return JSON.stringify(JSON.parse(effectiveText.value), null, 2)
  } catch {
    return null
  }
})

const displayMessage = computed(() => {
  if (!effectiveText.value) return ''
  return prettyJson.value ?? effectiveText.value
})

const typeColor = computed(() => {
  const t = props.node?.messageType
  if (t === 'json') return '#52c41a'
  if (t === 'binary') return '#722ed1'
  return '#1677ff'
})

function fmtBytes(b: number) {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${b} B`
}

function fmtTime(ts: number | null) {
  if (!ts) return '—'
  return new Date(ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function fmtTimeMs(ts: number) {
  return fmtTime(ts) + `.${String(ts % 1000).padStart(3, '0')}`
}

async function copy() {
  if (!displayMessage.value) return
  await navigator.clipboard.writeText(displayMessage.value)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

function highlightJson(json: string): string {
  return json
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
      let cls = 'json-num'
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? 'json-key' : 'json-str'
      } else if (/true|false/.test(match)) {
        cls = 'json-bool'
      } else if (/null/.test(match)) {
        cls = 'json-null'
      }
      return `<span class="${cls}">${match}</span>`
    })
}

function backToLive() {
  historyOverride.value = null
}

function onSelectHistoryId(id: number) {
  if (!props.node) return
  mqttApi.getHistoryEntry(props.node.fullTopic, id).then((entry) => {
    historyOverride.value = entry
    activeTab.value = parsedPoints.value ? 'points' : 'raw'
  })
}

// Watch registration happens on topic SELECTION, not on History-tab open —
// so if an operator selects a topic, spends a while on Points/Raw JSON, and
// only later opens History, messages received since selection are already
// there. getHistory() has the side effect of registering the topic as
// watched server-side (lazy/LRU, see broker-monitor.ts); the response here
// is otherwise unused, MessageHistory.vue does its own polling once its tab
// is active.
watch(() => props.node?.fullTopic, (topic) => {
  historyOverride.value = null
  activeTab.value = parsedPoints.value ? 'points' : 'raw'
  if (topic) mqttApi.getHistory(topic)
  restartCompressionPoll()
})
</script>

<template>
  <div v-if="!node" class="empty-state">
    <div class="empty-icon">◎</div>
    <div>Select a topic to view its last message</div>
  </div>

  <div v-else class="viewer">
    <!-- Header — always reflects the live topic, regardless of tab/history selection -->
    <div class="viewer-header">
      <div class="topic-path">{{ node.fullTopic }}</div>
      <div class="topic-meta">
        <a-tag :color="typeColor" style="font-size:11px">{{ node.messageType }}</a-tag>
        <span v-if="node.retain" class="meta-badge retain">RETAINED</span>
        <span class="meta-badge qos">QoS {{ node.qos }}</span>
      </div>
    </div>

    <!-- Stats row -->
    <div class="stats-row">
      <div class="stat">
        <div class="stat-label">Messages</div>
        <div class="stat-value">{{ node.count.toLocaleString() }}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Total bytes</div>
        <div class="stat-value">{{ fmtBytes(node.bytes) }}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Last received</div>
        <div class="stat-value">{{ fmtTime(node.lastMessageAt) }}</div>
      </div>
      <div v-if="compressionApplied" class="stat">
        <div class="stat-label">Compression</div>
        <div class="stat-value">{{ compression!.savedPercent.toFixed(1) }}% saved</div>
        <div class="stat-sub">{{ compression!.method }} · {{ fmtBytes(compression!.originalSize) }} → {{ fmtBytes(compression!.compressedSize) }}</div>
      </div>
      <div v-else-if="suggestedCompression" class="stat stat--suggested">
        <div class="stat-label">Compression <span class="suggested-badge">suggested</span></div>
        <div class="stat-value">~{{ suggestedCompression.savedPercent.toFixed(1) }}% possible</div>
        <div class="stat-sub">json+deflate · {{ fmtBytes(suggestedCompression.originalSize) }} → {{ fmtBytes(suggestedCompression.compressedSize) }}</div>
      </div>
    </div>

    <div v-if="historyOverride" class="history-banner">
      Viewing historical message from {{ fmtTimeMs(historyOverride.ts) }}
      <button class="back-to-live-btn" @click="backToLive">Back to live</button>
    </div>

    <a-tabs v-model:activeKey="activeTab" class="viewer-tabs">
      <a-tab-pane v-if="parsedPoints" key="points" tab="Points">
        <PointsTable :rows="parsedPoints.rows" :details="parsedPoints.details" :topic="node.fullTopic" />
      </a-tab-pane>

      <a-tab-pane key="raw" tab="JSON">
        <div class="payload-label">
          Message
          <button class="copy-btn" :class="{ copied }" @click="copy">
            <CheckOutlined v-if="copied" />
            <CopyOutlined v-else />
            {{ copied ? 'Copied' : 'Copy' }}
          </button>
        </div>

        <div v-if="effectiveTruncated" class="truncated-banner">
          Message too large to store in full — showing the first {{ fmtBytes(effectiveText.length) }} only, formatting skipped
        </div>

        <div class="payload-box">
          <div v-if="!effectiveText" class="payload-empty">No message received yet</div>

          <!-- JSON with syntax highlight -->
          <pre
            v-else-if="prettyJson"
            class="payload-code"
            v-html="highlightJson(prettyJson)"
          />

          <!-- Plain text / binary -->
          <pre v-else class="payload-code payload-code--plain">{{ displayMessage }}</pre>
        </div>
      </a-tab-pane>

      <a-tab-pane key="history" tab="History">
        <MessageHistory :topic="node.fullTopic" @select-entry="onSelectHistoryId" />
      </a-tab-pane>
    </a-tabs>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #bbb;
  font-size: 13px;
  gap: 10px;
}

.empty-icon {
  font-size: 32px;
  opacity: 0.3;
}

.viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.viewer-header {
  padding: 14px 16px 10px;
  border-bottom: 1px solid #f0f0f0;
}

.topic-path {
  font-family: 'SFMono-Regular', 'Consolas', monospace;
  font-size: 13px;
  font-weight: 600;
  word-break: break-all;
  margin-bottom: 8px;
}

.topic-meta {
  display: flex;
  align-items: center;
  gap: 6px;
}

.meta-badge {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 3px;
}

.retain {
  background: rgba(250,140,22,0.12);
  color: #fa8c16;
}

.qos {
  background: #f0f0f0;
  color: #666;
}

.stats-row {
  display: flex;
  gap: 0;
  border-bottom: 1px solid #f0f0f0;
}

.stat {
  flex: 1;
  padding: 10px 16px;
  border-right: 1px solid #f0f0f0;
}

.stat:last-child {
  border-right: none;
}

.stat-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #aaa;
  margin-bottom: 2px;
}

.stat-value {
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.stat-sub {
  font-size: 10px;
  color: #999;
  margin-top: 1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stat--suggested .stat-value {
  color: #888;
}

.suggested-badge {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(22,119,255,0.1);
  color: #1677ff;
  margin-left: 4px;
}

.history-banner {
  margin: 10px 16px 0;
  padding: 6px 10px;
  background: rgba(22,119,255,0.08);
  color: #1677ff;
  border: 1px solid rgba(22,119,255,0.25);
  border-radius: 4px;
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.back-to-live-btn {
  background: none;
  border: none;
  color: #1677ff;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  text-decoration: underline;
  padding: 0;
}

.viewer-tabs {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0 0 0 4px;
}

.viewer-tabs :deep(.ant-tabs-content),
.viewer-tabs :deep(.ant-tabs-tabpane) {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.viewer-tabs :deep(.ant-tabs-nav) {
  margin: 0 12px;
}

.payload-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px 6px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #aaa;
}

.copy-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: 1px solid #e8e8e8;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
  color: #666;
  transition: all 0.15s;
}

.copy-btn:hover { border-color: #1677ff; color: #1677ff; }
.copy-btn.copied { border-color: #52c41a; color: #52c41a; }

.truncated-banner {
  margin: 0 16px 10px;
  padding: 6px 10px;
  background: rgba(250,140,22,0.1);
  color: #d46b08;
  border: 1px solid rgba(250,140,22,0.3);
  border-radius: 4px;
  font-size: 11px;
}

.payload-box {
  flex: 1;
  overflow: auto;
  background: #0d1117;
  margin: 0 16px 16px;
  border-radius: 6px;
}

.payload-empty {
  padding: 24px;
  color: #555;
  font-size: 12px;
  text-align: center;
}

.payload-code {
  margin: 0;
  padding: 14px 16px;
  font-family: 'SFMono-Regular', 'Consolas', 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.6;
  color: #e6edf3;
  white-space: pre-wrap;
  word-break: break-all;
}

.payload-code--plain {
  color: #adbac7;
}

:deep(.json-key)  { color: #79c0ff; }
:deep(.json-str)  { color: #a5d6ff; }
:deep(.json-num)  { color: #f2cc60; }
:deep(.json-bool) { color: #ff7b72; }
:deep(.json-null) { color: #ff7b72; }
</style>
