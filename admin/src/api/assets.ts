import { client } from './client'
import type { Asset, AssetFormData, AssetMetricBinding, AssetMetricBindingFormData } from '@/types'

const BASE = '/v1/assets'

export const assetsApi = {
  getAll(): Promise<Asset[]> {
    return client.get<{ assets: Asset[] }>(BASE).then((r) => r.data.assets)
  },

  create(data: AssetFormData): Promise<Asset> {
    return client.post<{ asset: Asset }>(BASE, data).then((r) => r.data.asset)
  },

  update(uuid: string, data: Partial<AssetFormData>): Promise<Asset> {
    return client.patch<{ asset: Asset }>(`${BASE}/${uuid}`, data).then((r) => r.data.asset)
  },

  remove(uuid: string): Promise<void> {
    return client.delete(`${BASE}/${uuid}`).then(() => undefined)
  },

  addMetric(assetUuid: string, data: AssetMetricBindingFormData): Promise<AssetMetricBinding> {
    return client.post<{ binding: AssetMetricBinding }>(`${BASE}/${assetUuid}/metrics`, data).then((r) => r.data.binding)
  },

  removeMetric(assetUuid: string, bindingId: number): Promise<void> {
    return client.delete(`${BASE}/${assetUuid}/metrics/${bindingId}`).then(() => undefined)
  },
}
