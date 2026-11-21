export const SOURCE_TAG_COLORS: Record<string, string> = {
  anomaly: 'purple',
  'schema-drift': 'cyan',
  audit: 'blue',
  auth: 'gold',
  discovery: 'green',
  memory: 'orange',
  adapter: 'magenta',
  system: 'default',
}

export const SOURCE_LABELS: Record<string, string> = {
  anomaly: 'Anomaly',
  'schema-drift': 'Schema Drift',
  audit: 'Audit',
  auth: 'Auth',
  discovery: 'Discovery',
  memory: 'Memory',
  adapter: 'Adapter',
  system: 'System',
}

export const SOURCE_OPTIONS = [
  { value: '', label: 'All Sources' },
  { value: 'anomaly', label: 'Anomaly' },
  { value: 'schema-drift', label: 'Schema Drift' },
  { value: 'audit', label: 'Audit' },
  { value: 'discovery', label: 'Discovery' },
  { value: 'memory', label: 'Memory' },
  { value: 'adapter', label: 'Adapter' },
  { value: 'system', label: 'System' },
]

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source
}

export function sourceColor(source: string): string {
  return SOURCE_TAG_COLORS[source] ?? 'default'
}
