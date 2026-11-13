<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import TopicTree from '@/components/mqtt/TopicTree.vue'
import type { TopicNode } from '@/api/mqtt'
import {
  sourcesApi, type OPCUABrowseNode, type OPCUADeviceIdentification,
  type DeviceCandidateStrategy, type DeviceDiscoveryPreview,
} from '@/api/sources'

const props = defineProps<{ open: boolean; connection: Record<string, unknown>; identification: OPCUADeviceIdentification | null; sourceUuid?: string }>()
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
const strategyType = ref<DeviceCandidateStrategy['type']>('device-model')
const scopeAddress = ref('')
const deviceDepth = ref(1)
const tagTemplate = ref('{device}_{point}')
const manualName = ref('')
const manualPoints = ref<Array<{ address: string; name: string }>>([])
const preview = ref<DeviceDiscoveryPreview | null>(null)
const previewLoading = ref(false)
let previewGeneration = 0

watch([strategyType, scopeAddress, deviceDepth, tagTemplate, manualName, manualPoints, () => props.identification, () => props.connection], () => {
  previewGeneration++
  preview.value = null
}, { deep: true })

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
  previewGeneration++
  preview.value = null
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
    deviceTypeNodeId: entry.node.typeDefinition,
    identifierProperty: props.identification?.identifierProperty ?? '',
    identifierPath: props.identification?.identifierPath ?? '',
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

function addManualPoint() {
  if (!selected.value || selected.value.node.nodeClass !== 'Variable') return
  const { nodeId, browseName } = selected.value.node
  if (!manualPoints.value.some(point => point.address === nodeId)) {
    manualPoints.value = [...manualPoints.value, { address: nodeId, name: browseName }]
  }
}

async function previewDevices() {
  let strategy: DeviceCandidateStrategy
  if (strategyType.value === 'identifier') {
    const identifierPath = props.identification?.identifierPath.trim()
    if (!identifierPath) {
      message.error('Select or enter a relative identifier path first')
      return
    }
    strategy = { type: 'identifier', identifierPath }
  } else if (strategyType.value === 'hierarchy') {
    if (!scopeAddress.value) {
      message.error('Select a scope object from the tree')
      return
    }
    strategy = { type: 'hierarchy', scopeAddress: scopeAddress.value, deviceDepth: deviceDepth.value }
  } else if (strategyType.value === 'tag-pattern') {
    strategy = { type: 'tag-pattern', template: tagTemplate.value }
  } else if (strategyType.value === 'manual') {
    if (!manualName.value.trim() || !manualPoints.value.length) {
      message.error('Enter a device name and select at least one point')
      return
    }
    strategy = { type: 'manual', mappings: [{ id: manualName.value.trim(), name: manualName.value.trim(), pointAddresses: manualPoints.value.map(p => p.address) }] }
  } else {
    strategy = { type: 'device-model' }
  }
  const currentGeneration = ++previewGeneration
  previewLoading.value = true
  preview.value = null
  try {
    const result = await sourcesApi.previewOpcuaDevices(props.connection, strategy, props.sourceUuid)
    if (currentGeneration === previewGeneration) preview.value = result
  } catch (err) {
    if (currentGeneration === previewGeneration) message.error((err as { message?: string }).message ?? 'Unable to preview devices')
  } finally {
    previewLoading.value = false
  }
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
    <a-divider orientation="left" orientation-margin="0">Device Discovery Preview</a-divider>
    <p>Preview suggestions only. No devices are created or changed.</p>
    <a-space direction="vertical" style="width: 100%">
      <a-select v-model:value="strategyType" style="width: 100%">
        <a-select-option value="device-model">OPC UA device models</a-select-option>
        <a-select-option value="identifier">Identifier property</a-select-option>
        <a-select-option value="hierarchy">Hierarchy depth</a-select-option>
        <a-select-option value="tag-pattern">Tag naming pattern</a-select-option>
        <a-select-option value="manual">Manual mapping</a-select-option>
      </a-select>
      <template v-if="strategyType === 'hierarchy'">
        <a-space wrap>
          <a-button :disabled="!selected || selected.node.nodeClass !== 'Object'" @click="scopeAddress = selected?.node.nodeId ?? ''">Use Selected Scope</a-button>
          <span>{{ scopeAddress || 'No scope selected' }}</span>
          <span>Device depth</span><a-input-number v-model:value="deviceDepth" :min="1" :max="20" />
        </a-space>
      </template>
      <a-input v-if="strategyType === 'tag-pattern'" v-model:value="tagTemplate" placeholder="{device}_{point}" />
      <template v-if="strategyType === 'manual'">
        <a-input v-model:value="manualName" placeholder="Device name" />
        <a-button :disabled="!selected || selected.node.nodeClass !== 'Variable'" @click="addManualPoint">Add Selected Point</a-button>
        <div v-for="point in manualPoints" :key="point.address">
          {{ point.name }} ({{ point.address }})
          <a-button type="link" size="small" @click="manualPoints = manualPoints.filter(p => p.address !== point.address)">Remove</a-button>
        </div>
      </template>
      <a-button :loading="previewLoading" @click="previewDevices">Preview Devices</a-button>
      <template v-if="preview">
        <span>{{ preview.pointCount }} points; {{ preview.unassignedPointAddresses.length }} currently unassigned</span>
        <a-empty v-if="!preview.candidates.length" description="No device suggestions" />
        <a-alert v-for="item in preview.candidates" :key="item.candidate.candidateId"
          :type="item.status === 'conflict' ? 'warning' : 'info'" show-icon
          :message="`${item.candidate.name} — ${item.status} (${item.candidate.pointAddresses.length} points)`"
          :description="[...item.candidate.reasons, ...item.conflicts].join('; ')" />
      </template>
    </a-space>
  </a-modal>
</template>

<style scoped>
.browser-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
.browser-tree { min-height: 300px; max-height: 480px; overflow: auto; border: 1px solid var(--border-color); border-radius: 6px; padding: 8px; }
.browser-details { min-width: 0; overflow-wrap: anywhere; }
@media (max-width: 700px) { .browser-layout { grid-template-columns: 1fr; } }
</style>
