<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { message } from 'ant-design-vue'
import type { FormInstance } from 'ant-design-vue'
import type { MaintenanceRule, MaintenanceRuleFormData, MaintenanceRuleType, Asset } from '@/types'
import { maintenanceApi } from '@/api/maintenance'
import { assetsApi } from '@/api/assets'

const RULE_TYPES: { value: MaintenanceRuleType; label: string }[] = [
  { value: 'cumulative_runtime', label: 'Cumulative runtime' },
  { value: 'cycle_count', label: 'Cycle count' },
  { value: 'threshold_duration', label: 'Threshold duration' },
]

const props = defineProps<{
  open: boolean
  editing: MaintenanceRule | null
}>()

const emit = defineEmits<{
  'update:open': [val: boolean]
  saved: []
}>()

const formRef = ref<FormInstance>()
const saving = ref(false)
const assets = ref<Asset[]>([])

const blankForm = (): MaintenanceRuleFormData => ({
  asset_uuid: '',
  component: '',
  rule_type: 'cumulative_runtime',
  enabled: true,
  config: { metric: '', thresholdHours: 5000 },
})

const form = ref<MaintenanceRuleFormData>(blankForm())

// ── Per-rule_type config editors ────────────────────────────────────────────
interface CumulativeRuntimeForm { metric: string; thresholdHours: number | null; gatingMetric: string; gatingMin: number | null; gatingMax: number | null }
interface CycleCountForm { metric: string; thresholdCycles: number | null }
interface ThresholdDurationForm {
  metric: string; threshold: number | null; comparator: 'gt' | 'lt'; sustainedForMinutes: number | null
  consecutiveWindowsRequired: number | null; gatingMetric: string; gatingMin: number | null; gatingMax: number | null
}

const cumulativeRuntime = ref<CumulativeRuntimeForm>({ metric: '', thresholdHours: null, gatingMetric: '', gatingMin: null, gatingMax: null })
const cycleCount = ref<CycleCountForm>({ metric: '', thresholdCycles: null })
const thresholdDuration = ref<ThresholdDurationForm>({
  metric: '', threshold: null, comparator: 'gt', sustainedForMinutes: null,
  consecutiveWindowsRequired: 1, gatingMetric: '', gatingMin: null, gatingMax: null,
})

function resetConfigForms(): void {
  cumulativeRuntime.value = { metric: '', thresholdHours: null, gatingMetric: '', gatingMin: null, gatingMax: null }
  cycleCount.value = { metric: '', thresholdCycles: null }
  thresholdDuration.value = { metric: '', threshold: null, comparator: 'gt', sustainedForMinutes: null, consecutiveWindowsRequired: 1, gatingMetric: '', gatingMin: null, gatingMax: null }
}

function parseConfigInto(ruleType: MaintenanceRuleType, config: Record<string, any>): void {
  if (ruleType === 'cumulative_runtime') {
    cumulativeRuntime.value = {
      metric: config.metric ?? '',
      thresholdHours: config.thresholdHours ?? null,
      gatingMetric: config.windowGating?.metric ?? '',
      gatingMin: config.windowGating?.min ?? null,
      gatingMax: config.windowGating?.max ?? null,
    }
  } else if (ruleType === 'cycle_count') {
    cycleCount.value = { metric: config.metric ?? '', thresholdCycles: config.thresholdCycles ?? null }
  } else if (ruleType === 'threshold_duration') {
    thresholdDuration.value = {
      metric: config.metric ?? '',
      threshold: config.threshold ?? null,
      comparator: config.comparator ?? 'gt',
      sustainedForMinutes: config.sustainedForMs ? config.sustainedForMs / 60_000 : null,
      consecutiveWindowsRequired: config.consecutiveWindowsRequired ?? 1,
      gatingMetric: config.windowGating?.metric ?? '',
      gatingMin: config.windowGating?.min ?? null,
      gatingMax: config.windowGating?.max ?? null,
    }
  }
}

function buildWindowGating(metric: string, min: number | null, max: number | null): Record<string, any> | undefined {
  if (!metric.trim()) return undefined
  const gating: Record<string, any> = { metric: metric.trim() }
  if (min !== null) gating.min = min
  if (max !== null) gating.max = max
  return gating
}

