export interface DataExplorerPointIdentity {
  protocol: string
  endpointName: string
  metric: string
  normalizedName?: string
}

export function dataExplorerPointKey(point: DataExplorerPointIdentity): string {
  return JSON.stringify([point.protocol, point.endpointName, point.normalizedName || point.metric])
}
