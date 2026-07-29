// Mirrors agent/src/db/models/publish-destinations.model.ts
export type DestinationType = 'iotistica' | 'azure' | 'aws' | 'gcp' | 'mqtt' | string

export interface Destination {
  id: number
  name: string
  type: DestinationType
  config_json: Record<string, unknown> | null
  enabled: boolean
  last_error: string | null
  last_error_at: string | null
  created_at: string
  updated_at: string
}

// Mirrors agent/src/db/models/publish-subscriptions.model.ts
export type PayloadFormat = 'custom' | 'tags' | 'ecp' | 'ml'
export type Compression = 'json' | 'msgpack' | 'json+deflate' | 'msgpack+deflate'

export interface SubscriptionRoute {
  includeMetrics?: string[]
  excludeMetrics?: string[]
  includeDevices?: string[]
  excludeDevices?: string[]
  qualities?: Array<'GOOD' | 'BAD' | 'UNCERTAIN'>
  minIntervalMs?: number
  maxPointsPerMessage?: number
  topic?: string
}

export interface Subscription {
  id: number
  publish_destination_id: number
  topics: string[]
  route_json: SubscriptionRoute | null
  payload_format: PayloadFormat
  compression: Compression | null
  enabled: boolean
  created_at: string
  updated_at: string
}

// Form shapes (omit server-generated fields)
export type DestinationFormData = Omit<Destination, 'id' | 'last_error' | 'last_error_at' | 'created_at' | 'updated_at'>
export type SubscriptionFormData = Omit<Subscription, 'id' | 'created_at' | 'updated_at'>

// Mirrors agent/src/db/models/endpoints.model.ts
export type EndpointProtocol = 'modbus' | 'opcua' | 'mqtt' | 'bacnet'

export type EndpointCommunicationQuality = 'good' | 'degraded' | 'poor' | 'offline'

export interface EndpointHealth {
  connected: boolean
  communicationQuality: EndpointCommunicationQuality
  lastSeen: string | null
  lastPoll: string | null
  lastError: string | null
  responseTimeMs: number | null
  status?: string
}

export interface Endpoint {
  uuid: string
  name: string
  protocol: EndpointProtocol | string
  enabled: boolean
  poll_interval: number
  connection: Record<string, unknown>
  data_points?: unknown[]
  metadata?: Record<string, unknown>
  fingerprint?: string
  created_at?: string
  updated_at?: string
  health?: EndpointHealth
}

export type DiscoveryRuleStatus = 'idle' | 'running' | 'ok' | 'error'

export interface DiscoveryRuleResult {
  found: number
  saved: number
  skipped: number
  error?: string
}

export interface DiscoveryRule {
  uuid: string
  name: string
  enabled: boolean
  protocol: string
  interval_seconds: number
  target_json: Record<string, unknown> | null
  params_json: Record<string, unknown> | null
  auto_enable: boolean
  status: DiscoveryRuleStatus
  last_run_at: string | null
  next_run_at: string | null
  last_result_json: DiscoveryRuleResult | null
  created_at?: string
  updated_at?: string
}

export interface DiscoveryRuleFormData {
  name: string
  protocol: string
  interval_seconds: number
  enabled: boolean
  auto_enable: boolean
  target_json: Record<string, unknown> | null
  params_json: Record<string, unknown> | null
}

export type AssetCriticality = 'low' | 'medium' | 'high' | 'critical'

export interface AssetMetricBinding {
  id: number
  asset_id: number
  device_uuid: string
  endpoint_uuid: string | null
  metric: string
  created_at?: string
  updated_at?: string
}

export interface Asset {
  uuid: string
  name: string
  asset_type: string | null
  criticality: AssetCriticality
  manufacturer: string | null
  model: string | null
  rated_life_hours: number | null
  rated_cycles: number | null
  install_date: number | null
  last_service_date: number | null
  location: string | null
  metrics: AssetMetricBinding[]
  created_at?: string
  updated_at?: string
}

export interface AssetFormData {
  name: string
  asset_type: string | null
  criticality: AssetCriticality
  manufacturer: string | null
  model: string | null
  rated_life_hours: number | null
  rated_cycles: number | null
  install_date: number | null
  last_service_date: number | null
  location: string | null
}

export interface AssetMetricBindingFormData {
  device_uuid: string
  endpoint_uuid: string | null
  metric: string
}

// ── Preventive maintenance / energy recommendations (Pro-only) ─────────────

export type MaintenanceRuleType = 'cumulative_runtime' | 'cycle_count' | 'threshold_duration'
export type EnergyRuleType = 'standby_waste' | 'schedule_mismatch' | 'duty_cycle'
export type RecommendationStatus = 'open' | 'scheduled' | 'completed' | 'dismissed'

export interface WindowGating {
  metric: string
  min?: number
  max?: number
}

