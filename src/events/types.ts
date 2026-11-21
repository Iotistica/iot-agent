export type EventSource = 'anomaly' | 'schema-drift' | 'discovery' | 'memory' | 'adapter' | 'auth' | 'audit' | 'system';
export type EventCategory = 'alert' | 'lifecycle' | 'error' | 'info';
export type EventSeverity = 'info' | 'warning' | 'critical';

export const AUDIT_SOURCES: readonly EventSource[] = ['audit', 'auth'];

export interface AgentEventInput {
	source: EventSource;
	category: EventCategory;
	severity: EventSeverity;
	message: string;
	fingerprint?: string;
	device_name?: string;
	actor?: string;
	resource_type?: string;
	resource_id?: string;
	metadata?: Record<string, unknown>;
}

export interface AgentEventRow {
	id?: number;
	msg_id: string;
	source: EventSource;
	category: EventCategory;
	severity: EventSeverity;
	fingerprint: string;
	message: string;
	device_name?: string | null;
	timestamp_ms: number;
	actor?: string | null;
	resource_type?: string | null;
	resource_id?: string | null;
	metadata?: string | null;
	created_at?: number;
}

export interface AgentIncidentRow {
	id?: number;
	incident_id: string;
	source: EventSource;
	fingerprint: string;
	severity: EventSeverity;
	device_name: string;
	first_seen: number;
	last_seen: number;
	event_count: number;
	status: 'open' | 'active' | 'resolved';
	last_alert_at?: number | null;
	acknowledged_at?: number | null;
	acknowledged_by?: string | null;
	resolution_notes?: string | null;
	resolution_reason?: ResolutionReason | null;
	created_at?: number;
	updated_at?: number;
}

export interface AgentAlertRow {
	id?: number;
	alert_id: string;
	incident_id: string;
	source: EventSource;
	severity: EventSeverity;
	device_name: string;
	message: string;
	created_at?: number;
}

export type ResolutionReason = 'false_positive' | 'true_positive' | 'expected' | 'accepted';
