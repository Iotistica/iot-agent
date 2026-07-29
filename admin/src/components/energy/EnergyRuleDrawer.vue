<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { message } from 'ant-design-vue'
import type { FormInstance } from 'ant-design-vue'
import type { EnergyRule, EnergyRuleFormData, EnergyRuleType, Asset } from '@/types'
import { energyApi } from '@/api/energy'
import { assetsApi } from '@/api/assets'

const RULE_TYPES: { value: EnergyRuleType; label: string }[] = [
  { value: 'standby_waste', label: 'Standby waste' },
  { value: 'schedule_mismatch', label: 'Schedule mismatch' },
  { value: 'duty_cycle', label: 'Duty cycle' },
]

const DAYS = [
  { value: 0, label: 'Sun' }, { value: 1, label: 'Mon' }, { value: 2, label: 'Tue' }, { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' }, { value: 5, label: 'Fri' }, { value: 6, label: 'Sat' },
]

const props = defineProps<{
  open: boolean
  editing: EnergyRule | null
}>()

const emit = defineEmits<{
  'update:open': [val: boolean]
  saved: []
}>()

const formRef = ref<FormInstance>()
const saving = ref(false)
const assets = ref<Asset[]>([])

const blankForm = (): EnergyRuleFormData => ({
  asset_uuid: '',
  metric: '',
  rule_type: 'standby_waste',
  enabled: true,
  config: { metric: '', standbyThreshold: 50, outsideScheduleOnly: false },
})

const form = ref<EnergyRuleFormData>(blankForm())

// ── Per-rule_type config editors ────────────────────────────────────────────
interface StandbyWasteForm { standbyThreshold: number | null; outsideScheduleOnly: boolean; start: string; end: string; days: number[] }
interface ScheduleMismatchForm { start: string; end: string; days: number[]; toleranceMinutes: number | null }
interface DutyCycleForm { windowMinutes: number | null; expectedMinRatio: number | null; expectedMaxRatio: number | null }

const standbyWaste = ref<StandbyWasteForm>({ standbyThreshold: null, outsideScheduleOnly: false, start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5] })
const scheduleMismatch = ref<ScheduleMismatchForm>({ start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5], toleranceMinutes: 15 })
const dutyCycle = ref<DutyCycleForm>({ windowMinutes: 60, expectedMinRatio: null, expectedMaxRatio: null })

function resetConfigForms(): void {
  standbyWaste.value = { standbyThreshold: null, outsideScheduleOnly: false, start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5] }
  scheduleMismatch.value = { start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5], toleranceMinutes: 15 }
  dutyCycle.value = { windowMinutes: 60, expectedMinRatio: null, expectedMaxRatio: null }
}

function parseConfigInto(ruleType: EnergyRuleType, config: Record<string, any>): void {
  if (ruleType === 'standby_waste') {
    standbyWaste.value = {
      standbyThreshold: config.standbyThreshold ?? null,
      outsideScheduleOnly: config.outsideScheduleOnly ?? false,
      start: config.schedule?.start ?? '08:00',
      end: config.schedule?.end ?? '18:00',
      days: config.schedule?.days ?? [1, 2, 3, 4, 5],
    }
  } else if (ruleType === 'schedule_mismatch') {
    scheduleMismatch.value = {
      start: config.expectedSchedule?.start ?? '08:00',
      end: config.expectedSchedule?.end ?? '18:00',
      days: config.expectedSchedule?.days ?? [1, 2, 3, 4, 5],
      toleranceMinutes: config.toleranceMinutes ?? 15,
    }
  } else if (ruleType === 'duty_cycle') {
    dutyCycle.value = {
      windowMinutes: config.windowMs ? config.windowMs / 60_000 : 60,
      expectedMinRatio: config.expectedMinRatio != null ? config.expectedMinRatio * 100 : null,
      expectedMaxRatio: config.expectedMaxRatio != null ? config.expectedMaxRatio * 100 : null,
    }
  }
}

function buildConfig(): Record<string, any> {
  const metric = form.value.metric.trim()
  if (form.value.rule_type === 'standby_waste') {
    const s = standbyWaste.value
    return {
      metric,
      standbyThreshold: s.standbyThreshold ?? 0,
      outsideScheduleOnly: s.outsideScheduleOnly,
      ...(s.outsideScheduleOnly && { schedule: { start: s.start, end: s.end, days: s.days } }),
    }
  }
  if (form.value.rule_type === 'schedule_mismatch') {
    const s = scheduleMismatch.value
    return {
      metric,
      expectedSchedule: { start: s.start, end: s.end, days: s.days },
      toleranceMinutes: s.toleranceMinutes ?? 0,
    }
  }
  const d = dutyCycle.value
  return {
    metric,
    windowMs: (d.windowMinutes ?? 60) * 60_000,
    ...(d.expectedMinRatio != null && { expectedMinRatio: d.expectedMinRatio / 100 }),
    ...(d.expectedMaxRatio != null && { expectedMaxRatio: d.expectedMaxRatio / 100 }),
  }
}

