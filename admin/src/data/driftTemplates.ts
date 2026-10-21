import type { DriftType } from '@/types'

export interface BuiltinDriftTemplate {
  id: string
  name: string
  category: 'Protocol' | 'Field behavior' | 'Maintenance'
  description: string
  suppressDriftTypes?: DriftType[]
  alertOnDriftTypes?: DriftType[]
  severityOverrides?: Partial<Record<DriftType, 'warning' | 'critical'>>
  consecutiveMissingThreshold?: number
  alertCooldownMs?: number
  pinAsBaseline?: boolean
  allowedTypes?: string[]
  adaptivePromotionBatches?: number
  adaptivePromotionMinElapsedMs?: number
  adaptiveRetireBatches?: number
  suggestedScope?: { fieldPattern?: string; devicePattern?: string; endpointPattern?: string }
}

const MIN = 60_000

export const BUILTIN_DRIFT_TEMPLATES: BuiltinDriftTemplate[] = [
  // ── Protocol ────────────────────────────────────────────────────────────
  {
    id: 'mqtt-dynamic-schema',
    name: 'MQTT dynamic schema',
    category: 'Protocol',
    description: 'Suppress new-field alerts for MQTT endpoints where topics appear dynamically',
    suppressDriftTypes: ['new-field'],
    suggestedScope: { endpointPattern: '*mqtt*' },
  },
  {
    id: 'bacnet-suppress-renames',
    name: 'BACnet suppress renames',
    category: 'Protocol',
    description: 'Suppress rename-candidate alerts for BACnet endpoints (object names often differ slightly across vendors)',
    suppressDriftTypes: ['rename-candidate'],
    suggestedScope: { endpointPattern: '*bacnet*' },
  },
  {
    id: 'slow-reporter',
    name: 'Slow reporter',
    category: 'Protocol',
    description: 'Raise the missing-field threshold for devices that report infrequently',
    consecutiveMissingThreshold: 50,
  },

  // ── Field behavior ──────────────────────────────────────────────────────
  {
    id: 'pin-critical-field',
    name: 'Pin critical field',
    category: 'Field behavior',
    description: 'Pin a field as permanent baseline — never retire, always alert if missing',
    pinAsBaseline: true,
    alertOnDriftTypes: ['missing-field'],
    severityOverrides: { 'missing-field': 'critical' },
  },
  {
    id: 'type-tolerant-field',
    name: 'Type-tolerant field',
    category: 'Field behavior',
    description: 'Allow a field to alternate between number and string without flagging type-drift',
    allowedTypes: ['number', 'string'],
  },
  {
    id: 'quiet-new-field',
    name: 'Quiet new-field',
    category: 'Field behavior',
    description: 'Suppress new-field alerts for specific fields or devices',
    suppressDriftTypes: ['new-field'],
  },

  // ── Maintenance ─────────────────────────────────────────────────────────
  {
    id: 'maintenance-window',
    name: 'Maintenance window',
    category: 'Maintenance',
    description: 'Downgrade missing-field to warning and raise the threshold during planned maintenance',
    severityOverrides: { 'missing-field': 'warning' },
    consecutiveMissingThreshold: 100,
    alertCooldownMs: 30 * MIN,
  },
  {
    id: 'schema-migration',
    name: 'Schema migration',
    category: 'Maintenance',
    description: 'Suppress all drift types temporarily during a planned schema migration',
    suppressDriftTypes: ['new-field', 'missing-field', 'type-drift', 'rename-candidate'],
  },
]
