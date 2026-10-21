import { client } from './client'

export interface SavedView {
  id: string
  name: string
  description?: string
  pointKeys: string[]
}

export interface CreateViewInput {
  name: string
  description?: string
  pointKeys: string[]
}

const BASE = '/v1/data-explorer/views'

export const viewsApi = {
  list(): Promise<SavedView[]> {
    return client.get<{ views: SavedView[] }>(BASE).then((r) => r.data.views)
  },

  create(input: CreateViewInput): Promise<SavedView> {
    return client.post<{ view: SavedView }>(BASE, input).then((r) => r.data.view)
  },

  update(id: string, input: Partial<CreateViewInput>): Promise<SavedView> {
    return client.patch<{ view: SavedView }>(`${BASE}/${encodeURIComponent(id)}`, input).then((r) => r.data.view)
  },

  remove(id: string): Promise<void> {
    return client.delete(`${BASE}/${encodeURIComponent(id)}`).then(() => undefined)
  },
}
