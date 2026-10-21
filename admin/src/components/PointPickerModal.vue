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
const expandedDevices = ref(new Set<string>())

watch(() => props.open, async (isOpen) => {
  if (!isOpen) return
  checkedKeys.value = new Set(props.selectedKeys)
  searchText.value = ''
  protocolFilter.value = undefined
  expandedDevices.value = new Set<string>()
  if (!catalogPoints.value.length) {
    loading.value = true
    try {
      catalogPoints.value = await pointCatalogApi.getAll()
    } catch { /* non-critical */ }
    loading.value = false
  }
})

interface DeviceGroup {
  endpointName: string
  protocol: string
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

const groupedByDevice = computed<DeviceGroup[]>(() => {
  const map = new Map<string, PointCatalogEntry[]>()
  for (const p of filteredPoints.value) {
    const list = map.get(p.endpointName)
    if (list) list.push(p)
    else map.set(p.endpointName, [p])
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([endpointName, points]) => {
      const checked = points.filter(p => checkedKeys.value.has(p.pointKey))
      return {
        endpointName,
        protocol: points[0].sourceSystem ?? '',
        points,
        allChecked: checked.length === points.length,
        someChecked: checked.length > 0,
      }
    })
})

function toggleExpand(name: string) {
  const s = expandedDevices.value
  if (s.has(name)) s.delete(name)
  else s.add(name)
}

function togglePoint(key: string) {
  const s = checkedKeys.value
  if (s.has(key)) s.delete(key)
  else s.add(key)
  checkedKeys.value = new Set(s)
}

function toggleGroup(group: DeviceGroup) {
  const s = checkedKeys.value
  if (group.allChecked) {
    for (const p of group.points) s.delete(p.pointKey)
  } else {
    for (const p of group.points) s.add(p.pointKey)
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
        <template v-if="groupedByDevice.length">
          <div v-for="group in groupedByDevice" :key="group.endpointName" class="device-group">
            <div class="device-header" @click="toggleExpand(group.endpointName)">
              <a-checkbox
                :checked="group.allChecked"
                :indeterminate="group.someChecked && !group.allChecked"
                @click.stop
                @change="toggleGroup(group)"
              />
              <RightOutlined :class="['expand-icon', { expanded: expandedDevices.has(group.endpointName) }]" />
              <a-tag :color="protocolColor(group.protocol)" class="proto-tag">{{ protocolLabel(group.protocol) }}</a-tag>
              <span class="device-name">{{ group.endpointName }}</span>
              <span class="point-count">({{ group.points.length }})</span>
            </div>

            <div v-if="expandedDevices.has(group.endpointName)" class="point-items">
              <div v-for="pt in group.points" :key="pt.pointKey" class="point-item">
                <a-checkbox
                  :checked="checkedKeys.has(pt.pointKey)"
                  @change="togglePoint(pt.pointKey)"
                />
                <span class="pt-name">{{ pt.normalizedName }}</span>
                <span v-if="pt.rawName !== pt.normalizedName" class="pt-raw">{{ pt.rawName }}</span>
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
.device-group { border-bottom: 1px solid var(--border-color); }
.device-group:last-child { border-bottom: none; }

.device-header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; background: var(--bg-subtle); }
.device-header:hover { background: var(--bg-selected-light); }
.device-name { font-size: 13px; font-weight: 500; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