export interface CumulativeRuntimeRuleConfig {
  metric: string
  thresholdHours: number
  windowGating?: WindowGating
}

export interface CycleCountRuleConfig {
  metric: string
  thresholdCycles: number
}

export interface ThresholdDurationRuleConfig {
  metric: string
  threshold: number
  comparator: 'gt' | 'lt'
  sustainedForMs: number
  consecutiveWindowsRequired: number
  windowGating?: WindowGating
}

export type MaintenanceRuleConfig = CumulativeRuntimeRuleConfig | CycleCountRuleConfig | ThresholdDurationRuleConfig

export interface MaintenanceRule {
  id: number
  asset_id: number
  asset_uuid?: string
  asset_name?: string
  component: string
  rule_type: MaintenanceRuleType
  enabled: boolean
  config: MaintenanceRuleConfig
  created_at?: string
  updated_at?: string
}

export interface MaintenanceRuleFormData {
  asset_uuid: string
  component: string
  rule_type: MaintenanceRuleType
  enabled: boolean
  config: MaintenanceRuleConfig
}

export interface MaintenanceRecommendation {
  id: number
  asset_id: number
  asset_name: string
  criticality: string
  component: string
  rule_type: string
  rule_config: Record<string, unknown>
  status: RecommendationStatus
  message: string
  due_by: number | null
  confidence: number | null
  consecutive_count: number
  first_evaluated_at: number
  last_evaluated_at: number
  created_at?: string
  updated_at?: string
}

export interface StandbyWasteRuleConfig {
  metric: string
  standbyThreshold: number
  outsideScheduleOnly: boolean
  schedule?: { start: string; end: string; days: number[] }
}

export interface ScheduleMismatchRuleConfig {
  metric: string
  expectedSchedule: { start: string; end: string; days: number[] }
  toleranceMinutes: number
}

export interface DutyCycleRuleConfig {
  metric: string
  windowMs: number
  expectedMinRatio?: number
  expectedMaxRatio?: number
}

export type EnergyRuleConfig = StandbyWasteRuleConfig | ScheduleMismatchRuleConfig | DutyCycleRuleConfig

export interface EnergyRule {
  id: number
  asset_id: number
  asset_uuid?: string
  asset_name?: string
  metric: string
  rule_type: EnergyRuleType
  enabled: boolean
  config: EnergyRuleConfig
  created_at?: string
  updated_at?: string
}

export interface EnergyRuleFormData {
  asset_uuid: string
  metric: string
  rule_type: EnergyRuleType
  enabled: boolean
  config: EnergyRuleConfig
}

export interface EnergyRecommendation {
  id: number
  asset_id: number
  asset_name: string
  criticality: string
  metric: string
  rule_type: string
  rule_config: Record<string, unknown>
  status: RecommendationStatus
  message: string
  estimated_impact: string | null
  confidence: number | null
  consecutive_count: number
  first_evaluated_at: number
  last_evaluated_at: number
  created_at?: string
  updated_at?: string
}

export interface RecommendationPublishSettings {
  module: 'maintenance' | 'energy'
  mqtt: boolean
  cloud: boolean
  alert_destination_id: number | null
  alert_topic: string | null
}

export interface EndpointCreateData {
  name: string
  protocol: string
  connection: Record<string, unknown>
  poll_interval?: number
  enabled?: boolean
  data_points?: unknown[]
  metadata?: Record<string, unknown>
  fingerprint?: string
}

export interface EndpointUpdateData {
  enabled?: boolean
  poll_interval?: number
}

// ── Anomaly detection ────────────────────────────────────────────────────────

export type AnomalySeverity = 'info' | 'warning' | 'critical'
export type DetectionMethod =
  | 'zscore'
  | 'mad'
  | 'iqr'
  | 'expected_range'
  | 'rate_change'
  | 'ewma'
  | 'cusum'
  | 'fusion'
  | 'simulation'
export type SeasonalityPattern = 'none' | 'day-night' | 'hourly' | 'weekly'

export interface AnomalyAlert {
  id: string
  severity: AnomalySeverity
  metric: string
  deviceState?: string
  value: number
  expectedRange: [number, number]
  deviation: number
  detectionMethod: DetectionMethod
  timestamp: number
  confidence: number
  message: string
  fingerprint: string
  count: number
  cooldownSec: number
  firstSeen: number
  consecutiveCount: number
}

export interface AnomalyMetricConfig {
  name: string
  deviceName?: string
  enabled: boolean
  methods: DetectionMethod[]
  threshold: number
  windowSize: number
  expectedRange?: [number, number]
  minConfidence?: number
  cooldownMs?: number
  seasonality?: SeasonalityPattern
}

export interface AnomalyRuleTemplate {
  uuid: string
  name: string
  category?: string | null
  purpose?: string | null
  methods: DetectionMethod[]
  threshold: number
  window_size: number
  min_confidence?: number | null
  cooldown_ms?: number | null
  seasonality?: SeasonalityPattern | null
  expected_range?: [number, number] | null
}

