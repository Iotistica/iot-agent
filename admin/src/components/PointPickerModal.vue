<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { SearchOutlined, RightOutlined } from '@ant-design/icons-vue'
import { pointCatalogApi, type PointCatalogEntry } from '@/api/point-catalog'
import { client } from '@/api/client'
import { sourcesApi, type ConfiguredPoint } from '@/api/sources'
import type { Endpoint } from '@/types'
import { protocolColor, protocolLabel } from '@/utils/protocol'
import { normalizeDataExplorerPointKey } from '@/utils/data-explorer-point-key'

const props = withDefaults(defineProps<{
  open: boolean
  selectedKeys?: string[]
  mode?: 'multi' | 'single'
  replaceSelectionOnSourceSelect?: boolean
}>(), {
  selectedKeys: () => [],
  mode: 'multi',
  replaceSelectionOnSourceSelect: false,
})

const emit = defineEmits<{
  'update:open': [val: boolean]
  confirm: [keys: string[]]
  select: [point: PointCatalogEntry, deviceName: string]
}>()

const loading = ref(false)
const loadError = ref('')
interface PickerDevice {
  uuid: string
  endpoint_id: number
  name: string
  metadata?: Record<string, unknown>
}

interface PickerPoint {
  point: PointCatalogEntry
  source: Endpoint
  deviceName?: string
  rowKey: number
  unsafeReason?: string
}

const sources = ref<Endpoint[]>([])
const devices = ref<PickerDevice[]>([])
const catalogPoints = ref<PointCatalogEntry[]>([])
const configuredPoints = ref(new Map<string, ConfiguredPoint[]>())
const checkedKeys = ref(new Set<string>())
const normalizedCheckedKeys = computed(() => new Set([...checkedKeys.value].map(normalizeDataExplorerPointKey)))
const searchText = ref('')
const protocolFilter = ref<string | undefined>(undefined)
const expandedProtocols = ref(new Set<string>())
const expandedSources = ref(new Set<string>())

watch(() => props.open, async (isOpen, _wasOpen, onCleanup) => {
  if (!isOpen) return
  let active = true
  onCleanup(() => { active = false })
  checkedKeys.value = new Set(props.selectedKeys)
  searchText.value = ''
  protocolFilter.value = undefined
  expandedProtocols.value = new Set<string>()
  expandedSources.value = new Set<string>()
  loading.value = true
  loadError.value = ''
  sources.value = []
  devices.value = []
  catalogPoints.value = []
  configuredPoints.value = new Map()
  try {
    const [points, sourceList, { data }] = await Promise.all([
      pointCatalogApi.getAll(),
      sourcesApi.getAll(),
      client.get<{ devices: PickerDevice[] }>('/v1/devices'),
    ])
    if (!active) return
    const pointDeviceKeys = new Set(points.map(point => point.deviceKey))
    const usedEndpointIds = new Set(data.devices.filter(device => pointDeviceKeys.has(device.uuid)).map(device => device.endpoint_id))
    const usedSources = sourceList.filter(source => pointDeviceKeys.has(source.uuid) || (source.id !== undefined && usedEndpointIds.has(source.id)))
    const configured = await Promise.all(usedSources.map(async source =>
      [source.uuid, await sourcesApi.getPoints(source.uuid)] as const))
    if (!active) return
    catalogPoints.value = points
    sources.value = sourceList
    devices.value = data.devices
    configuredPoints.value = new Map(configured)
  } catch {
    if (active) loadError.value = 'Unable to load sources and points. Close and reopen the picker to retry.'
  } finally {
    if (active) loading.value = false
  }
})

