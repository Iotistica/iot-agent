import { client } from './client'

export interface DeviceInfo {
  uuid?: string
  name?: string
  provisioned?: boolean
  is_online?: boolean
  pro_installed?: boolean
  docker_available?: boolean
  [key: string]: unknown
}

export interface WriteResult {
  success: boolean
  deviceUuid: string
  pointName: string
  value: number | boolean | string
}

export const deviceApi = {
  getInfo(): Promise<DeviceInfo> {
    return client.get<DeviceInfo>('/v1/device').then((r) => r.data)
  },

  writePoint(deviceUuid: string, pointName: string, value: number | boolean | string): Promise<WriteResult> {
    return client.post<WriteResult>(`/v1/devices/${deviceUuid}/write`, { pointName, value }).then((r) => r.data)
  },
}
