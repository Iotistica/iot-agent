<script setup lang="ts">
defineProps<{
  title: string
  subtitle?: string
}>()
</script>

<template>
  <a-card :bordered="true" size="small" class="settings-section">
    <div class="settings-section__header">
      <div v-if="$slots.icon" class="settings-section__icon">
        <slot name="icon" />
      </div>
      <div class="settings-section__heading">
        <div class="settings-section__title">{{ title }}</div>
        <div v-if="subtitle" class="settings-section__subtitle">{{ subtitle }}</div>
      </div>
      <div v-if="$slots.extra" class="settings-section__extra">
        <slot name="extra" />
      </div>
    </div>

    <div class="settings-section__body">
      <slot />
    </div>
  </a-card>
</template>

<style scoped>
.settings-section {
  margin-bottom: 20px;
}

.settings-section :deep(.ant-card-body) {
  padding: 20px 24px;
}

.settings-section__header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 20px;
}

.settings-section__icon {
  width: 36px;
  height: 36px;
  border-radius: var(--settings-radius, 8px);
  background: #e6f4ff;
  color: #1677ff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  flex-shrink: 0;
}

.settings-section__heading {
  flex: 1;
  min-width: 0;
}

.settings-section__title {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
}

.settings-section__subtitle {
  font-size: 13px;
  color: #767676;
  margin-top: 3px;
  line-height: 1.5;
}

.settings-section__extra {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

@media (max-width: 576px) {
  .settings-section__header {
    flex-wrap: wrap;
  }
  .settings-section__extra {
    width: 100%;
    justify-content: flex-start;
  }
}
</style>