const pickerPoints = computed(() => {
  const byUuid = new Map(sources.value.map(source => [source.uuid, source]))
  const byId = new Map(sources.value.filter(source => source.id !== undefined).map(source => [source.id, source]))
  const byDevice = new Map(devices.value.map(device => [device.uuid, device]))
  const configuredByName = new Map<string, Map<string, ConfiguredPoint[]>>()
  for (const [uuid, configured] of configuredPoints.value) {
    const names = new Map<string, ConfiguredPoint[]>()
    for (const point of configured) {
      const matches = names.get(point.name) ?? []
      matches.push(point)
      names.set(point.name, matches)
    }
    configuredByName.set(uuid, names)
  }
  const keyCounts = new Map<string, number>()
  for (const point of catalogPoints.value) {
    keyCounts.set(point.pointKey, (keyCounts.get(point.pointKey) ?? 0) + 1)
  }
  const points: PickerPoint[] = []
  let unmapped = 0
  for (const [rowKey, point] of catalogPoints.value.entries()) {
    const device = point.deviceKey ? byDevice.get(point.deviceKey) : undefined
    const source = point.deviceKey ? byUuid.get(point.deviceKey) ?? (device && byId.get(device.endpoint_id)) : undefined
    if (!source || (point.sourceSystem && point.sourceSystem !== source.protocol)) {
      unmapped++
      continue
    }
    const objectName = device?.metadata?.objectName
    const deviceName = device ? (typeof objectName === 'string' && objectName ? objectName : device.name) : undefined
    const matches = configuredByName.get(source.uuid)?.get(point.rawName) ?? []
    const unsafeReason = (keyCounts.get(point.pointKey) ?? 0) > 1 || matches.length > 1
      ? 'Ambiguous point identity; individual selection is unavailable.'
      : !point.sourceSystem ? 'Point key has no protocol; selection is unavailable.'
      : matches.length !== 1 || matches[0].protocolAddress === null || (matches[0].deviceUuid && matches[0].deviceUuid !== device?.uuid)
        ? 'Cannot verify this point against the configured source; selection is unavailable.' : undefined
    points.push({ point, source, deviceName, rowKey, unsafeReason })
  }
  return { points, unmapped }
})

const unsafeKeys = computed(() => {
  const safe = new Set(pickerPoints.value.points.filter(p => !p.unsafeReason).map(p => p.point.pointKey))
  const unsafe = new Set(catalogPoints.value.map(point => point.pointKey).filter(key => !safe.has(key)))
  for (const key of normalizedCheckedKeys.value) if (!safe.has(key)) unsafe.add(key)
  return unsafe
})

interface SourceGroup {
  key: string
  source: Endpoint
  points: PickerPoint[]
  selectablePoints: PickerPoint[]
  allChecked: boolean
  someChecked: boolean
}

interface ProtocolGroup {
  key: string
  protocol: string
  sources: SourceGroup[]
  points: PickerPoint[]
  selectablePoints: PickerPoint[]
  allChecked: boolean
  someChecked: boolean
}

const protocolOptions = computed(() => {
  const set = new Set<string>()
  for (const { source } of pickerPoints.value.points) {
    set.add(source.protocol)
  }
  return [...set].sort().map(v => ({ label: protocolLabel(v), value: v }))
})

const filteredPoints = computed(() => {
  const q = searchText.value.toLowerCase()
  return pickerPoints.value.points.filter(({ point: p, source }) => {
    if (protocolFilter.value && source.protocol !== protocolFilter.value) return false
    if (q && !source.name.toLowerCase().includes(q)
          && !p.normalizedName.toLowerCase().includes(q)
          && !p.rawName.toLowerCase().includes(q)) return false
    return true
  })
})

function selectionState(points: PickerPoint[]) {
  const checkedCount = points.filter(p => isChecked(p.point.pointKey)).length
  return {
    allChecked: points.length > 0 && checkedCount === points.length,
    someChecked: checkedCount > 0,
  }
}

