import crypto from 'node:crypto';
import { createHash } from 'node:crypto';
import { IncidentCorrelator } from './incident-correlator.js';
import { AgentEventModel } from './models/event.model.js';
import { AUDIT_SOURCES, type AgentEventInput } from './types.js';

export class EventBus {
	private correlator: IncidentCorrelator;

	constructor() {
		this.correlator = new IncidentCorrelator();
	}

	start(): void {
		this.correlator.start();
	}

	stop(): void {
		this.correlator.stop();
	}

	submit(event: AgentEventInput): void {
		const fingerprint = event.fingerprint
			?? createHash('sha256').update(`${event.source}:${event.category}:${event.message}`).digest('hex').slice(0, 16);

		const row = {
			msg_id:        crypto.randomUUID(),
			source:        event.source,
			category:      event.category,
			severity:      event.severity,
			fingerprint,
			message:       event.message,
			device_name:   event.device_name,
			timestamp_ms:  Date.now(),
			actor:         event.actor,
			resource_type: event.resource_type,
			resource_id:   event.resource_id,
			metadata:      event.metadata,
		};

		if (AUDIT_SOURCES.includes(event.source)) {
			AgentEventModel.insert(row);
			return;
		}

		this.correlator.processEvent(row);
	}
}
