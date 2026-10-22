<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import type { TableColumnType } from 'ant-design-vue'
import { StarFilled } from '@ant-design/icons-vue'
import { dashboardApi, type CanonicalUnit, type NormalizationHealth, type NormalizationIssue, type UnitSuggestion } from '@/api/dashboard'

const props = defineProps<{
  open: boolean
  data: NormalizationHealth | null
}>()

const emit = defineEmits<{ 'update:open': [val: boolean]; resolved: [] }>()

const unknownUnitColumns: TableColumnType<NormalizationIssue>[] = [
  { title: 'Unit', dataIndex: 'label', key: 'label', ellipsis: true },
  { title: 'Protocol', key: 'protocol', width: 110 },
  { title: 'Count', dataIndex: 'count', key: 'count', width: 80, align: 'right' },
  { title: 'First seen', key: 'firstSeen', width: 150 },
  { title: 'Last seen', key: 'lastSeen', width: 150 },
  { title: 'Actions', key: 'actions', width: 90 },
]

const conversionFailureColumns: TableColumnType<NormalizationIssue>[] = [
  { title: 'Conversion', dataIndex: 'label', key: 'label', ellipsis: true },
  { title: 'Protocol', key: 'protocol', width: 110 },
  { title: 'Count', dataIndex: 'count', key: 'count', width: 80, align: 'right' },
  { title: 'First seen', key: 'firstSeen', width: 150 },
  { title: 'Last seen', key: 'lastSeen', width: 150 },
]

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString()
}

// Canonical units for the Resolve picker — fetched once, the first time the
// drawer is opened (not on every open, and not for the conversion-failures
// tab, which has no resolve action in v1).
const canonicalUnits = ref<CanonicalUnit[]>([])
const canonicalUnitsLoaded = ref(false)
const canonicalUnitOptions = computed(() =>
  canonicalUnits.value.map((u) => ({
    value: u.canonical_unit,
    label: u.symbol ? `${u.canonical_unit} (${u.symbol})` : u.canonical_unit,
  })),
)

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen && !canonicalUnitsLoaded.value) {
      dashboardApi
        .getCanonicalUnits()
        .then((units) => {
          canonicalUnits.value = units
          canonicalUnitsLoaded.value = true
        })
        .catch(() => {
          /* the Resolve picker will just show no options; not fatal */
        })
    }
  },
)

const isNewUnit = computed(() => {
  const v = selectedCanonicalUnit.value.trim()
  return v !== '' && !canonicalUnits.value.some((u) => u.canonical_unit === v)
})

const resolveModalOpen = ref(false)
const resolveTarget = ref<NormalizationIssue | null>(null)
const selectedCanonicalUnit = ref('')
const resolving = ref(false)

const suggestions = ref<UnitSuggestion[]>([])
const suggestionsLoading = ref(false)
const selectedSuggestion = ref<string | null>(null)

function selectSuggestion(canonicalUnit: string): void {
  selectedSuggestion.value = canonicalUnit
  selectedCanonicalUnit.value = canonicalUnit
}

function onAutocompleteChange(value: string): void {
  selectedCanonicalUnit.value = value
  if (value !== selectedSuggestion.value) {
    selectedSuggestion.value = null
  }
}

function openResolve(record: NormalizationIssue): void {
  resolveTarget.value = record
  selectedCanonicalUnit.value = ''
  selectedSuggestion.value = null
  suggestions.value = []
  resolveModalOpen.value = true

  suggestionsLoading.value = true
  dashboardApi
    .suggestUnits(record.label, record.protocol)
    .then((results) => { suggestions.value = results })
    .catch(() => { /* non-fatal — manual picker still works */ })
    .finally(() => { suggestionsLoading.value = false })
}

function closeResolve(): void {
  resolveModalOpen.value = false
  resolveTarget.value = null
}

async function submitResolve(): Promise<void> {
  if (!resolveTarget.value || !selectedCanonicalUnit.value) return
  resolving.value = true
  try {
    await dashboardApi.resolveUnknownUnit(resolveTarget.value.label, resolveTarget.value.protocol, selectedCanonicalUnit.value)
    message.success(`"${resolveTarget.value.label}" now maps to ${selectedCanonicalUnit.value}`)
    closeResolve()
    emit('resolved')
  } catch (err: any) {
    message.error(err?.message ?? 'Failed to resolve unit')
  } finally {
    resolving.value = false
  }
}
</script>

