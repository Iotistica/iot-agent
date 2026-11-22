import axios from 'axios'
import { ref } from 'vue'

export const client = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '',
  timeout: 10_000,
  headers: { 'Content-Type': 'application/json' },
})

export interface ApiError {
  status: number
  message: string
}

export const agentStarting = ref(false)

client.interceptors.response.use(
  (res) => {
    if (agentStarting.value) agentStarting.value = false
    return res
  },
  (err) => {
    const status: number = err.response?.status ?? 0
    const message: string =
      err.response?.data?.message ?? err.response?.data?.error ?? err.message ?? 'Unknown error'
    if (status === 503 && message.toLowerCase().includes('starting up')) {
      agentStarting.value = true
      return Promise.reject({ status, message } satisfies ApiError)
    }
    if (status === 401 && !err.config?.url?.includes('/auth/')) {
      window.location.href = '/admin/login'
    }
    return Promise.reject({ status, message } satisfies ApiError)
  },
)
