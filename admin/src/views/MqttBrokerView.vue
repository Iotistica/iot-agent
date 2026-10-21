<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import AppLayout from '@/components/layout/AppLayout.vue'
import TopicTree from '@/components/mqtt/TopicTree.vue'
import MessageViewer from '@/components/mqtt/MessageViewer.vue'
import { useProStatus } from '@/composables/useProStatus'
import { mqttApi, type TopicNode, type BrokerMetrics } from '@/api/mqtt'
import { WifiOutlined, GlobalOutlined, TeamOutlined, NodeIndexOutlined, LoginOutlined, LogoutOutlined } from '@ant-design/icons-vue'

const { proInstalled } = useProStatus()
const router = useRouter()

const metrics    = ref<BrokerMetrics | null>(null)
const topicTree  = ref<Record<string, TopicNode>>({})
const selected   = ref<TopicNode | null>(null)
const connected  = ref(false)
const loading    = ref(true)
const filterText = ref('')

const POLL_MS = 5000

let timer: ReturnType<typeof setInterval> | null = null

async function poll() {
  try {
    const [m, tree] = await Promise.all([
      mqttApi.getMetrics(),
      mqttApi.getTopicTree(),
    ])
    metrics.value   = m
    topicTree.value = tree
    connected.value = m.connected
    loading.value   = false

    // Refresh selected node data from updated tree
    if (selected.value) {
      selected.value = findNode(tree, selected.value.fullTopic) ?? selected.value
    }
  } catch {
    loading.value = false
  }
}

function findNode(nodes: Record<string, TopicNode>, fullTopic: string): TopicNode | null {
  for (const node of Object.values(nodes)) {
    if (node.fullTopic === fullTopic) return node
    const found = findNode(node.children, fullTopic)
    if (found) return found
  }
  return null
}

const filteredTree = computed(() => {
  const q = filterText.value.trim().toLowerCase()
  if (!q) return topicTree.value
  return filterTree(topicTree.value, q)
})

function filterTree(nodes: Record<string, TopicNode>, q: string): Record<string, TopicNode> {
  const result: Record<string, TopicNode> = {}
  for (const [key, node] of Object.entries(nodes)) {
    if (node.fullTopic.toLowerCase().includes(q)) {
      result[key] = node
    } else {
      const filteredChildren = filterTree(node.children, q)
      if (Object.keys(filteredChildren).length) {
        result[key] = { ...node, children: filteredChildren }
      }
    }
  }
  return result
}