<template>
  <a-drawer
    :open="open"
    title="Normalization Health — Details"
    width="760"
    @close="emit('update:open', false)"
  >
    <a-tabs>
      <a-tab-pane key="unknown-units" :tab="`Unknown Units (${data?.unknownUnits.count ?? 0})`">
        <a-table
          :columns="unknownUnitColumns"
          :data-source="data?.unknownUnits.items ?? []"
          :pagination="{ pageSize: 20, size: 'small' }"
          row-key="label"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'protocol'">
              <span style="font-size:12px; color:var(--text-tertiary)">{{ record.protocol ?? '—' }}</span>
            </template>
            <template v-else-if="column.key === 'firstSeen'">
              <span style="font-size:11px; color:var(--text-muted)">{{ fmtDate(record.firstSeen) }}</span>
            </template>
            <template v-else-if="column.key === 'lastSeen'">
              <span style="font-size:11px; color:var(--text-muted)">{{ fmtDate(record.lastSeen) }}</span>
            </template>
            <template v-else-if="column.key === 'actions'">
              <a-button type="link" size="small" @click="openResolve(record)">Resolve</a-button>
            </template>
          </template>
          <template #emptyText>
            <div style="padding: 32px 0; text-align: center; color: var(--text-tertiary)">
              No unknown units observed since the agent last started.
            </div>
          </template>
        </a-table>
      </a-tab-pane>

      <a-tab-pane key="conversion-failures" :tab="`Conversion Failures (${data?.conversionFailures.count ?? 0})`">
        <a-table
          :columns="conversionFailureColumns"
          :data-source="data?.conversionFailures.items ?? []"
          :pagination="{ pageSize: 20, size: 'small' }"
          row-key="label"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'protocol'">
              <span style="font-size:12px; color:var(--text-tertiary)">{{ record.protocol ?? '—' }}</span>
            </template>
            <template v-else-if="column.key === 'firstSeen'">
              <span style="font-size:11px; color:var(--text-muted)">{{ fmtDate(record.firstSeen) }}</span>
            </template>
            <template v-else-if="column.key === 'lastSeen'">
              <span style="font-size:11px; color:var(--text-muted)">{{ fmtDate(record.lastSeen) }}</span>
            </template>
          </template>
          <template #emptyText>
            <div style="padding: 32px 0; text-align: center; color: var(--text-tertiary)">
              No conversion failures observed since the agent last started.
            </div>
          </template>
        </a-table>
      </a-tab-pane>
    </a-tabs>
  </a-drawer>

  <a-modal
    :open="resolveModalOpen"
    title="Resolve unit"
    :confirm-loading="resolving"
    ok-text="Save mapping"
    :ok-button-props="{ disabled: !selectedCanonicalUnit }"
    @ok="submitResolve"
    @cancel="closeResolve"
  >
    <p style="margin-bottom: 16px; color: var(--text-tertiary)">
      Map this raw unit to an existing canonical unit. Future readings using it will normalize automatically.
    </p>
    <div style="margin-bottom: 12px">
      <div style="font-size: 12px; color: var(--text-tertiary)">Raw unit</div>
      <div><code>{{ resolveTarget?.label }}</code></div>
    </div>
    <div style="margin-bottom: 16px">
      <div style="font-size: 12px; color: var(--text-tertiary)">Protocol</div>
      <div>{{ resolveTarget?.protocol ?? '— (global)' }}</div>
    </div>

    <div v-if="suggestionsLoading" style="text-align: center; padding: 12px 0">
      <a-spin size="small" />
      <span style="margin-left: 8px; font-size: 12px; color: var(--text-tertiary)">Finding suggestions…</span>
    </div>
    <div v-else-if="suggestions.length > 0" style="margin-bottom: 16px">
      <div style="font-size: 12px; color: var(--text-tertiary); margin-bottom: 8px">Suggestions</div>
      <div class="suggestion-list">
        <div
          v-for="(s, idx) in suggestions"
          :key="s.canonical_unit"
          class="suggestion-item"
          :class="{ 'suggestion-item--selected': selectedSuggestion === s.canonical_unit, 'suggestion-item--top': idx === 0 }"
          @click="selectSuggestion(s.canonical_unit)"
        >
          <a-radio :checked="selectedSuggestion === s.canonical_unit" style="pointer-events: none" />
          <div style="flex: 1; min-width: 0">
            <span style="font-weight: 500">{{ s.canonical_unit }}</span>
            <span v-if="s.symbol" style="color: var(--text-tertiary); margin-left: 4px">({{ s.symbol }})</span>
            <span style="color: var(--text-muted); margin-left: 8px; font-size: 12px">{{ s.quantity }}</span>
          </div>
          <StarFilled v-if="idx === 0" style="color: #faad14; font-size: 12px; flex-shrink: 0" />
          <span style="font-size: 11px; color: var(--text-muted); flex-shrink: 0; min-width: 24px; text-align: right">{{ s.score }}</span>
        </div>
      </div>
    </div>
    <div v-else-if="!suggestionsLoading" style="margin-bottom: 16px; font-size: 12px; color: var(--text-muted)">
      No close matches found. Use the picker below.
    </div>

    <a-divider v-if="suggestions.length > 0" style="margin: 8px 0 12px">
      <span style="font-size: 11px; color: var(--text-muted)">or pick manually</span>
    </a-divider>

    <div>
      <div style="font-size: 12px; color: var(--text-tertiary); margin-bottom: 4px">Canonical unit</div>
      <a-auto-complete
        :value="selectedCanonicalUnit"
        placeholder="Select or type a canonical unit"
        style="width: 100%"
        :options="canonicalUnitOptions"
        :filter-option="(input: string, option: any) => option.label.toLowerCase().includes(input.toLowerCase())"
        @change="onAutocompleteChange"
      />
      <div v-if="isNewUnit" style="font-size: 12px; color: #faad14; margin-top: 4px">
        New unit — will be created as a passthrough (no conversion)
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.suggestion-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.suggestion-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s;
}

.suggestion-item:hover {
  background: var(--bg-hover);
}

.suggestion-item--selected {
  border-color: #1677ff;
  background: var(--bg-selected-light);
}

.suggestion-item--top {
  border-color: var(--border-color-strong);
}

.suggestion-item--top.suggestion-item--selected {
  border-color: #1677ff;
}
</style>
