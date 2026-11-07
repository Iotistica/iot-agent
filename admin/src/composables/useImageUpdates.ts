import { ref, computed, onUnmounted } from 'vue'
import { notification } from 'ant-design-vue'
import { containersApi } from '@/api/containers'
import type { ImageUpdateStatus } from '@/api/containers'

const POLL_INTERVAL_MS = 5 * 60 * 1000

const updates = ref<ImageUpdateStatus[]>([])
const checking = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null
let refCount = 0
let initialCheckDone = false

const availableUpdates = computed(() =>
  updates.value.filter(u => u.updateAvailable === true),
)

const updateCount = computed(() => availableUpdates.value.length)

async function check(force = false) {
  if (checking.value) return
  checking.value = true
  try {
    const fresh = await containersApi.checkImageUpdates(force)
    const prevKeys = new Set(
      availableUpdates.value.map(u => `${u.appId}:${u.serviceName}`),
    )
    updates.value = fresh

    if (initialCheckDone) {
      const newOnes = fresh.filter(
        u => u.updateAvailable === true && !prevKeys.has(`${u.appId}:${u.serviceName}`),
      )
      if (newOnes.length > 0) {
        const names = newOnes.map(u => u.serviceName).join(', ')
        notification.info({
          message: 'Image updates available',
          description: `${newOnes.length === 1 ? names + ' has' : names + ' have'} a newer image available.`,
          duration: 8,
        })
      }
    }
    initialCheckDone = true
  } catch { /* non-critical */ }
  finally { checking.value = false }
}

function startPolling() {
  if (!pollTimer) {
    check()
    pollTimer = setInterval(() => check(), POLL_INTERVAL_MS)
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

export function useImageUpdates() {
  refCount++
  if (refCount === 1) startPolling()

  onUnmounted(() => {
    refCount--
    if (refCount <= 0) {
      stopPolling()
      refCount = 0
    }
  })

  return {
    updates,
    availableUpdates,
    updateCount,
    checking,
    check,
  }
}
