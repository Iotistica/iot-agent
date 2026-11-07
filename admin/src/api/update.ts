import { client } from './client'

export interface UpdateCheckResult {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  releaseDate?: string
  notes?: string
  error?: string
}

export interface UpdateTriggerResult {
  status: string
  version: string
}

export const updateApi = {
  check(force = false): Promise<UpdateCheckResult> {
    return client.get<UpdateCheckResult>('/v1/update/check', { params: force ? { force: 'true' } : undefined }).then(r => r.data)
  },

  trigger(version: string, force = false): Promise<UpdateTriggerResult> {
    return client.post<UpdateTriggerResult>('/v1/update', { version, force }).then(r => r.data)
  },
}
