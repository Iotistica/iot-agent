<script setup lang="ts">
import { computed } from 'vue'
import { theme } from 'ant-design-vue'
import { useTheme } from '@/composables/useTheme'

const { isDark } = useTheme()

const themeConfig = computed(() => ({
  algorithm: isDark.value ? theme.darkAlgorithm : theme.defaultAlgorithm,
}))
</script>

<template>
  <a-config-provider :theme="themeConfig">
    <router-view />
  </a-config-provider>
</template>
