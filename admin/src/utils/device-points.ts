import type { PointCatalogEntry } from '../api/point-catalog'

export interface DevicePoint {
  point: PointCatalogEntry
  deviceName: string
}

export function getDevicePoints(points: PointCatalogEntry[], deviceNames: Map<string, string>): DevicePoint[] {
  return points.flatMap(point => {
    const deviceName = point.deviceKey ? deviceNames.get(point.deviceKey) : undefined
    return deviceName ? [{ point, deviceName }] : []
  })
}
