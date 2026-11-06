<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { SearchOutlined, RightOutlined } from '@ant-design/icons-vue'
import { pointCatalogApi, type PointCatalogEntry } from '@/api/point-catalog'
import { protocolColor, protocolLabel } from '@/utils/protocol'

const props = defineProps<{
  open: boolean
  selectedKeys: string[]
}>()

const emit = defineEmits<{
  'update:open': [val: boolean]
  confirm: [keys: string[]]
}>()

const loading = ref(false)
const catalogPoints = ref<PointCatalogEntry[]>([])
const checkedKeys = ref(new Set<string>())
const searchText = ref('')
const protocolFilter = ref<string | undefined>(undefined)
const expandedProtocols = ref(new Set<string>())
const expandedSources = ref(new Set<string>())

watch(() => props.open, async (isOpen) => {
  if (!isOpen) return
  checkedKeys.value = new Set(props.selectedKeys)
  searchText.value = ''
  protocolFilter.value = undefined
  expandedProtocols.value = new Set<string>()
  expandedSources.value = new Set<string>()
  if (!catalogPoints.value.length) {
    loading.value = true
    try {
      catalogPoints.value = await pointCatalogApi.getAll()
    } catch { /* non-critical */ }
    loading.value = false
  }
})

interface SourceGroup {
  key: string
  endpointName: string
  points: PointCatalogEntry[]
  allChecked: boolean
  someChecked: boolean
}

interface ProtocolGroup {
  key: string
  protocol: string
  sources: SourceGroup[]
  points: PointCatalogEntry[]
  allChecked: boolean
  someChecked: boolean
}

const protocolOptions = computed(() => {
  const set = new Set<string>()
  for (const p of catalogPoints.value) {
    if (p.sourceSystem) set.add(p.sourceSystem)
  }
  return [...set].sort().map(v => ({ label: protocolLabel(v), value: v }))
})

const filteredPoints = computed(() => {
  const q = searchText.value.toLowerCase()
  return catalogPoints.value.filter(p => {
    if (protocolFilter.value && p.sourceSystem !== protocolFilter.value) return false
    if (q && !p.endpointName.toLowerCase().includes(q)
          && !p.normalizedName.toLowerCase().includes(q)
          && !p.rawName.toLowerCase().includes(q)) return false
    return true
  })
})

function selectionState(points: PointCatalogEntry[]) {
  const checkedCount = points.filter(p => checkedKeys.value.has(p.pointKey)).length
  return {
    allChecked: checkedCount === points.length,
    someChecked: checkedCount > 0,
  }
}

function sourceKey(protocol: string, endpointName: string) {
  return JSON.stringify([protocol, endpointName])
}

const groupedByProtocol = computed<ProtocolGroup[]>(() => {
  const map = new Map<string, Map<string, PointCatalogEntry[]>>()
  for (const p of filteredPoints.value) {
    const protocol = p.sourceSystem ?? ''
    let sources = map.get(protocol)
    if (!sources) {
      sources = new Map()
      map.set(protocol, sources)
    }
    const points = sources.get(p.endpointName)
    if (points) points.push(p)
    else sources.set(p.endpointName, [p])
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([protocol, sourceMap]) => {
      const sources = [...sourceMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([endpointName, points]): SourceGroup => ({
          key: sourceKey(protocol, endpointName),
          endpointName,
          points,
          ...selectionState(points),
        }))
      const points = sources.flatMap(source => source.points)
      return {
        key: protocol,
        protocol,
        sources,
        points,
        ...selectionState(points),
      }
    })
})

