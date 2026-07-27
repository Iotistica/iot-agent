<script setup lang="ts">
import { QuestionCircleOutlined } from '@ant-design/icons-vue'

// Layout-only wrapper — same a-form-item foundation every field in this
// screen already used individually (no enclosing <a-form>, no validation
// semantics attached), just centralized so label/tooltip/control/helper
// alignment can't drift between fields. Every field reserves the same
// helper-text height whether or not `helper` is set, so neighbouring
// fields in the same grid row stay aligned instead of jumping around
// based on which ones happen to have helper text.
defineProps<{
  label: string
  tooltip?: string
  helper?: string
}>()
</script>

<template>
  <a-form-item class="settings-field" style="margin-bottom: 0">
    <template #label>
      <span class="settings-field__label">
        {{ label }}
        <a-tooltip v-if="tooltip" :title="tooltip">
          <QuestionCircleOutlined class="settings-field__info" />
        </a-tooltip>
      </span>
    </template>
    <div class="settings-field__control">
      <slot />
    </div>
    <div class="settings-field__helper">{{ helper }}</div>
  </a-form-item>
</template>

<style scoped>
.settings-field :deep(.ant-form-item-label) {
  padding-bottom: 6px;
}

.settings-field :deep(.ant-form-item-label > label) {
  height: auto;
  font-size: 13px;
  font-weight: 500;
  color: rgba(0, 0, 0, 0.85);
}

.settings-field__label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  line-height: 1.4;
}

.settings-field__info {
  color: #999;
  font-size: 13px;
  cursor: help;
}

.settings-field__control {
  min-height: 36px;
  max-width: 320px;
  display: flex;
  align-items: center;
}

.settings-field__control :deep(.ant-input-number),
.settings-field__control :deep(.ant-select),
.settings-field__control :deep(.ant-picker),
.settings-field__control :deep(.ant-input) {
  width: 100%;
}

.settings-field__control :deep(.ant-input-number-input),
.settings-field__control :deep(.ant-select-selector),
.settings-field__control :deep(.ant-input) {
  min-height: 36px;
  display: flex;
  align-items: center;
}

/* Reserved regardless of content — this is what keeps a row of fields
   aligned when only some of them have helper text. */
.settings-field__helper {
  font-size: 12.5px;
  color: #767676;
  margin-top: 5px;
  line-height: 1.5;
  min-height: 18px;
}
</style>
