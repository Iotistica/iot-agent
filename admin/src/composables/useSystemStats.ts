import { ref, computed } from 'vue'
import { containersApi } from '@/api/containers'
import type { AppSystemStats, ContainerMetricsApp } from '@/api/containers'

const PERF_HISTORY = 60

const sysStats = ref<AppSystemStats | null>(null)
const cpuHistory = ref<number[]>([])
const appMetrics = ref<ContainerMetricsApp[]>([])
const appCpuHistories = ref<Record<number, number[]>>({})
const statsLoading = ref(true)

let pollTimer: ReturnType<typeof setInterval> | null = null
let polling = false

function pushHistory(buf: number[], val: number) {
  buf.push(val)
  if (buf.length > PERF_HISTORY) buf.shift()
}

function cpuColor(v: number): string {
  if (v >= 90) return '#ff4d4f'
  if (v >= 70) return '#faad14'
  return '#3cb77d'
}

function storageColor(v: number | null): string {
  if (v == null) return '#8b949e'
  if (v >= 90) return '#ff4d4f'
  if (v >= 75) return '#faad14'
  return '#1677ff'
}

function fmtMb(mb: number | null): string {
  if (mb == null) return '—'
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb} MB`
}

async function pollOnce() {
  const [stats, metrics] = await Promise.allSettled([
    containersApi.getSystemStats(),
    containersApi.getContainerMetrics(),
  ])

  if (stats.status === 'fulfilled') {
    sysStats.value = stats.value
    pushHistory(cpuHistory.value, stats.value.cpu_usage ?? 0)
  }

  if (metrics.status === 'fulfilled') {
    appMetrics.value = metrics.value.apps
    for (const app of metrics.value.apps) {
      if (!appCpuHistories.value[app.app_id]) {
        appCpuHistories.value[app.app_id] = []
      }
      pushHistory(appCpuHistories.value[app.app_id], app.cpu_percent)
    }
  }

  statsLoading.value = false
}

function startPolling() {
  if (polling) return
  polling = true
  pollTimer = setInterval(pollOnce, 5000)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  polling = false
}

async function pollNow() {
  await pollOnce()
}

const storageSegments = computed(() => {
  const disk = sysStats.value?.docker_disk
  if (!disk) return []
  return [...(disk.images_by_app ?? [])]
    .sort((a, b) => b.size - a.size)
})

export function useSystemStats() {
  return {
    sysStats,
    cpuHistory,
    appMetrics,
    appCpuHistories,
    statsLoading,
    storageSegments,
    startPolling,
    stopPolling,
    pollNow,
    cpuColor,
    storageColor,
    fmtMb,
  }
}