function buildConfig(): Record<string, any> {
  if (form.value.rule_type === 'cumulative_runtime') {
    const c = cumulativeRuntime.value
    return {
      metric: c.metric.trim(),
      thresholdHours: c.thresholdHours ?? 0,
      ...(buildWindowGating(c.gatingMetric, c.gatingMin, c.gatingMax) && { windowGating: buildWindowGating(c.gatingMetric, c.gatingMin, c.gatingMax) }),
    }
  }
  if (form.value.rule_type === 'cycle_count') {
    const c = cycleCount.value
    return { metric: c.metric.trim(), thresholdCycles: c.thresholdCycles ?? 0 }
  }
  const t = thresholdDuration.value
  return {
    metric: t.metric.trim(),
    threshold: t.threshold ?? 0,
    comparator: t.comparator,
    sustainedForMs: (t.sustainedForMinutes ?? 0) * 60_000,
    consecutiveWindowsRequired: t.consecutiveWindowsRequired ?? 1,
    ...(buildWindowGating(t.gatingMetric, t.gatingMin, t.gatingMax) && { windowGating: buildWindowGating(t.gatingMetric, t.gatingMin, t.gatingMax) }),
  }
}

// flush: 'sync' so config fields are cleared before parseConfigInto repopulates them on edit.
watch(() => form.value.rule_type, () => { resetConfigForms() }, { flush: 'sync' })

watch(
  () => props.open,
  (open) => {
    if (!open) return
    if (props.editing) {
      form.value = {
        asset_uuid: props.editing.asset_uuid ?? '',
        component: props.editing.component,
        rule_type: props.editing.rule_type,
        enabled: props.editing.enabled,
        config: props.editing.config,
      }
      parseConfigInto(props.editing.rule_type, props.editing.config)
    } else {
      form.value = blankForm()
      resetConfigForms()
    }
  },
)

async function loadAssets() {
  try {
    assets.value = await assetsApi.getAll()
  } catch {
    // non-fatal
  }
}

// Metric fields are populated from the selected asset's own metric bindings
// (Assets page) rather than free text — a typo here means the rule silently
// never fires, since the evaluator only resolves rule.config.metric via the
// asset's asset_metrics bindings.
const availableMetricOptions = computed(() => {
  const asset = assets.value.find((a) => a.uuid === form.value.asset_uuid)
  const names = [...new Set((asset?.metrics ?? []).map((m) => m.metric))]
  return names.map((name) => ({ value: name }))
})

const selectedAssetHasNoMetrics = computed(() => !!form.value.asset_uuid && availableMetricOptions.value.length === 0)

async function submit() {
  await formRef.value?.validate()
  saving.value = true
  try {
    const payload: MaintenanceRuleFormData = { ...form.value, config: buildConfig() as any }
    if (props.editing) {
      await maintenanceApi.updateRule(props.editing.id, payload)
      message.success('Rule updated')
    } else {
      await maintenanceApi.createRule(payload)
      message.success('Rule created')
    }
    emit('update:open', false)
    emit('saved')
  } catch (err: unknown) {
    const e = err as { message?: string }
    message.error(e?.message ?? 'Save failed')
  } finally {
    saving.value = false
  }
}

function close() {
  emit('update:open', false)
}

onMounted(loadAssets)
</script>

