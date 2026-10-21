import { client } from './client'

export interface PointCatalogEntry {
  sourceSystem: string | null
  endpointName: string
  rawName: string
  normalizedName: string
  pointKey: string
}

export const pointCatalogApi = {
  getAll(): Promise<PointCatalogEntry[]> {
    return client.get<{ points: PointCatalogEntry[] }>('/v1/point-catalog').then(r => r.data.points)
  },
}
