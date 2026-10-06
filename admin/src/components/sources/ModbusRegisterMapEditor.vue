<script setup lang="ts">
import { ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { PlusOutlined, DeleteOutlined, ThunderboltOutlined, ImportOutlined } from '@ant-design/icons-vue'
import { sourcesApi, type SourceTestRegisterResult } from '@/api/sources'

const props = defineProps<{
  modelValue: any[] | undefined
  connection: Record<string, unknown>
}>()

const emit = defineEmits<{
  'update:modelValue': [val: any[]]
}>()

interface RegisterRow {
  key: string
  address: number
  type: 'coil' | 'discrete' | 'holding' | 'input'
  dataType: string
  name: string
  unit: string
}

const FUNCTION_CODE_TO_TYPE: Record<number, RegisterRow['type']> = {
  1: 'coil',
  2: 'discrete',
  3: 'holding',
  4: 'input',
}

const TYPE_OPTIONS = [
  { value: 'holding', label: 'Holding Register' },
  { value: 'input', label: 'Input Register' },
  { value: 'coil', label: 'Coil' },
  { value: 'discrete', label: 'Discrete Input' },
]

const DATA_TYPE_OPTIONS = [
  { value: 'uint16', label: 'uint16' },
  { value: 'int16', label: 'int16' },
  { value: 'uint32', label: 'uint32' },
  { value: 'int32', label: 'int32' },
  { value: 'float32', label: 'float32' },
  { value: 'boolean', label: 'boolean' },
  { value: 'string', label: 'string' },
]

function makeKey() {
  return Math.random().toString(36).slice(2)
}

function toRow(dp: any): RegisterRow {
  return {
    key: makeKey(),
    address: typeof dp.address === 'number' ? dp.address : 0,
    type: dp.type ?? FUNCTION_CODE_TO_TYPE[dp.functionCode] ?? 'holding',
    dataType: dp.dataType ?? 'uint16',
    name: dp.name ?? '',
    unit: dp.unit ?? '',
  }
}

function fromRow(row: RegisterRow): Record<string, unknown> {
  return {
    name: row.name,
    address: row.address,
    type: row.type,
    dataType: row.dataType,
    unit: row.unit || undefined,
  }
}

const rows = ref<RegisterRow[]>((props.modelValue ?? []).map(toRow))

watch(
  () => props.modelValue,
  (val, oldVal) => {
    if (val === oldVal) return
    rows.value = (val ?? []).map(toRow)
  },
)

function emitRows() {
  emit('update:modelValue', rows.value.map(fromRow))
}

function addRow() {
  const last = rows.value[rows.value.length - 1]
  rows.value.push({
    key: makeKey(),
    address: last ? last.address + (last.dataType.includes('32') ? 2 : 1) : 0,
    type: last?.type ?? 'holding',
    dataType: last?.dataType ?? 'uint16',
    name: '',
    unit: '',
  })
  emitRows()
}

function removeRow(key: string) {
  rows.value = rows.value.filter((r) => r.key !== key)
  emitRows()
}

const columns = [
  { title: 'Address', dataIndex: 'address', key: 'address', width: 100 },
  { title: 'Register Type', dataIndex: 'type', key: 'type', width: 160 },
  { title: 'Data Type', dataIndex: 'dataType', key: 'dataType', width: 120 },
  { title: 'Name', dataIndex: 'name', key: 'name' },
  { title: 'Unit', dataIndex: 'unit', key: 'unit', width: 90 },
  { title: 'Last Test', key: 'result', width: 140 },
  { title: '', key: 'actions', width: 40 },
]

// ── Test All ─────────────────────────────────────────────────────────────────

const testing = ref(false)
const testError = ref('')
const resultsByName = ref<Record<string, SourceTestRegisterResult>>({})

async function testAll() {
  testError.value = ''
  resultsByName.value = {}
  const registers = rows.value.map(fromRow)
  if (registers.length === 0) {
    testError.value = 'Add at least one register first'
    return
  }
  testing.value = true
  try {
    const result = await sourcesApi.test({ protocol: 'modbus', connection: props.connection ?? {}, registers })
    if (!result.ok && !result.results) {
      testError.value = result.error ?? 'Test failed'
      return
    }
    const byName: Record<string, SourceTestRegisterResult> = {}
    for (const r of result.results ?? []) byName[r.name] = r
    resultsByName.value = byName
  } catch (err: unknown) {
    const e = err as { message?: string }
    testError.value = e?.message ?? 'Test failed'
  } finally {
    testing.value = false
  }
}

// ── CSV import/export ───────────────────────────────────────────────────────

const csvOpen = ref(false)
const csvText = ref('')

function openCsv() {
  csvText.value = ['address,type,dataType,name,unit', ...rows.value.map(fromRow).map((r) =>
    [r.address, r.type, r.dataType, r.name, r.unit ?? ''].join(','),
  )].join('\n')
  csvOpen.value = true
}

function applyCsv() {
  const lines = csvText.value.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length && lines[0].toLowerCase().startsWith('address,')) lines.shift()

  const parsed: RegisterRow[] = []
  for (const line of lines) {
    const [address, type, dataType, name, unit] = line.split(',').map((c) => c.trim())
    if (!name) continue
    parsed.push({
      key: makeKey(),
      address: Number(address) || 0,
      type: (TYPE_OPTIONS.some((o) => o.value === type) ? type : 'holding') as RegisterRow['type'],
      dataType: DATA_TYPE_OPTIONS.some((o) => o.value === dataType) ? dataType : 'uint16',
      name,
      unit: unit ?? '',
    })
  }

  if (parsed.length === 0) {
    message.error('No valid rows found — expected header "address,type,dataType,name,unit"')
    return
  }
  rows.value = parsed
  emitRows()
  csvOpen.value = false
  message.success(`Imported ${parsed.length} register(s)`)
}
</script>

