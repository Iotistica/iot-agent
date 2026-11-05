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

export interface WritablePoint {
  name: string
  type: string | null
  unit: string | null
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

  getWritablePoints(deviceUuid: string): Promise<WritablePoint[]> {
    return client.get<{ points: WritablePoint[] }>(`/v1/devices/${deviceUuid}/writable-points`).then((r) => r.data.points)
  },

  writePoint(deviceUuid: string, pointName: string, value: number | boolean | string): Promise<WriteResult> {
    return client.post<WriteResult>(`/v1/devices/${deviceUuid}/write`, { pointName, value }).then((r) => r.data)
  },
}
