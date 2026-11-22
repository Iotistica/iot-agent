<script setup lang="ts">
import { computed, watch, ref, onUnmounted } from 'vue'
import { theme } from 'ant-design-vue'
import { useTheme } from '@/composables/useTheme'
import { agentStarting, client } from '@/api/client'

const { isDark } = useTheme()

const themeConfig = computed(() => ({
  algorithm: isDark.value ? theme.darkAlgorithm : theme.defaultAlgorithm,
}))

const pollTimer = ref<ReturnType<typeof setInterval> | null>(null)

function startPolling() {
  if (pollTimer.value) return
  pollTimer.value = setInterval(async () => {
    try {
      await client.get('/v1/readiness')
      agentStarting.value = false
      stopPolling()
      window.location.reload()
    } catch {
      // still starting
    }
  }, 5000)
}

function stopPolling() {
  if (pollTimer.value) {
    clearInterval(pollTimer.value)
    pollTimer.value = null
  }
}

watch(agentStarting, (val) => {
  if (val) startPolling()
  else stopPolling()
}, { immediate: true })

onUnmounted(stopPolling)
</script>

<template>
  <a-config-provider :theme="themeConfig">
    <div v-if="agentStarting" class="starting-overlay">
      <p>Agent is starting up, please wait...</p>
    </div>
    <router-view v-else />
  </a-config-provider>
</template>

<style scoped>
.starting-overlay {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0a0a0a;
}

.starting-overlay p {
  color: rgba(255, 255, 255, 0.55);
  font-size: 15px;
  font-weight: 400;
}
</style>