function toggleExpand(keys: Set<string>, key: string) {
  const next = new Set(keys)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

function togglePoint(key: string) {
  const s = checkedKeys.value
  if (s.has(key)) s.delete(key)
  else s.add(key)
  checkedKeys.value = new Set(s)
}

function toggleGroup(points: PointCatalogEntry[], allChecked: boolean) {
  const s = checkedKeys.value
  if (allChecked) {
    for (const p of points) s.delete(p.pointKey)
  } else {
    for (const p of points) s.add(p.pointKey)
  }
  checkedKeys.value = new Set(s)
}

function onConfirm() {
  emit('confirm', [...checkedKeys.value])
  emit('update:open', false)
}
</script>

<template>
  <a-modal
    :open="open"
    title="Select Points"
    :width="680"
    :footer="null"
    @cancel="emit('update:open', false)"
  >
    <div class="picker-toolbar">
      <a-input
        v-model:value="searchText"
        placeholder="Search device or point name…"
        allow-clear
        style="flex: 1"
      >
        <template #prefix><SearchOutlined style="color: var(--text-placeholder)" /></template>
      </a-input>
      <a-select
        v-model:value="protocolFilter"
        placeholder="All protocols"
        allow-clear
        :options="protocolOptions"
        style="width: 140px"
      />
      <span class="selection-count">{{ checkedKeys.size }} selected</span>
    </div>

    <a-spin :spinning="loading">
      <div class="picker-list">
        <template v-if="groupedByProtocol.length">
          <div v-for="group in groupedByProtocol" :key="group.key" class="protocol-group">
            <div class="protocol-header" @click="expandedProtocols = toggleExpand(expandedProtocols, group.key)">
              <a-checkbox
                :checked="group.allChecked"
                :indeterminate="group.someChecked && !group.allChecked"
                @click.stop
                @change="toggleGroup(group.points, group.allChecked)"
              />
              <RightOutlined :class="['expand-icon', { expanded: expandedProtocols.has(group.key) }]" />
              <a-tag :color="protocolColor(group.protocol)" class="proto-tag">{{ group.protocol ? protocolLabel(group.protocol) : 'Unknown protocol' }}</a-tag>
              <span class="point-count">({{ group.points.length }})</span>
            </div>

            <div v-if="expandedProtocols.has(group.key)" class="source-items">
              <div v-for="source in group.sources" :key="source.key" class="source-group">
                <div class="source-header" @click="expandedSources = toggleExpand(expandedSources, source.key)">
                  <a-checkbox
                    :checked="source.allChecked"
                    :indeterminate="source.someChecked && !source.allChecked"
                    @click.stop
                    @change="toggleGroup(source.points, source.allChecked)"
                  />
                  <RightOutlined :class="['expand-icon', { expanded: expandedSources.has(source.key) }]" />
                  <span class="source-name">{{ source.endpointName }}</span>
                  <span class="point-count">({{ source.points.length }})</span>
                </div>

                <div v-if="expandedSources.has(source.key)" class="point-items">
                  <div v-for="pt in source.points" :key="pt.pointKey" class="point-item">
                    <a-checkbox
                      :checked="checkedKeys.has(pt.pointKey)"
                      @change="togglePoint(pt.pointKey)"
                    />
                    <span class="pt-name">{{ pt.normalizedName }}</span>
                    <span v-if="pt.rawName !== pt.normalizedName" class="pt-raw">{{ pt.rawName }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
        <a-empty v-else-if="!loading" description="No points match the current filters" />
      </div>
    </a-spin>

    <div class="picker-footer">
      <a-button @click="emit('update:open', false)">Cancel</a-button>
      <a-button type="primary" :disabled="checkedKeys.size === 0" @click="onConfirm">
        Confirm ({{ checkedKeys.size }})
      </a-button>
    </div>
  </a-modal>
</template>

<style scoped>
.picker-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
.selection-count { font-size: 12px; color: var(--text-tertiary); white-space: nowrap; }

.picker-list { max-height: 55vh; overflow-y: auto; border: 1px solid var(--border-color); border-radius: 6px; }
.protocol-group { border-bottom: 1px solid var(--border-color); }
.protocol-group:last-child { border-bottom: none; }

.protocol-header, .source-header { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.protocol-header { padding: 8px 12px; background: var(--bg-subtle); }
.protocol-header:hover, .source-header:hover { background: var(--bg-selected-light); }
.source-items { padding-left: 24px; }
.source-group { border-top: 1px solid var(--border-color); }
.source-header { padding: 7px 12px; }
.source-name { font-size: 13px; font-weight: 500; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.point-count { font-size: 11px; color: var(--text-tertiary); flex-shrink: 0; }
.proto-tag { margin: 0; font-size: 10px; min-width: 50px; text-align: center; flex-shrink: 0; }

.expand-icon { font-size: 10px; color: var(--text-tertiary); transition: transform 0.2s; flex-shrink: 0; }
.expand-icon.expanded { transform: rotate(90deg); }

.point-items { padding: 0 12px 4px 40px; }
.point-item { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.pt-name { font-size: 13px; color: var(--text-primary); }
.pt-raw { font-size: 11px; color: var(--text-tertiary); }

.picker-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
