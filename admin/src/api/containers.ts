import { client } from './client'

export interface MarketplaceImage {
  id: string
  name: string
  category: string
  description: string
  color: string
  letter: string
  image: string
  ports?: string[]
  volumes?: string[]
  environment?: Record<string, string>
  restart?: string
  command?: string
  entrypoint?: string
  user?: string
  networkMode?: string
  enableSocketDestination?: boolean
}

export interface MarketplaceCategory {
  id: string
  name: string
  color: string | null
  sort_order: number
}

export type ServiceStatus = {
  state: 'creating' | 'running' | 'stopped' | 'error' | 'unknown'
  startedAt?: string
  finishedAt?: string
  exitCode?: number
  restartCount?: number
  health?: 'healthy' | 'unhealthy' | 'starting' | 'unknown'
  message?: string
}

export interface ContainerService {
  serviceId: number
  serviceName: string
  imageName: string
  appId: number
  appName: string
  state?: 'running' | 'stopped' | 'paused'
  serviceStatus?: 'pending' | 'running' | 'stopped' | 'error'
  containerId?: string
  status?: ServiceStatus
  error?: {
    type: 'ImagePullBackOff' | 'ErrImagePull' | 'StartFailure' | 'CrashLoopBackOff'
    message: string
    retryCount: number
    nextRetry?: string
  }
  socketConnected?: boolean
  config: {
    image: string
    ports?: string[]
    environment?: Record<string, string>
    volumes?: string[]
    restart?: string
    labels?: Record<string, string>
    networkMode?: string
    command?: string[]
    entrypoint?: string[]
    user?: string
    enableSocketDestination?: boolean
    readonlyRootfs?: boolean
    privileged?: boolean
    resources?: { limits?: { cpu?: string; memory?: string } }
    livenessProbe?: {
      type: 'http' | 'tcp' | 'exec'
      path?: string
      port?: number
      command?: string[]
      periodSeconds?: number
      timeoutSeconds?: number
      failureThreshold?: number
    }
  }
}

export interface ContainerApp {
  appId: number
  appName: string
  services: ContainerService[]
}

export interface DeployServiceForm {
  serviceName: string
  imageName: string
  state?: 'running' | 'stopped'
  config: {
    image: string
    ports?: string[]
    environment?: Record<string, string>
    volumes?: string[]
    restart?: string
    networkMode?: string
    command?: string[]
    entrypoint?: string[]
    user?: string
    enableSocketDestination?: boolean
    readonlyRootfs?: boolean
    resources?: { limits?: { cpu?: string; memory?: string } }
    livenessProbe?: {
      type: 'http' | 'tcp' | 'exec'
      path?: string
      port?: number
      command?: string[]
      periodSeconds?: number
      timeoutSeconds?: number
      failureThreshold?: number
    }
  }
}

export interface DeployAppForm {
  appName: string
  services: DeployServiceForm[]
}

export type DockerConnectionType = 'socket' | 'tcp' | 'tcp+tls'

export interface DockerConfig {
  type: DockerConnectionType
  socketPath?: string
  host?: string
  port?: number
  ca?: string
  cert?: string
  key?: string
}

export interface DockerTestResult {
  version: string
  containers: number
}

export const dockerConfigApi = {
  get(): Promise<DockerConfig> {
    return client.get<DockerConfig>('/v1/docker/config').then(r => r.data)
  },
  save(cfg: DockerConfig): Promise<void> {
    return client.post('/v1/docker/config', cfg).then(() => undefined)
  },
  test(cfg: DockerConfig): Promise<DockerTestResult> {
    return client.post<DockerTestResult>('/v1/docker/test', cfg).then(r => r.data)
  },
}

export const templatesApi = {
  getAll(): Promise<{ templates: MarketplaceImage[]; categories: string[] }> {
    return client.get('/v1/app-templates').then(r => r.data)
  },
  get(id: string): Promise<MarketplaceImage> {
    return client.get<MarketplaceImage>(`/v1/app-templates/${encodeURIComponent(id)}`).then(r => r.data)
  },
  create(image: MarketplaceImage): Promise<MarketplaceImage> {
    return client.post<MarketplaceImage>('/v1/app-templates', image).then(r => r.data)
  },
  update(id: string, image: MarketplaceImage): Promise<MarketplaceImage> {
    return client.put<MarketplaceImage>(`/v1/app-templates/${encodeURIComponent(id)}`, image).then(r => r.data)
  },
  delete(id: string): Promise<void> {
    return client.delete(`/v1/app-templates/${encodeURIComponent(id)}`).then(() => undefined)
  },
}

export const categoriesApi = {
  getAll(): Promise<MarketplaceCategory[]> {
    return client.get<MarketplaceCategory[]>('/v1/marketplace-categories').then(r => r.data)
  },
  create(name: string, color?: string): Promise<MarketplaceCategory> {
    return client.post<MarketplaceCategory>('/v1/marketplace-categories', { name, color }).then(r => r.data)
  },
  delete(id: string): Promise<void> {
    return client.delete(`/v1/marketplace-categories/${encodeURIComponent(id)}`).then(() => undefined)
  },
}

export const containersApi = {
  getAll(): Promise<ContainerApp[]> {
    return client.get<{ apps: ContainerApp[] }>('/v1/apps').then(r => r.data.apps)
  },

  deploy(form: DeployAppForm): Promise<{ appId: number; appName: string }> {
    return client.post('/v1/apps', form).then(r => r.data)
  },

  addService(appId: number, form: DeployServiceForm): Promise<ContainerService> {
    return client.post<ContainerService>(`/v1/apps/${appId}/services`, form).then(r => r.data)
  },

  updateService(appId: number, serviceName: string, form: DeployServiceForm): Promise<ContainerService> {
    return client.put<ContainerService>(
      `/v1/apps/${appId}/services/${encodeURIComponent(serviceName)}`,
      form,
    ).then(r => r.data)
  },

  renameApp(appId: number, appName: string): Promise<{ appId: number; appName: string }> {
    return client.patch(`/v1/apps/${appId}`, { appName }).then(r => r.data)
  },

  remove(appId: number): Promise<void> {
    return client.delete(`/v1/apps/${appId}`).then(() => undefined)
  },

  removeService(appId: number, serviceName: string): Promise<void> {
    return client.delete(`/v1/apps/${appId}/services/${encodeURIComponent(serviceName)}`).then(() => undefined)
  },

  serviceAction(
    appId: number,
    serviceName: string,
    action: 'start' | 'stop' | 'restart',
  ): Promise<void> {
    return client
      .post(`/v1/apps/${appId}/services/${encodeURIComponent(serviceName)}/${action}`)
      .then(() => undefined)
  },

  getSystemStats(): Promise<AppSystemStats> {
    return client.get<AppSystemStats>('/v1/apps/system-stats').then(r => r.data)
  },

  purgeUnused(): Promise<{ images_deleted: number; volumes_deleted: number; space_reclaimed: number }> {
    return client.post('/v1/apps/purge-unused').then(r => r.data)
  },
}

export interface AppSystemStats {
  cpu_usage: number
  storage_used: number | null
  storage_total: number | null
  storage_percent: number | null
  docker_disk: {
    images: number
    volumes: number
    total: number
    images_by_app: Array<{ app_id: number; app_name: string; size: number }>
  } | null
  docker_reclaimable: {
    images: number
    volumes: number
    total: number
  } | null
}
