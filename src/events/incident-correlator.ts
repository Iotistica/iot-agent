import crypto from 'node:crypto';
import { AgentEventModel } from './models/event.model.js';
import type { AgentEventInsert } from './models/event.model.js';
import { AgentIncidentModel } from './models/incident.model.js';
import { AgentAlertModel } from './models/alert.model.js';
import type { EventSource } from './types.js';

const ACTIVE_THRESHOLD   = 3;
const SILENCE_WINDOW_MS  = 30 * 60 * 1000;
const ALERT_COOLDOWN_MS  = 60 * 60 * 1000;
const STALE_CHECK_MS     = 5  * 60 * 1000;

const ALERT_THRESHOLDS: Record<string, number> = {
	critical: 1,
	warning:  3,
	info:     5,
};

const SEVERITY_RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 };

function escalateSeverity(
	current: 'info' | 'warning' | 'critical',
	incoming: 'info' | 'warning' | 'critical',
): 'info' | 'warning' | 'critical' {
	return (SEVERITY_RANK[incoming] ?? 0) > (SEVERITY_RANK[current] ?? 0) ? incoming : current;
}

export class IncidentCorrelator {
	private timer?: ReturnType<typeof setInterval>;

	start(): void {
		this.timer = setInterval(() => this.checkSilentResolutions(), STALE_CHECK_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	processEvent(event: AgentEventInsert): void {
		if (!event.fingerprint) return;

		AgentEventModel.insert(event);

		let incident = AgentIncidentModel.findActiveByFingerprint(event.fingerprint);

		if (!incident) {
			incident = AgentIncidentModel.create({
				incident_id: crypto.randomUUID(),
				source:      event.source as EventSource,
				fingerprint: event.fingerprint,
				severity:    event.severity as 'info' | 'warning' | 'critical',
				device_name: event.device_name ?? 'Unknown',
				first_seen:  event.timestamp_ms,
				last_seen:   event.timestamp_ms,
				event_count: 1,
				status:      'open',
			});
		} else {
			const newCount    = incident.event_count + 1;
			const newSeverity = escalateSeverity(
				incident.severity,
				event.severity as 'info' | 'warning' | 'critical',
			);
			const newStatus   = newCount >= ACTIVE_THRESHOLD ? 'active' : incident.status;

			AgentIncidentModel.updateByEvent(incident.incident_id, {
				last_seen:   event.timestamp_ms,
				event_count: newCount,
				severity:    newSeverity,
				status:      newStatus,
			});

			incident = {
				...incident,
				event_count: newCount,
				severity:    newSeverity,
				status:      newStatus,
			};
		}

		this.maybePromote(incident, event);
	}

	private maybePromote(
		incident: NonNullable<ReturnType<typeof AgentIncidentModel.findActiveByFingerprint>>,
		event: AgentEventInsert,
	): void {
		const threshold = ALERT_THRESHOLDS[incident.severity] ?? 3;
		if (incident.event_count < threshold) return;

		const now = Date.now();
		if (incident.last_alert_at && (now - incident.last_alert_at) < ALERT_COOLDOWN_MS) return;

		AgentAlertModel.insert({
			alert_id:    crypto.randomUUID(),
			incident_id: incident.incident_id,
			source:      incident.source,
			severity:    incident.severity,
			device_name: incident.device_name,
			message:     event.message,
		});

		AgentIncidentModel.setLastAlertAt(incident.incident_id, now);
	}

	private checkSilentResolutions(): void {
		const cutoff = Date.now() - SILENCE_WINDOW_MS;
		AgentIncidentModel.autoResolveStale(cutoff);
	}
}