const groupedByProtocol = computed<ProtocolGroup[]>(() => {
  const map = new Map<string, Map<string, PickerPoint[]>>()
  for (const item of filteredPoints.value) {
    const protocol = item.source.protocol
    let sources = map.get(protocol)
    if (!sources) {
      sources = new Map()
      map.set(protocol, sources)
    }
    const points = sources.get(item.source.uuid)
    if (points) points.push(item)
    else sources.set(item.source.uuid, [item])
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([protocol, sourceMap]) => {
      const sources = [...sourceMap.entries()]
        .sort((a, b) => a[1][0].source.name.localeCompare(b[1][0].source.name) || a[0].localeCompare(b[0]))
        .map(([uuid, points]): SourceGroup => {
          const selectablePoints = points.filter(p => !p.unsafeReason)
          return { key: uuid, source: points[0].source, points, selectablePoints, ...selectionState(selectablePoints) }
        })
      const points = sources.flatMap(source => source.points)
      const selectablePoints = sources.flatMap(source => source.selectablePoints)
      return {
        key: protocol,
        protocol,
        sources,
        points,
        selectablePoints,
        ...selectionState(selectablePoints),
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
  const next = new Set(checkedKeys.value)
  if (isChecked(key)) removeMatchingKeys(next, key)
  else next.add(key)
  checkedKeys.value = next
}

function isChecked(key: string) {
  return normalizedCheckedKeys.value.has(key)
}

function removeMatchingKeys(keys: Set<string>, key: string) {
  for (const selected of keys) {
    if (normalizeDataExplorerPointKey(selected) === key) keys.delete(selected)
  }
}

function toggleGroup(points: PickerPoint[], allChecked: boolean) {
  const s = new Set(checkedKeys.value)
  if (allChecked) {
    for (const p of points) removeMatchingKeys(s, p.point.pointKey)
  } else {
    for (const p of points) if (!isChecked(p.point.pointKey)) s.add(p.point.pointKey)
  }
  checkedKeys.value = new Set(s)
}

function toggleSource(points: PickerPoint[], allChecked: boolean) {
  const next = new Set(checkedKeys.value)
  if (allChecked) {
    for (const p of points) removeMatchingKeys(next, p.point.pointKey)
  } else {
    if (props.replaceSelectionOnSourceSelect) {
      const sourceKeys = new Set(points.map(p => p.point.pointKey))
      for (const key of next) {
        const normalized = normalizeDataExplorerPointKey(key)
        if (!unsafeKeys.value.has(normalized) && !sourceKeys.has(normalized)) next.delete(key)
      }
    }
    for (const p of points) {
      if (![...next].some(key => normalizeDataExplorerPointKey(key) === p.point.pointKey)) next.add(p.point.pointKey)
    }
  }
  checkedKeys.value = next
}

function onConfirm() {
  emit('confirm', [...checkedKeys.value])
  emit('update:open', false)
}

function selectSinglePoint(item: PickerPoint) {
  if (item.unsafeReason || !item.deviceName) return
  emit('select', item.point, item.deviceName)
  emit('update:open', false)
}
</script>

<template>
  <a-modal
    :open="open"
    :title="mode === 'single' ? 'Select Point' : 'Select Points'"
    :width="680"
    :footer="null"
    @cancel="emit('update:open', false)"
  >
    <div class="picker-toolbar">
      <a-input
        v-model:value="searchText"
        placeholder="Search source or point name…"
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
      <span v-if="mode === 'multi'" class="selection-count">{{ checkedKeys.size }} selected</span>
    </div>

    <a-spin :spinning="loading">
      <a-alert v-if="loadError" :message="loadError" type="error" show-icon />
      <a-alert v-if="!loading && !loadError && pickerPoints.points.length" message="Catalog keys are name-based; points may already be merged before they reach this picker." type="info" show-icon />
      <a-alert v-if="!loading && !loadError && pickerPoints.unmapped" :message="`${pickerPoints.unmapped} catalog points could not be matched to a source UUID and are not shown.`" type="warning" show-icon />
      <a-alert v-if="!loading && !loadError && unsafeKeys.size" message="Some points have ambiguous or unverifiable selection keys and cannot be newly selected. Existing selections are preserved." type="warning" show-icon />
      <div class="picker-list">
        <template v-if="groupedByProtocol.length">
          <div v-for="group in groupedByProtocol" :key="group.key" class="protocol-group">
            <div class="protocol-header" @click="expandedProtocols = toggleExpand(expandedProtocols, group.key)">
              <a-checkbox
                v-if="mode === 'multi'"
                :checked="group.allChecked"
                :indeterminate="group.someChecked && !group.allChecked"
                :disabled="!group.selectablePoints.length"
                @click.stop
                @change="toggleGroup(group.selectablePoints, group.allChecked)"
              />
              <RightOutlined :class="['expand-icon', { expanded: expandedProtocols.has(group.key) }]" />
              <a-tag :color="protocolColor(group.protocol)" class="proto-tag">{{ group.protocol ? protocolLabel(group.protocol) : 'Unknown protocol' }}</a-tag>
              <span class="point-count">({{ group.points.length }})</span>
            </div>

            <div v-if="expandedProtocols.has(group.key)" class="source-items">
              <div v-for="source in group.sources" :key="source.key" class="source-group">
                <div class="source-header" @click="expandedSources = toggleExpand(expandedSources, source.key)">
                  <a-checkbox
                    v-if="mode === 'multi'"
                    :checked="source.allChecked"
                    :indeterminate="source.someChecked && !source.allChecked"
                    :disabled="!source.selectablePoints.length"
                    @click.stop
                    @change="toggleSource(source.selectablePoints, source.allChecked)"
                  />
                  <RightOutlined :class="['expand-icon', { expanded: expandedSources.has(source.key) }]" />
                  <span class="source-name">{{ source.source.name }}</span>
                  <span v-if="group.sources.filter(s => s.source.name === source.source.name).length > 1" class="pt-raw">{{ source.source.uuid }}</span>
                  <span class="point-count">({{ source.points.length }})</span>
                </div>

                <div v-if="expandedSources.has(source.key)" class="point-items">
                  <div
                    v-for="pt in source.points"
                    :key="pt.rowKey"
                    class="point-item"
                    :class="{ 'point-item--clickable': mode === 'single' && !pt.unsafeReason && pt.deviceName }"
                    @click="mode === 'single' && selectSinglePoint(pt)"
                  >
                    <a-checkbox
                      v-if="mode === 'multi'"
                      :checked="isChecked(pt.point.pointKey)"
                      :disabled="!!pt.unsafeReason"
                      @change="togglePoint(pt.point.pointKey)"
                    />
                    <span v-if="mode === 'single' && !pt.unsafeReason && pt.deviceName" class="radio-dot" />
                    <span class="pt-name">{{ pt.point.normalizedName }}</span>
                    <span v-if="pt.point.rawName !== pt.point.normalizedName" class="pt-raw">{{ pt.point.rawName }}</span>
                    <span v-if="pt.deviceName" class="pt-raw">{{ pt.deviceName }}</span>
                    <span v-if="pt.unsafeReason" class="pt-raw">{{ pt.unsafeReason }}</span>
                    <span v-else-if="mode === 'single' && !pt.deviceName" class="pt-raw">Device metadata is required for this selection.</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
        <a-empty v-else-if="!loading && !loadError" description="No points match the current filters" />
      </div>
    </a-spin>

    <div v-if="mode === 'multi'" class="picker-footer">
      <a-button @click="emit('update:open', false)">Cancel</a-button>
      <a-button type="primary" :disabled="loading || !!loadError || checkedKeys.size === 0" @click="onConfirm">
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
.point-item--clickable { cursor: pointer; padding: 6px 4px; border-radius: 4px; }
.point-item--clickable:hover { background: var(--bg-selected-light); }
.point-item--clickable:hover .radio-dot { border-color: #1677ff; }
.radio-dot { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--border-color-strong); flex-shrink: 0; box-sizing: border-box; }
.pt-name { font-size: 13px; color: var(--text-primary); }
.pt-raw { font-size: 11px; color: var(--text-tertiary); }

.picker-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