function fmtKB(kb: number) {
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB/s`
  return `${kb.toFixed(1)} KB/s`
}


function countTopics(tree: Record<string, TopicNode>, count = 0): number {
  for (const node of Object.values(tree)) {
    if (node.count > 0) count++
    count = countTopics(node.children, count)
  }
  return count
}

function startPolling() {
  if (timer) return
  poll()
  timer = setInterval(poll, POLL_MS)
}

onMounted(() => {
  if (proInstalled.value) {
    startPolling()
  }
})

watch(proInstalled, (v) => {
  if (v) startPolling()
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <AppLayout title="MQTT">
    <div class="heading">
      <p>Live topic tree, throughput metrics, and message inspection.</p>
    </div>

    <!-- Pro gate -->
    <a-alert v-if="!proInstalled" type="info" show-icon style="margin-bottom: 16px">
      <template #message>Live broker monitoring requires Agent Pro</template>
      <template #description>
        <div style="margin-top: 4px">
          <strong>Iotistica Agent Pro</strong> includes a live MQTT broker monitor — browse the full topic tree,
          inspect message payloads, and track throughput and client metrics in real time.
        </div>
        <div style="margin-top: 12px">
          <a-button type="primary" size="small" href="https://iotistica.com/solutions.html" target="_blank" rel="noopener">
            Upgrade to Agent Pro →
          </a-button>
          <a href="https://iotistica.com/solutions.html" target="_blank" rel="noopener" style="margin-left:16px;font-size:12px">
            Compare plans
          </a>
        </div>
      </template>
    </a-alert>

    <template v-if="proInstalled">

      <!-- Connection banner -->
      <a-alert
        v-if="!loading && !connected"
        type="warning"
        show-icon
        style="margin-bottom: 16px"
      >
        <template #message>Not connected to local MQTT broker</template>
        <template #description>
          <div style="margin-top: 4px">
            Check that the broker URL and credentials are configured correctly.
          </div>
          <a-button
            type="primary"
            size="small"
            style="margin-top: 12px"
            @click="router.push('/settings?tab=mqtt-monitor')"
          >
            Go to Settings
          </a-button>
        </template>
      </a-alert>

      <!-- Metric cards -->
      <a-row :gutter="12" class="stats">

        <a-col :xs="12" :sm="6">
          <a-card size="small" class="metric-card">
            <div class="metric-inner">
              <span class="metric-icon icon-clients"><TeamOutlined /></span>
              <a-statistic title="Connected clients" :value="metrics?.clients.connected ?? '—'" :value-style="connected ? { color: '#52c41a' } : {}">
                <template #suffix><span class="metric-sub">of {{ metrics?.clients.total ?? '—' }}</span></template>
              </a-statistic>
            </div>
          </a-card>
        </a-col>

        <a-col :xs="12" :sm="6">
          <a-card size="small" class="metric-card">
            <div class="metric-inner">
              <span class="metric-icon icon-topics"><NodeIndexOutlined /></span>
              <a-statistic title="Topics" :value="metrics ? Object.keys(topicTree).length > 0 ? countTopics(topicTree) : 0 : '—'">
                <template #suffix><span class="metric-sub">{{ metrics?.subscriptions ?? '—' }} subs</span></template>
              </a-statistic>
            </div>
          </a-card>
        </a-col>

        <a-col :xs="12" :sm="6">
          <a-card size="small" class="metric-card">
            <div class="metric-inner">
              <span class="metric-icon icon-in"><LoginOutlined /></span>
              <a-statistic title="Msg rate in" :value="metrics ? `${metrics.messageRateIn}/s` : '—'">
                <template #suffix><span class="metric-sub">{{ metrics ? fmtKB(metrics.throughputIn) : '' }}</span></template>
              </a-statistic>
            </div>
          </a-card>
        </a-col>

        <a-col :xs="12" :sm="6">
          <a-card size="small" class="metric-card">
            <div class="metric-inner">
              <span class="metric-icon icon-out"><LogoutOutlined /></span>
              <a-statistic title="Msg rate out" :value="metrics ? `${metrics.messageRateOut}/s` : '—'">
                <template #suffix><span class="metric-sub">{{ metrics ? fmtKB(metrics.throughputOut) : '' }}</span></template>
              </a-statistic>
            </div>
          </a-card>
        </a-col>

      </a-row>

      <!-- Main split panel -->
      <div class="split-panel">

        <!-- Left: topic tree -->
        <div class="tree-pane">
          <div class="pane-header">
            <span class="pane-title">
              <WifiOutlined style="margin-right:6px" />
              Topics
            </span>
            <span class="pane-count">{{ countTopics(topicTree) }}</span>
          </div>
          <div class="tree-filter">
            <a-input
              v-model:value="filterText"
              placeholder="Filter topics…"
              allow-clear
              size="small"
            />
          </div>
          <div class="tree-scroll">
            <a-spin :spinning="loading" size="small">
              <div v-if="!loading && Object.keys(filteredTree).length === 0" class="tree-empty">
                No topics yet — messages will appear as the broker receives them
              </div>
              <TopicTree
                v-else
                :nodes="filteredTree"
                :selected-topic="selected?.fullTopic ?? null"
                @select="selected = $event"
              />
            </a-spin>
          </div>
        </div>

        <!-- Right: message viewer -->
        <div class="viewer-pane">
          <div class="pane-header">
            <span class="pane-title">
              <GlobalOutlined style="margin-right:6px" />
              Message
            </span>
            <span v-if="metrics?.version" class="broker-version">{{ metrics.version }}</span>
          </div>
          <div class="viewer-scroll">
            <MessageViewer :node="selected" />
          </div>
        </div>

      </div>

    </template>
  </AppLayout>
</template>

<style scoped>
.heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
.heading p { color: var(--text-tertiary); margin: 0; }

.stats { margin-bottom: 14px; }
.stats :deep(.ant-card) { border-radius: 9px; border-color: var(--border-color-card); background: var(--bg-subtle); }
.stats :deep(.ant-card-body) { padding: 17px 18px; }
.metric-inner { display: flex; align-items: center; gap: 15px; min-height: 66px; }
.metric-icon { width: 50px; height: 50px; flex-shrink: 0; border-radius: 14px; display: inline-flex; align-items: center; justify-content: center; font-size: 23px; }
.icon-clients { background: var(--icon-bg-green); color: #52c41a; }
.icon-topics { background: var(--icon-bg-blue); color: #1677ff; }
.icon-in { background: var(--icon-bg-blue); color: #1677ff; }
.icon-out { background: var(--icon-bg-purple); color: #722ed1; }
.metric-card :deep(.ant-statistic-title) { color: var(--text-tertiary); }
.metric-card :deep(.ant-statistic-content) { font-size: 23px; }
.metric-sub { font-size: 11px; color: var(--text-placeholder); margin-left: 4px; }
@media (max-width: 850px) { .metric-inner { gap: 8px; } .metric-icon { width: 38px; height: 38px; } }

.split-panel {
  display: flex;
  gap: 0;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
  height: calc(100vh - 52px - 48px - 140px - 32px);
  min-height: 400px;
}

.tree-pane {
  width: 340px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  background: var(--bg-subtle);
}

.viewer-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.pane-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-container);
  flex-shrink: 0;
}

.pane-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.pane-count {
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-subtle);
  border-radius: 8px;
  padding: 1px 7px;
}

.broker-version {
  font-size: 10px;
  color: var(--text-placeholder);
}

.tree-filter {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.tree-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 6px 0;
}

.tree-empty {
  padding: 24px 14px;
  font-size: 12px;
  color: var(--text-placeholder);
  text-align: center;
  line-height: 1.6;
}

.viewer-scroll {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
</style>