<template>
  <a-drawer
    :open="open"
    :title="editing ? 'Edit Maintenance Rule' : 'New Maintenance Rule'"
    width="520"
    @close="close"
  >
    <a-form ref="formRef" :model="form" layout="vertical">
      <a-form-item label="Asset" name="asset_uuid" :rules="[{ required: true, message: 'Asset is required' }]">
        <a-select v-model:value="form.asset_uuid" show-search placeholder="Select an asset" :filter-option="(input: string, option: any) => option.label.toLowerCase().includes(input.toLowerCase())">
          <a-select-option v-for="a in assets" :key="a.uuid" :value="a.uuid" :label="a.name">{{ a.name }}</a-select-option>
        </a-select>
      </a-form-item>

      <a-alert
        v-if="selectedAssetHasNoMetrics"
        type="warning"
        show-icon
        message="No metrics bound to this asset yet"
        description="Go to Assets → edit this asset → bind a metric first, or type the metric name here manually."
        style="margin-bottom: 16px; font-size: 12px"
      />

      <a-form-item label="Component" name="component" extra="The sub-part this rule watches, e.g. &quot;Bearing-1&quot;." :rules="[{ required: true, message: 'Component is required' }]">
        <a-input v-model:value="form.component" placeholder="e.g. Bearing-1" />
      </a-form-item>

      <a-row :gutter="16">
        <a-col :span="12">
          <a-form-item label="Rule type" name="rule_type">
            <a-select v-model:value="form.rule_type">
              <a-select-option v-for="rt in RULE_TYPES" :key="rt.value" :value="rt.value">{{ rt.label }}</a-select-option>
            </a-select>
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item label="Enabled" name="enabled">
            <a-switch v-model:checked="form.enabled" />
          </a-form-item>
        </a-col>
      </a-row>

      <a-divider orientation="left" style="font-size: 13px; color: #888">Rule config</a-divider>

      <!-- Cumulative runtime -->
      <template v-if="form.rule_type === 'cumulative_runtime'">
        <a-form-item label="Metric" extra="A monotonically increasing counter bound to this asset, e.g. &quot;runtime_hours&quot;.">
          <a-auto-complete v-model:value="cumulativeRuntime.metric" :options="availableMetricOptions" :filter-option="false" allow-clear placeholder="runtime_hours" style="width: 100%" />
        </a-form-item>
        <a-form-item label="Threshold (hours)" extra="Fires once the counter crosses this value.">
          <a-input-number v-model:value="cumulativeRuntime.thresholdHours" :min="0" style="width: 100%" placeholder="5000" />
        </a-form-item>
        <a-divider orientation="left" style="font-size: 12px; color: #aaa">Gating (optional)</a-divider>
        <a-row :gutter="12">
          <a-col :span="10"><a-form-item label="Gating metric"><a-auto-complete v-model:value="cumulativeRuntime.gatingMetric" :options="availableMetricOptions" :filter-option="false" allow-clear placeholder="e.g. temperature" style="width: 100%" /></a-form-item></a-col>
          <a-col :span="7"><a-form-item label="Min"><a-input-number v-model:value="cumulativeRuntime.gatingMin" style="width: 100%" /></a-form-item></a-col>
          <a-col :span="7"><a-form-item label="Max"><a-input-number v-model:value="cumulativeRuntime.gatingMax" style="width: 100%" /></a-form-item></a-col>
        </a-row>
      </template>

      <!-- Cycle count -->
      <template v-else-if="form.rule_type === 'cycle_count'">
        <a-form-item label="Metric" extra="A monotonically increasing counter bound to this asset, e.g. &quot;start_stop_count&quot;.">
          <a-auto-complete v-model:value="cycleCount.metric" :options="availableMetricOptions" :filter-option="false" allow-clear placeholder="start_stop_count" style="width: 100%" />
        </a-form-item>
        <a-form-item label="Threshold (cycles)">
          <a-input-number v-model:value="cycleCount.thresholdCycles" :min="0" style="width: 100%" placeholder="100" />
        </a-form-item>
      </template>

      <!-- Threshold duration -->
      <template v-else-if="form.rule_type === 'threshold_duration'">
        <a-form-item label="Metric" extra="Bound to this asset, e.g. &quot;vibration_rms&quot;.">
          <a-auto-complete v-model:value="thresholdDuration.metric" :options="availableMetricOptions" :filter-option="false" allow-clear placeholder="vibration_rms" style="width: 100%" />
        </a-form-item>
        <a-row :gutter="12">
          <a-col :span="12">
            <a-form-item label="Comparator">
              <a-select v-model:value="thresholdDuration.comparator">
                <a-select-option value="gt">Above (&gt;)</a-select-option>
                <a-select-option value="lt">Below (&lt;)</a-select-option>
              </a-select>
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="Threshold">
              <a-input-number v-model:value="thresholdDuration.threshold" style="width: 100%" />
            </a-form-item>
          </a-col>
        </a-row>
        <a-row :gutter="12">
          <a-col :span="12">
            <a-form-item label="Sustained for (minutes)" extra="Must stay past threshold this long.">
              <a-input-number v-model:value="thresholdDuration.sustainedForMinutes" :min="0" style="width: 100%" />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="Consecutive windows" extra="Debounce — hits in a row before firing.">
              <a-input-number v-model:value="thresholdDuration.consecutiveWindowsRequired" :min="1" style="width: 100%" />
            </a-form-item>
          </a-col>
        </a-row>
        <a-divider orientation="left" style="font-size: 12px; color: #aaa">Gating (optional)</a-divider>
        <a-row :gutter="12">
          <a-col :span="10"><a-form-item label="Gating metric"><a-auto-complete v-model:value="thresholdDuration.gatingMetric" :options="availableMetricOptions" :filter-option="false" allow-clear placeholder="e.g. temperature" style="width: 100%" /></a-form-item></a-col>
          <a-col :span="7"><a-form-item label="Min"><a-input-number v-model:value="thresholdDuration.gatingMin" style="width: 100%" /></a-form-item></a-col>
          <a-col :span="7"><a-form-item label="Max"><a-input-number v-model:value="thresholdDuration.gatingMax" style="width: 100%" /></a-form-item></a-col>
        </a-row>
      </template>
    </a-form>

    <template #footer>
      <a-space>
        <a-button @click="close">Cancel</a-button>
        <a-button type="primary" :loading="saving" @click="submit">
          {{ editing ? 'Save' : 'Create' }}
        </a-button>
      </a-space>
    </template>
  </a-drawer>
</template>
