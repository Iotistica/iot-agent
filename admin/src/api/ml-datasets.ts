import { client } from './client'

export interface MlDataset {
  id: string
  name: string
  description: string
  pointKeys: string[]
  samplingIntervalSecs: number
  windowSecs: number
  missingValues: string
  normalization: string
  excludeBadQuality: boolean
  removeOutliers: boolean
  outlierMethod: string
  outputFormat: string
  createdAt: string
  updatedAt: string
}

export interface CreateMlDatasetInput {
  name: string
  description?: string
  pointKeys: string[]
  samplingIntervalSecs: number
  windowSecs: number
  missingValues: string
  normalization: string
  excludeBadQuality: boolean
  removeOutliers: boolean
  outlierMethod?: string
  outputFormat: string
}


const BASE = '/v1/ml-datasets'

export const datasetsApi = {
  list(): Promise<MlDataset[]> {
    return client.get<{ datasets: MlDataset[] }>(BASE).then((r) => r.data.datasets)
  },

  get(id: string): Promise<MlDataset> {
    return client.get<{ dataset: MlDataset }>(`${BASE}/${encodeURIComponent(id)}`).then((r) => r.data.dataset)
  },

  create(input: CreateMlDatasetInput): Promise<MlDataset> {
    return client.post<{ dataset: MlDataset }>(BASE, input).then((r) => r.data.dataset)
  },

  update(id: string, input: Partial<CreateMlDatasetInput>): Promise<MlDataset> {
    return client.patch<{ dataset: MlDataset }>(`${BASE}/${encodeURIComponent(id)}`, input).then((r) => r.data.dataset)
  },

  remove(id: string): Promise<void> {
    return client.delete(`${BASE}/${encodeURIComponent(id)}`).then(() => undefined)
  },
}
