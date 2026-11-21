// Shared formatting helpers — event/incident/alert routes moved to api/events.ts.

const SYSTEM_METRIC_UUID_PREFIX_RE = /^[0-9a-f-]{36}_(?:[0-9a-f-]{36}_|system_)/i;
export function stripMetricUuidPrefix(metric: string): string {
	return metric.replace(SYSTEM_METRIC_UUID_PREFIX_RE, '');
}