export interface AnomalyConfig {
  enabled?: boolean
  sensitivity: number
  metrics: AnomalyMetricConfig[]
  alerts: {
    mqtt: boolean
    cloud: boolean
    minConfidence: number
    cooldownMs: number
    maxQueueSize: number
    alertDestinationId?: number
    alertTopic?: string
  }
  storage?: {
    retention: number
    minSamples?: number
    baselineMaxAgeDays?: number
    eventRetentionDays?: number
    incidentRetentionDays?: number
    alertRetentionDays?: number
  }
  warmupPeriodMs?: number
}

export interface AnomalyStats {
  enabled: boolean
  metricsTracked: number
  stateBucketsTracked: number
  alertQueueSize: number
  criticalAlerts: number
  warningAlerts: number
  infoAlerts: number
  inWarmup?: boolean
  warmupRemainingMs?: number
}

export interface AnomalyBaseline {
  metric: string
  device_id: string
  device_state: string
  time_slot: number
  mean: number | null
  std_dev: number | null
  median: number | null
  mad: number | null
  sample_count: number
  calculated_at: number
}

export interface DiscoveryRun {
  id: number
  rule_uuid: string
  rule_name: string
  protocol: string
  trigger: 'scheduled' | 'manual'
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  status: 'running' | 'ok' | 'error'
  found: number
  saved: number
  skipped: number
  error: string | null
  created_at: string
}

export interface DiscoveredDevice {
  protocol: string
  name: string
  fingerprint: string
  connection: Record<string, unknown>
  dataPoints: unknown[]
  confidence: 'low' | 'medium' | 'high'
  discoveredAt: string
  validated: boolean
  metadata?: Record<string, unknown>
}

// ── Agent Settings ────────────────────────────────────────────────────────────

export interface AgentSettingsLogging {
  level?: 'debug' | 'info' | 'warn' | 'error'
  maxLogs?: number
  logMaxAge?: number
  maxLogFileSize?: number
  enableCompression?: boolean
  enableRemoteLogging?: boolean
  enableFilePersistence?: boolean
}

export interface AgentSettingsFeatures {
  enableDeviceJobs?: boolean
  enableAnomalyDetection?: boolean
  enableDeviceRemoteAccess?: boolean
  enableDevicePublish?: boolean
}

export interface AgentSettingsIntervals {
  agent?: {
    reportIntervalMs?: number
    metricsIntervalMs?: number
    reconciliationIntervalMs?: number
    targetStatePollIntervalMs?: number
  }
}

export interface AgentSettingsRuntime {
  memory?: {
    thresholdMb?: number
    checkIntervalMs?: number
  }
}

export interface AgentSettingsInfo {
  uuid: string | null
  name: string | null
  type: string | null
  version: string | null
  provisioned: boolean
  tenantId?: string | null
  apiEndpoint?: string | null
  registeredAt?: number | null
  mqttBrokerUrl?: string | null
  mqttUsername?: string | null
  mqttClientIdPrefix?: string | null
  mqttUseTls?: boolean | null
  macAddress?: string | null
  osVersion?: string | null
  targetSyncEnabled?: boolean
}

export interface AgentSettingsMqttMonitor {
  url?: string
  username?: string
  password?: string
}

export interface AgentSettings {
  agent?: AgentSettingsInfo
  logging?: AgentSettingsLogging
  features?: AgentSettingsFeatures
  intervals?: AgentSettingsIntervals
  runtime?: AgentSettingsRuntime
  anomalyDetection?: Record<string, unknown>
  mqttMonitor?: AgentSettingsMqttMonitor
}

// ── Edge anomaly tracking (events → incidents → alerts) ───────────────────────

export interface EdgeAnomalyEvent {
  id: number
  msg_id: string
  metric: string
  fingerprint: string
  timestamp_ms: number
  observed_value: number
  anomaly_score: number
  confidence: number
  severity: 'info' | 'warning' | 'critical'
  severity_reason?: string
  consecutive_count: number
  device_name: string
  device_type?: string
  created_at: number
}

export interface EdgeAnomalyIncident {
  id: number
  incident_id: string
  fingerprint: string
  metric: string
  severity: 'info' | 'warning' | 'critical'
  device_name: string
  device_type?: string
  first_seen: number
  last_seen: number
  max_anomaly_score: number
  max_confidence: number
  event_count: number
  status: 'open' | 'active' | 'resolved'
  last_alert_at?: number
  created_at: number
  updated_at: number
}

export interface EdgeAnomalyAlert {
  id: number
  alert_id: string
  incident_id: string
  severity: 'info' | 'warning' | 'critical'
  metric: string
  device_name: string
  max_anomaly_score: number
  message: string
  created_at: number
}