watch(() => form.value.rule_type, () => { resetConfigForms() }, { flush: 'sync' })

watch(
  () => props.open,
  (open) => {
    if (!open) return
    if (props.editing) {
      form.value = {
        asset_uuid: props.editing.asset_uuid ?? '',
        metric: props.editing.metric,
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

// Metric field is populated from the selected asset's own metric bindings
// (Assets page) rather than free text — a typo here means the rule silently
// never fires, since the evaluator only resolves rule.metric via the asset's
// asset_metrics bindings.
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
    const payload: EnergyRuleFormData = { ...form.value, config: buildConfig() as any }
    if (props.editing) {
      await energyApi.updateRule(props.editing.id, payload)
      message.success('Rule updated')
    } else {
      await energyApi.createRule(payload)
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
    :title="editing ? 'Edit Energy Rule' : 'New Energy Rule'"
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

      <a-row :gutter="16">
        <a-col :span="12">
          <a-form-item label="Metric" name="metric" extra="Bound to this asset, e.g. &quot;power_draw_w&quot;." :rules="[{ required: true, message: 'Metric is required' }]">
            <a-auto-complete v-model:value="form.metric" :options="availableMetricOptions" :filter-option="false" allow-clear placeholder="power_draw_w" style="width: 100%" />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item label="Rule type" name="rule_type">
            <a-select v-model:value="form.rule_type">
              <a-select-option v-for="rt in RULE_TYPES" :key="rt.value" :value="rt.value">{{ rt.label }}</a-select-option>
            </a-select>
          </a-form-item>
        </a-col>
      </a-row>

      <a-form-item label="Enabled" name="enabled">
        <a-switch v-model:checked="form.enabled" />
      </a-form-item>

      <a-divider orientation="left" style="font-size: 13px; color: #888">Rule config</a-divider>

      <!-- Standby waste -->
      <template v-if="form.rule_type === 'standby_waste'">
        <a-form-item label="Standby threshold" extra="Below this reading is considered idle draw.">
          <a-input-number v-model:value="standbyWaste.standbyThreshold" :min="0" style="width: 100%" placeholder="50" />
        </a-form-item>
        <a-form-item label="Only flag outside operating hours">
          <a-switch v-model:checked="standbyWaste.outsideScheduleOnly" />
        </a-form-item>
        <template v-if="standbyWaste.outsideScheduleOnly">
          <a-row :gutter="12">
            <a-col :span="12"><a-form-item label="Start"><a-input v-model:value="standbyWaste.start" placeholder="08:00" /></a-form-item></a-col>
            <a-col :span="12"><a-form-item label="End"><a-input v-model:value="standbyWaste.end" placeholder="18:00" /></a-form-item></a-col>
          </a-row>
          <a-form-item label="Operating days">
            <a-select v-model:value="standbyWaste.days" mode="multiple">
              <a-select-option v-for="d in DAYS" :key="d.value" :value="d.value">{{ d.label }}</a-select-option>
            </a-select>
          </a-form-item>
        </template>
      </template>

      <!-- Schedule mismatch -->
      <template v-else-if="form.rule_type === 'schedule_mismatch'">
        <a-row :gutter="12">
          <a-col :span="12"><a-form-item label="Expected start"><a-input v-model:value="scheduleMismatch.start" placeholder="08:00" /></a-form-item></a-col>
          <a-col :span="12"><a-form-item label="Expected end"><a-input v-model:value="scheduleMismatch.end" placeholder="18:00" /></a-form-item></a-col>
        </a-row>
        <a-form-item label="Expected days">
          <a-select v-model:value="scheduleMismatch.days" mode="multiple">
            <a-select-option v-for="d in DAYS" :key="d.value" :value="d.value">{{ d.label }}</a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="Tolerance (minutes)" extra="Slack around start/end to avoid flagging normal startup lag.">
          <a-input-number v-model:value="scheduleMismatch.toleranceMinutes" :min="0" style="width: 100%" />
        </a-form-item>
      </template>

      <!-- Duty cycle -->
      <template v-else-if="form.rule_type === 'duty_cycle'">
        <a-form-item label="Window (minutes)" extra="Rolling window to compute the on/off ratio over.">
          <a-input-number v-model:value="dutyCycle.windowMinutes" :min="1" style="width: 100%" />
        </a-form-item>
        <a-row :gutter="12">
          <a-col :span="12"><a-form-item label="Min expected on-time (%)"><a-input-number v-model:value="dutyCycle.expectedMinRatio" :min="0" :max="100" style="width: 100%" /></a-form-item></a-col>
          <a-col :span="12"><a-form-item label="Max expected on-time (%)"><a-input-number v-model:value="dutyCycle.expectedMaxRatio" :min="0" :max="100" style="width: 100%" /></a-form-item></a-col>
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
