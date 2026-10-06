<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import type { TableColumnType } from 'ant-design-vue'
import { dashboardApi, type CanonicalUnit, type NormalizationHealth, type NormalizationIssue } from '@/api/dashboard'

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

const resolveModalOpen = ref(false)
const resolveTarget = ref<NormalizationIssue | null>(null)
const selectedCanonicalUnit = ref<string | undefined>(undefined)
const resolving = ref(false)

function openResolve(record: NormalizationIssue): void {
  resolveTarget.value = record
  selectedCanonicalUnit.value = undefined
  resolveModalOpen.value = true
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
              <span style="font-size:12px; color:#888">{{ record.protocol ?? '—' }}</span>
            </template>
            <template v-else-if="column.key === 'firstSeen'">
              <span style="font-size:11px; color:#aaa">{{ fmtDate(record.firstSeen) }}</span>
            </template>
            <template v-else-if="column.key === 'lastSeen'">
              <span style="font-size:11px; color:#aaa">{{ fmtDate(record.lastSeen) }}</span>
            </template>
            <template v-else-if="column.key === 'actions'">
              <a-button type="link" size="small" @click="openResolve(record)">Resolve</a-button>
            </template>
          </template>
          <template #emptyText>
            <div style="padding: 32px 0; text-align: center; color: #888">
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
              <span style="font-size:12px; color:#888">{{ record.protocol ?? '—' }}</span>
            </template>
            <template v-else-if="column.key === 'firstSeen'">
              <span style="font-size:11px; color:#aaa">{{ fmtDate(record.firstSeen) }}</span>
            </template>
            <template v-else-if="column.key === 'lastSeen'">
              <span style="font-size:11px; color:#aaa">{{ fmtDate(record.lastSeen) }}</span>
            </template>
          </template>
          <template #emptyText>
            <div style="padding: 32px 0; text-align: center; color: #888">
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
    <p style="margin-bottom: 16px; color: #888">
      Map this raw unit to an existing canonical unit. Future readings using it will normalize automatically.
    </p>
    <div style="margin-bottom: 12px">
      <div style="font-size: 12px; color: #888">Raw unit</div>
      <div><code>{{ resolveTarget?.label }}</code></div>
    </div>
    <div style="margin-bottom: 16px">
      <div style="font-size: 12px; color: #888">Protocol</div>
      <div>{{ resolveTarget?.protocol ?? '— (global)' }}</div>
    </div>
    <div>
      <div style="font-size: 12px; color: #888; margin-bottom: 4px">Canonical unit</div>
      <a-select
        v-model:value="selectedCanonicalUnit"
        show-search
        placeholder="Select a canonical unit"
        style="width: 100%"
        :options="canonicalUnitOptions"
        :filter-option="(input: string, option: any) => option.label.toLowerCase().includes(input.toLowerCase())"
      />
    </div>
  </a-modal>
</template>
