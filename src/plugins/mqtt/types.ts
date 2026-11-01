/**
 * MQTT Protocol Types
 */

export interface MqttBrokerConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface MqttReconnectConfig {
  period: number;
  maxAttempts: number;
  strategy?: 'fixed' | 'exponential';
  maxPeriod?: number;
  jitterRatio?: number;
}

export interface MqttMetricConfig {
  field: string; // Field path in payload (supports dot notation)
  metric: string;
  unit?: string;
  type?: string;
  precision?: number;
}

export interface MqttDevice {
  name: string;
  /** Optional human-readable label. When set, overrides the raw config name in payloads. */
  displayName?: string;
  enabled: boolean;
  uuid?: string;
  baseTopic: string;  // Device-level topic prefix (e.g., 'factory/sim-001')
  subscriptionTopic: string;  // Computed: baseTopic/# — what the broker subscribes to
  qos?: 0 | 1 | 2;
  deviceId?: string;
  timestampField?: string;
  metrics?: MqttMetricConfig[];
  autoMetrics?: boolean;
  defaultUnits?: Record<string, string>;
  defaultPrecisions?: Record<string, number>;
  allowArrayMetrics?: boolean;
  subTopicDataTypes?: Record<string, string>;

  // Backward compat — legacy per-topic fields read by adapter when baseTopic is absent
  /** @deprecated Use baseTopic instead */
  topic?: string;
  /** @deprecated Data type is now per sub-topic in data_points */
  dataType?: string;
  /** @deprecated Unit is now per data-point, not per-device */
  unit?: string;
  /** @deprecated Precision is now per data-point, not per-device */
  precision?: number;
  /** @deprecated Metric name is now per data-point, not per-device */
  metric?: string;
}

export interface MqttAdapterConfig {
  broker: MqttBrokerConfig;
  qos: 0 | 1 | 2;
  reconnect: MqttReconnectConfig;
  devices: MqttDevice[];
  logging?: {
    level: string;
    enableConsole: boolean;
    enableFile: boolean;
  };
}
