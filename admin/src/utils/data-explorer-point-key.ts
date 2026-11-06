export interface DataExplorerPointIdentity {
  protocol: string
  endpointName: string
  pointIdentityEndpointName?: string
  metric: string
  normalizedName?: string
}

export function dataExplorerPointKey(point: DataExplorerPointIdentity): string {
  return JSON.stringify([point.protocol, point.pointIdentityEndpointName || point.endpointName, point.normalizedName || point.metric])
}
