import { ref } from 'vue'
import { deviceApi } from '@/api/device'

const dockerAvailable = ref<boolean>(true)

export function useDockerStatus() {
  async function fetchDockerStatus(): Promise<void> {
    try {
      const info = await deviceApi.getInfo()
      dockerAvailable.value = info.docker_available ?? true
    } catch {
      dockerAvailable.value = true
    }
  }

  return { dockerAvailable, fetchDockerStatus }
}
