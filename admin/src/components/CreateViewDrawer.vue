<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { message } from 'ant-design-vue'
import { DeleteOutlined, EditOutlined } from '@ant-design/icons-vue'
import { viewsApi, type SavedView } from '@/api/views'
import { protocolColor, protocolLabel } from '@/utils/protocol'
import PointPickerModal from './PointPickerModal.vue'

type PointRow = {
  key: string
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

const props = defineProps<{
  open: boolean
  pointRows: PointRow[]
  editingView: SavedView | null
}>()

const emit = defineEmits<{
  'update:open': [val: boolean]
  saved: []
}>()

const name = ref('')
const description = ref('')
const selectedKeys = ref<string[]>([])
const saving = ref(false)
const showAllPoints = ref(false)
const pickerOpen = ref(false)

const isEdit = computed(() => props.editingView !== null)
const VISIBLE_LIMIT = 6

watch(() => props.open, (open) => {
  if (!open) return
  showAllPoints.value = false
  if (props.editingView) {
    name.value = props.editingView.name
    description.value = props.editingView.description ?? ''
    selectedKeys.value = [...props.editingView.pointKeys]
  } else {
    name.value = ''
    description.value = ''
    selectedKeys.value = props.pointRows.map(p => p.key)
  }
})

const pointRowMap = computed(() => {
  const map = new Map<string, PointRow>()
  for (const p of props.pointRows) map.set(p.key, p)
  return map
})

interface DisplayPoint {
  key: string
  protocol: string
  primaryName: string
  secondaryLine: string
  fullIdentifier: string
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

const displayPoints = computed<DisplayPoint[]>(() => {
  return selectedKeys.value.map(key => {
    const row = pointRowMap.value.get(key)
    if (row) {
      const name = row.rawPointName && row.rawPointName !== row.metric
        ? row.rawPointName
        : row.normalizedName || row.metric
      return {
        key,
        protocol: row.protocol,
        primaryName: truncate(name, 40),
        secondaryLine: row.endpointName,
        fullIdentifier: `${row.endpointName} / ${row.metric}`,
      }
    }
    try {
      const parts = JSON.parse(key) as string[]
      return {
        key,
        protocol: parts[0] || '',
        primaryName: truncate(parts[2] || 'Unknown', 40),
        secondaryLine: parts[1] || '',
        fullIdentifier: `${parts[0]} / ${parts[1]} / ${parts[2]}`,
      }
    } catch {
      return { key, protocol: '', primaryName: 'Unknown point', secondaryLine: '', fullIdentifier: key }
    }
  })
})

const visiblePoints = computed(() =>
  showAllPoints.value ? displayPoints.value : displayPoints.value.slice(0, VISIBLE_LIMIT))
const hiddenCount = computed(() => Math.max(0, displayPoints.value.length - VISIBLE_LIMIT))

function removePoint(key: string) {
  selectedKeys.value = selectedKeys.value.filter(k => k !== key)
}

const canSave = computed(() => name.value.trim().length > 0 && selectedKeys.value.length > 0)

async function save() {
  const trimmedName = name.value.trim()
  if (!trimmedName || selectedKeys.value.length === 0) return
  saving.value = true
  try {
    if (isEdit.value) {
      await viewsApi.update(props.editingView!.id, {
        name: trimmedName,
        description: description.value.trim(),
        pointKeys: selectedKeys.value,
      })
      message.success('View updated')
    } else {
      await viewsApi.create({
        name: trimmedName,
        description: description.value.trim(),
        pointKeys: selectedKeys.value,
      })
      message.success('View created')
    }
    emit('saved')
    emit('update:open', false)
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Failed to save view')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <a-drawer
    :open="open"
    :title="isEdit ? 'Edit View' : 'Create View'"
    :width="480"
    @close="emit('update:open', false)"
  >
    <div class="drawer-body">
      <div class="section">
        <div class="section-title">Basic Information</div>
        <div class="field">
          <label class="field-label">Name <span class="required">*</span></label>
          <a-input v-model:value="name" placeholder="e.g. AHU Supply Temps" :maxlength="100" />
        </div>
        <div class="field">
          <label class="field-label">Description</label>
          <a-textarea v-model:value="description" placeholder="Optional description" :rows="2" :maxlength="500" />
        </div>
      </div>

      <div class="section">
        <div class="section-header">
          <div>
            <div class="section-title" style="margin-bottom: 2px">Selected Points ({{ selectedKeys.length }})</div>
            <div class="section-subtitle">Points included in this view</div>
          </div>
          <a-button size="small" class="edit-selection-btn" @click="pickerOpen = true">
            <EditOutlined /> {{ selectedKeys.length ? 'Edit Selection' : 'Select Points' }}
          </a-button>
        </div>

        <div v-if="!selectedKeys.length" class="empty-state">
          <p>No points selected.</p>
          <p>Select rows in the table first, or use the button above to pick from the catalog.</p>
        </div>

        <div v-else class="points-list">
          <div v-for="dp in visiblePoints" :key="dp.key" class="point-row">
            <a-tag :color="protocolColor(dp.protocol)" class="proto-tag">{{ protocolLabel(dp.protocol) }}</a-tag>
            <div class="point-info" :title="dp.fullIdentifier">
              <div class="point-name">{{ dp.primaryName }}</div>
              <div v-if="dp.secondaryLine" class="point-meta">{{ dp.secondaryLine }}</div>
            </div>
            <a-button type="text" size="small" class="remove-btn" @click="removePoint(dp.key)">
              <template #icon><DeleteOutlined /></template>
            </a-button>
          </div>
          <a-button v-if="hiddenCount > 0 && !showAllPoints" type="link" size="small" class="toggle-link" @click="showAllPoints = true">
            Show {{ hiddenCount }} more points…
          </a-button>
          <a-button v-if="showAllPoints && hiddenCount > 0" type="link" size="small" class="toggle-link" @click="showAllPoints = false">
            Show less
          </a-button>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="drawer-footer">
        <a-button @click="emit('update:open', false)">Cancel</a-button>
        <a-button type="primary" :loading="saving" :disabled="!canSave" @click="save">
          {{ isEdit ? 'Save Changes' : 'Create View' }}
        </a-button>
      </div>
    </template>
  </a-drawer>

  <PointPickerModal
    v-model:open="pickerOpen"
    :selected-keys="selectedKeys"
    @confirm="(keys: string[]) => selectedKeys = keys"
  />
</template>

<style scoped>
.drawer-body { display: flex; flex-direction: column; gap: 20px; }
.section { border: 1px solid #edf0f5; border-radius: 8px; padding: 16px; }
.section-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.section-title { font-size: 14px; font-weight: 650; color: #1a2332; margin-bottom: 12px; }
.section-subtitle { font-size: 12px; color: #8a94a3; margin: 0; }
.edit-selection-btn { color: #1677ff; border-color: #1677ff; flex-shrink: 0; }
.field { margin-bottom: 10px; }
.field:last-child { margin-bottom: 0; }
.field-label { display: block; font-size: 12px; font-weight: 600; color: #555; margin-bottom: 5px; }
.required { color: #f04452; }

.empty-state { text-align: center; padding: 20px 12px; color: #8a94a3; font-size: 13px; }
.empty-state p { margin: 0 0 4px; }

.points-list { display: flex; flex-direction: column; }
.point-row { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid #f0f2f5; }
.point-row:last-of-type { border-bottom: none; }
.proto-tag { flex-shrink: 0; margin: 0; font-size: 11px; min-width: 58px; text-align: center; }
.point-info { flex: 1; min-width: 0; overflow: hidden; }
.point-name { font-size: 13px; font-weight: 500; color: #1a2332; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.point-meta { font-size: 11px; color: #8a94a3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 1px; }
.remove-btn { color: #bbb; flex-shrink: 0; }
.remove-btn:hover { color: #f04452; }
.toggle-link { padding: 8px 0 2px; }

.drawer-footer { display: flex; justify-content: flex-end; gap: 8px; }
</style>
