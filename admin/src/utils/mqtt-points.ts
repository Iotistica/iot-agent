// Parses MQTT Explorer payloads into a structured Points table. Only the
// well-typed 'tags'/'ecp' ({tags:[...]}) and 'ml' ({schema:'iotistica.ml.v1',
// features:[...]}) wire formats are recognized (see src/publish/core/
// manager.ts's TagPayload/MlFeaturePayload) — anything else, including the
// heterogeneous 'custom' format, returns null so the caller falls back to
// Raw JSON. Quality is always derived from dqStatus (lowercase good/
// degraded/bad/unknown — the field actually present on tags/ecp/ml
// payloads), never from the raw uppercase protocol `quality` field (GOOD/
// BAD/UNCERTAIN), which isn't serialized on tags/ecp payloads at all.

export type PointQuality = 'good' | 'degraded' | 'bad' | 'unknown'

export interface PointRow {
  key: string            // `${index}:${name}` — stable even if names collide (tags/ecp never guarantee uniqueness)
  name: string            // normalized name if present, else raw name
  rawName?: string
  value: unknown
  unit: string            // '' when absent — template renders '—'
  quality: PointQuality    // derived from dqStatus, never from protocol `quality`
  hasError: boolean
}

// Superset of TagPayload/MlFeaturePayload's optional fields, plus shared
// envelope context. Every field here is optional except name/value/
// envelopeTimestamp — nothing is fabricated for a point that lacks it.
export interface PointDetail {
  name: string
  rawName?: string
  value: unknown
  error?: unknown
  type?: 1 | 2 | 3 | 4                                   // ecp-only numeric type code
  dtype?: 'bool' | 'int' | 'float' | 'string' | 'error'   // ml-only
  quality?: 'GOOD' | 'BAD'                                // raw protocol quality — ml always, tags/ecp rarely
  unit?: string
  rawUnit?: string
  dqStatus?: string
  dqUnitConfidence?: number
  dqIssueCodes?: string[]
  provisionalPointId?: string                             // labeled "Point Identity" in the UI, never "Point ID"
  anomaly_score?: number
  anomaly_threshold?: number
  baseline_samples?: number
  detection_methods?: string[]
  trend?: string
  trend_strength?: number
  predicted_next?: number
  forecast_confidence?: number
  device_state?: unknown
  state_duration_seconds?: number
  envelopeTimestamp: number
  envelopeNode?: string
  envelopeGroup?: string
}

export interface ParsedPointsPayload {
  format: 'tags-like' | 'ml-like'
  rows: PointRow[]
  details: Map<string, PointDetail>   // keyed by PointRow.key, kept separate from rows so a table
                                       // with hundreds of rows doesn't carry full detail objects per row
}

/**
 * Structural detection only — tags and ecp are wire-indistinguishable, so
 * this never tries to tell them apart. Validates element shape (every array
 * entry has a string `name`), not just array-ness, to reduce false
 * positives from unrelated JSON sharing the broker (the monitor subscribes
 * to `#` — everything on the broker, not just this agent's own traffic).
 */
export function detectPointsFormat(payload: unknown): 'tags-like' | 'ml-like' | null {
  if (!payload || typeof payload !== 'object') return null
  const env = payload as Record<string, unknown>

  if (
    env.schema === 'iotistica.ml.v1' &&
    Array.isArray(env.features) &&
    env.features.every((f) => f && typeof f === 'object' && typeof (f as Record<string, unknown>).name === 'string')
  ) {
    return 'ml-like'
  }

  if (
    Array.isArray(env.tags) &&
    env.tags.every((t) => t && typeof t === 'object' && typeof (t as Record<string, unknown>).name === 'string')
  ) {
    return 'tags-like'
  }

  return null
}

/** dqStatus (good/degraded/bad/unknown, lowercase) -> PointQuality. Never reads the raw uppercase protocol `quality` field. */
export function qualityFromDqStatus(dqStatus: string | undefined): PointQuality {
  const v = dqStatus?.toLowerCase()
  return v === 'good' || v === 'degraded' || v === 'bad' ? v : 'unknown'
}

/**
 * Single entry point. Returns null (-> Raw JSON fallback) for non-JSON,
 * non-object, or undetected payload shapes. Never mutates or deep-clones
 * the parsed JSON beyond building the flat row/detail objects below.
 */