<template>
  <div>
    <div class="toolbar">
      <a-button size="small" @click="addRow">
        <template #icon><PlusOutlined /></template>
        Add Register
      </a-button>
      <a-button size="small" @click="openCsv">
        <template #icon><ImportOutlined /></template>
        Import / Export CSV
      </a-button>
      <a-button size="small" :loading="testing" @click="testAll">
        <template #icon><ThunderboltOutlined /></template>
        Test All
      </a-button>
    </div>

    <a-alert v-if="testError" type="error" :message="testError" show-icon style="margin-bottom: 8px" />

    <a-table
      :columns="columns"
      :data-source="rows"
      :pagination="false"
      row-key="key"
      size="small"
      :scroll="{ y: 320 }"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'address'">
          <a-input-number v-model:value="record.address" :min="0" size="small" style="width: 100%" @change="emitRows" />
        </template>
        <template v-else-if="column.key === 'type'">
          <a-select v-model:value="record.type" size="small" style="width: 100%" @change="emitRows">
            <a-select-option v-for="o in TYPE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</a-select-option>
          </a-select>
        </template>
        <template v-else-if="column.key === 'dataType'">
          <a-select v-model:value="record.dataType" size="small" style="width: 100%" @change="emitRows">
            <a-select-option v-for="o in DATA_TYPE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</a-select-option>
          </a-select>
        </template>
        <template v-else-if="column.key === 'name'">
          <a-input v-model:value="record.name" size="small" placeholder="e.g. voltage_l1" @change="emitRows" />
        </template>
        <template v-else-if="column.key === 'unit'">
          <a-input v-model:value="record.unit" size="small" placeholder="V" @change="emitRows" />
        </template>
        <template v-else-if="column.key === 'result'">
          <span v-if="resultsByName[record.name]" :style="{ color: resultsByName[record.name].quality === 'GOOD' ? '#52c41a' : '#ff4d4f' }">
            {{ resultsByName[record.name].quality === 'GOOD' ? resultsByName[record.name].value : resultsByName[record.name].error }}
          </span>
        </template>
        <template v-else-if="column.key === 'actions'">
          <a-button size="small" danger type="text" @click="removeRow(record.key)">
            <template #icon><DeleteOutlined /></template>
          </a-button>
        </template>
      </template>
      <template #emptyText>
        <div style="padding: 24px 0; text-align: center; color: #888">
          No registers yet. Add one, or paste a CSV via Import / Export.
        </div>
      </template>
    </a-table>

    <a-modal v-model:open="csvOpen" title="Register map CSV" width="560" @ok="applyCsv">
      <p style="margin: 0 0 8px; font-size: 12px; color: #888">
        Header: <code>address,type,dataType,name,unit</code> — edit and click OK to replace the table above with these rows.
      </p>
      <a-textarea v-model:value="csvText" :rows="14" style="font-family: monospace; font-size: 12px" />
    </a-modal>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
</style>
