<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import TopicTree from '@/components/mqtt/TopicTree.vue'
import type { TopicNode } from '@/api/mqtt'
import { sourcesApi, type OPCUABrowseNode, type OPCUADeviceIdentification } from '@/api/sources'

const props = defineProps<{ open: boolean; connection: Record<string, unknown> }>()
const emit = defineEmits<{
  'update:open': [value: boolean]
  select: [value: OPCUADeviceIdentification]
}>()

interface TreeEntry {
  node: OPCUABrowseNode
  topic: TopicNode
  ids: string[]
  names: string[]
  parentId: string
}

const objectsId = 'ns=0;i=85'
const nodes = ref<Record<string, TopicNode>>({})
const collapsed = ref(new Set<string>())
const entries = new Map<string, TreeEntry>()
const loaded = new Set<string>()
const selected = ref<TreeEntry | null>(null)
const root = ref<TreeEntry | null>(null)
const loading = ref(false)
const error = ref('')
let generation = 0

function makeEntry(node: OPCUABrowseNode, parentId: string, ids: string[], names: string[]): TreeEntry {
  const nextIds = [...ids, node.nodeId]
  const key = JSON.stringify(nextIds)
  const topic = reactive<TopicNode>({
    name: node.browseName, fullTopic: key, count: 0, bytes: 0, lastMessage: null,
    lastMessageAt: null, messageType: 'string', truncated: false, retain: false, qos: 0,
    children: {}, expandable: (node.nodeClass === 'Object' || node.nodeClass === 'Variable') && !ids.includes(node.nodeId),
  })
  const entry = { node, topic, ids: nextIds, names: [...names, node.browseName], parentId }
  entries.set(key, entry)
  collapsed.value.add(key)
  return entry
}

async function loadChildren(nodeId: string, parent: TreeEntry | null, currentGeneration: number) {
  const children = await sourcesApi.browseOpcua(props.connection, nodeId)
  if (currentGeneration !== generation) return
  const result: Record<string, TopicNode> = {}
  for (const child of children) {
    const entry = makeEntry(child, nodeId, parent?.ids ?? [objectsId], parent?.names ?? ['Objects'])
    result[entry.topic.fullTopic] = entry.topic
  }
  if (parent) {
    parent.topic.children = result
    parent.topic.expandable = Object.keys(result).length > 0
    loaded.add(parent.topic.fullTopic)
  } else {
    nodes.value = result
  }
}

watch(() => props.open, async open => {
  generation++
  if (!open) return
  nodes.value = {}
  collapsed.value = new Set()
  entries.clear()
  loaded.clear()
  selected.value = null
  root.value = null
  error.value = ''
  loading.value = true
  const currentGeneration = generation
  try {
    await loadChildren(objectsId, null, currentGeneration)
  } catch (err) {
    if (currentGeneration === generation) error.value = (err as { message?: string }).message ?? 'Unable to browse the address space'
  } finally {
    if (currentGeneration === generation) loading.value = false
  }
})

async function toggle(key: string) {
  if (!collapsed.value.has(key)) {
    collapsed.value.add(key)
    return
  }
  collapsed.value.delete(key)
  const entry = entries.get(key)
  if (!entry || loaded.has(key) || entry.topic.loading) return
  entry.topic.loading = true
  const currentGeneration = generation
  try {
    await loadChildren(entry.node.nodeId, entry, currentGeneration)
  } catch (err) {
    collapsed.value.add(key)
    message.error((err as { message?: string }).message ?? 'Unable to browse node')
  } finally {
    entry.topic.loading = false
  }
}

function selectRoot() {
  const entry = selected.value
  if (!entry || entry.node.nodeClass !== 'Object' || !entry.node.typeDefinition) {
    message.error('Select an object with a device type as the device root')
    return
  }
  root.value = entry
  emit('select', {
    rootNodeId: entry.node.nodeId, scopeNodeId: entry.parentId,
    deviceTypeNodeId: entry.node.typeDefinition, identifierProperty: '', identifierPath: '',
  })
}

function selectIdentifier() {
  const entry = selected.value
  const device = root.value
  if (!entry || !device || entry.node.nodeClass !== 'Variable' ||
      entry.ids.length <= device.ids.length ||
      !device.ids.every((id, i) => entry.ids[i] === id)) {
    message.error('Select a variable beneath the selected device root')
    return
  }
  const parts = entry.names.slice(device.names.length)
  if (parts.some(part => part.includes('/'))) {
    message.error('Browse names containing "/" cannot be used in a relative identifier path')
    return
  }
  emit('select', {
    rootNodeId: device.node.nodeId, scopeNodeId: device.parentId,
    deviceTypeNodeId: device.node.typeDefinition!,
    identifierProperty: entry.node.browseName, identifierPath: parts.join('/'),
  })
  emit('update:open', false)
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null) return '—'
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
}
</script>

<template>
  <a-modal :open="open" title="Browse OPC UA" :width="900" :footer="null" centered @cancel="emit('update:open', false)">
    <p>Select a device root, then select its identifier variable. Matching objects beneath the root's parent will be discovered.</p>
    <a-alert v-if="error" type="error" :message="error" show-icon style="margin-bottom: 12px" />
    <a-spin :spinning="loading">
      <div class="browser-layout">
        <div class="browser-tree">
          <TopicTree :nodes="nodes" :selected-topic="selected?.topic.fullTopic ?? null" :collapsed="collapsed" lazy
            @select="selected = entries.get($event.fullTopic) ?? null" @toggle="toggle" />
          <a-empty v-if="!loading && !error && !Object.keys(nodes).length" description="No nodes found" />
        </div>
        <div class="browser-details">
          <a-descriptions v-if="selected" bordered size="small" :column="1">
            <a-descriptions-item label="NodeId">{{ selected.node.nodeId }}</a-descriptions-item>
            <a-descriptions-item label="BrowseName">{{ selected.node.browseName }}</a-descriptions-item>
            <a-descriptions-item label="NodeClass">{{ selected.node.nodeClass }}</a-descriptions-item>
            <a-descriptions-item label="DataType">{{ selected.node.dataType || '—' }}</a-descriptions-item>
            <a-descriptions-item label="Value">{{ displayValue(selected.node.value) }}<span v-if="selected.node.value === undefined && selected.node.valueStatus"> ({{ selected.node.valueStatus }})</span></a-descriptions-item>
            <a-descriptions-item label="Browse path">{{ selected.names.join(' / ') }}</a-descriptions-item>
          </a-descriptions>
          <a-empty v-else description="Select a node" />
          <a-space style="margin-top: 16px" wrap>
            <a-button :disabled="!selected || selected.node.nodeClass !== 'Object'" @click="selectRoot">Use as Device Root</a-button>
            <a-button type="primary" :disabled="!root || !selected || selected.node.nodeClass !== 'Variable'" @click="selectIdentifier">Use as Identifier</a-button>
          </a-space>
          <div v-if="root" style="margin-top: 12px; color: var(--text-tertiary)">Device root: {{ root.names.join(' / ') }}</div>
        </div>
      </div>
    </a-spin>
  </a-modal>
</template>

<style scoped>
.browser-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
.browser-tree { min-height: 300px; max-height: 480px; overflow: auto; border: 1px solid var(--border-color); border-radius: 6px; padding: 8px; }
.browser-details { min-width: 0; overflow-wrap: anywhere; }
@media (max-width: 700px) { .browser-layout { grid-template-columns: 1fr; } }
</style>