export function parsePointsPayload(rawJsonText: string): ParsedPointsPayload | null {
  let obj: unknown
  try {
    obj = JSON.parse(rawJsonText)
  } catch {
    return null
  }

  const format = detectPointsFormat(obj)
  if (!format) return null

  const env = obj as Record<string, unknown>
  const items = (format === 'ml-like' ? env.features : env.tags) as Array<Record<string, unknown>>
  const envelopeTimestamp = Number(env.timestamp) || 0
  const envelopeNode = typeof env.node === 'string' ? env.node : undefined
  const envelopeGroup = typeof env.group === 'string' ? env.group : undefined

  const rows: PointRow[] = []
  const details = new Map<string, PointDetail>()

  items.forEach((item, index) => {
    const name = String(item.name)
    const rawName = typeof item.rawName === 'string' ? item.rawName : undefined
    const key = `${index}:${name}`

    rows.push({
      key,
      name,
      rawName,
      value: item.value ?? null,
      unit: typeof item.unit === 'string' ? item.unit : '',
      quality: qualityFromDqStatus(item.dqStatus as string | undefined),
      hasError: item.error !== undefined,
    })

    details.set(key, {
      ...item,
      name,
      rawName,
      envelopeTimestamp,
      envelopeNode,
      envelopeGroup,
    } as PointDetail)
  })

  return { format, rows, details }
}

/** Pure filter over the already-parsed flat row array — never touches `details`, so search stays cheap. */
export function filterPointRows(rows: PointRow[], search: string, quality: PointQuality | 'all'): PointRow[] {
  const q = search.trim().toLowerCase()
  return rows.filter(
    (r) =>
      (quality === 'all' || r.quality === quality) &&
      (!q || r.name.toLowerCase().includes(q) || (r.rawName?.toLowerCase().includes(q) ?? false)),
  )
}

function formatDetailValue(v: unknown): string {
  if (Array.isArray(v)) return v.join(', ')
  if (v && typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/**
 * The single place that decides which fields to show in a point's expanded
 * detail view, each gated on actually being present — enforces "never
 * invent fields that aren't present" in one place instead of a per-field
 * v-if chain in the template.
 */
export function pointDetailFields(detail: PointDetail): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = []
  const add = (cond: unknown, label: string, value: unknown) => {
    if (cond !== undefined && cond !== null) out.push({ label, value: formatDetailValue(value) })
  }

  add(detail.rawName, 'Raw Name', detail.rawName)
  add(detail.name, 'Normalized Name', detail.name)
  add(detail.rawUnit, 'Raw Unit', detail.rawUnit)
  add(detail.unit, 'Canonical Unit', detail.unit)
  add(detail.dqStatus, 'Data Quality', detail.dqStatus)
  add(detail.quality, 'Protocol Quality', detail.quality)
  add(detail.dqUnitConfidence, 'Unit Confidence', detail.dqUnitConfidence)
  add(detail.dqIssueCodes?.length, 'Issue Codes', detail.dqIssueCodes)
  add(detail.provisionalPointId, 'Point Identity', detail.provisionalPointId)
  add(detail.envelopeTimestamp, 'Timestamp', new Date(detail.envelopeTimestamp).toLocaleString())
  add(detail.dtype, 'Data Type', detail.dtype)
  add(detail.type, 'ECP Type', detail.type)
  add(detail.error, 'Error', detail.error)
  add(detail.anomaly_score, 'Anomaly Score', detail.anomaly_score)
  add(detail.anomaly_threshold, 'Anomaly Threshold', detail.anomaly_threshold)
  add(detail.baseline_samples, 'Baseline Samples', detail.baseline_samples)
  add(detail.detection_methods?.length, 'Detection Methods', detail.detection_methods)
  add(detail.trend, 'Trend', detail.trend)
  add(detail.trend_strength, 'Trend Strength', detail.trend_strength)
  add(detail.predicted_next, 'Predicted Next', detail.predicted_next)
  add(detail.forecast_confidence, 'Forecast Confidence', detail.forecast_confidence)
  add(detail.device_state, 'Device State', detail.device_state)
  add(detail.state_duration_seconds, 'State Duration (s)', detail.state_duration_seconds)
  add(detail.envelopeNode, 'Node', detail.envelopeNode)
  add(detail.envelopeGroup, 'Group', detail.envelopeGroup)

  return out
}
