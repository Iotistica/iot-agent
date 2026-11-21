import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { AgentEventModel } from '../events/models/event.model.js';
import { AgentIncidentModel } from '../events/models/incident.model.js';
import { AgentAlertModel } from '../events/models/alert.model.js';
import type { EventSource, ResolutionReason } from '../events/types.js';
import { requireRole } from './middleware/roles.js';
import { prettifyDriftDeviceId } from '../db/models/drift-labels.js';

export const eventsRouter = express.Router();

const VALID_RESOLUTION_REASONS: ResolutionReason[] = ['false_positive', 'true_positive', 'expected', 'accepted'];
const ANOMALY_SOURCES: EventSource[] = ['anomaly', 'schema-drift'];

const DEVICE_UUID_SUFFIX_RE = /-[0-9a-f]{8}$/i;
function stripDeviceUuidSuffix(deviceName: string): string {
	return deviceName.replace(DEVICE_UUID_SUFFIX_RE, '');
}

function withPrettyDeviceName<T extends { device_name?: string | null }>(record: T): T {
	return {
		...record,
		device_name: record.device_name
			? prettifyDriftDeviceId(stripDeviceUuidSuffix(record.device_name))
			: record.device_name,
	};
}

function parseSources(raw: string | undefined): EventSource[] | undefined {
	if (!raw) return undefined;
	return raw.split(',').map(s => s.trim()) as EventSource[];
}

// ── Events ────────────────────────────────────────────────────────────────────

eventsRouter.get('/v1/events', (req: Request, res: Response, next: NextFunction) => {
	try {
		const result = AgentEventModel.list({
			source:      parseSources(req.query.source as string | undefined),
			fingerprint: req.query.fingerprint as string | undefined,
			severity:    req.query.severity    as string | undefined,
			from:  req.query.from  ? Number(req.query.from)   : undefined,
			to:    req.query.to    ? Number(req.query.to)     : undefined,
			limit: req.query.limit ? Number(req.query.limit)  : undefined,
			offset:req.query.offset? Number(req.query.offset) : undefined,
		});
		res.json({ ...result, events: result.events.map(withPrettyDeviceName) });
	} catch (err) {
		next(err);
	}
});

// ── Incidents ─────────────────────────────────────────────────────────────────

eventsRouter.get('/v1/incidents/stats', (req: Request, res: Response, next: NextFunction) => {
	try {
		const windowHours = req.query.windowHours ? Number(req.query.windowHours) : 24;
		const stats = AgentIncidentModel.stats({
			source: parseSources(req.query.source as string | undefined),
			windowMs: windowHours * 60 * 60 * 1000,
		});
		res.json(stats);
	} catch (err) {
		next(err);
	}
});

eventsRouter.get('/v1/incidents/bad-actors', (req: Request, res: Response, next: NextFunction) => {
	try {
		const windowDays = req.query.windowDays ? Number(req.query.windowDays) : 30;
		const limit = req.query.limit ? Number(req.query.limit) : 20;
		const badActors = AgentIncidentModel.badActors({
			source: parseSources(req.query.source as string | undefined),
			windowMs: windowDays * 24 * 60 * 60 * 1000,
			limit,
		});
		res.json({ badActors: badActors.map(withPrettyDeviceName), windowDays });
	} catch (err) {
		next(err);
	}
});

eventsRouter.get('/v1/incidents', (req: Request, res: Response, next: NextFunction) => {
	try {
		const result = AgentIncidentModel.list({
			source:   parseSources(req.query.source as string | undefined),
			status:   req.query.status   as string | undefined,
			severity: req.query.severity as string | undefined,
			from:  req.query.from  ? Number(req.query.from)   : undefined,
			to:    req.query.to    ? Number(req.query.to)     : undefined,
			limit: req.query.limit ? Number(req.query.limit)  : undefined,
			offset:req.query.offset? Number(req.query.offset) : undefined,
		});
		res.json({ ...result, incidents: result.incidents.map(withPrettyDeviceName) });
	} catch (err) {
		next(err);
	}
});

eventsRouter.get('/v1/incidents/:incidentId', (req: Request, res: Response, next: NextFunction) => {
	try {
		const incident = AgentIncidentModel.getById(req.params.incidentId);
		if (!incident) return res.status(404).json({ error: 'Incident not found' });

		const alerts = AgentAlertModel.getByIncidentId(req.params.incidentId);
		const recentEvents = AgentEventModel.list({ fingerprint: incident.fingerprint, limit: 20 });
		res.json({
			...withPrettyDeviceName(incident),
			alerts: alerts.map(withPrettyDeviceName),
			recentEvents: recentEvents.events.map(withPrettyDeviceName),
		});
	} catch (err) {
		next(err);
	}
});

eventsRouter.patch('/v1/incidents/:incidentId/resolve', requireRole('operator'), (req: Request, res: Response, next: NextFunction) => {
	try {
		const { resolvedBy = 'local-user', notes, reason } = req.body ?? {};
		if (reason !== undefined && !VALID_RESOLUTION_REASONS.includes(reason)) {
			return res.status(400).json({ error: `reason must be one of: ${VALID_RESOLUTION_REASONS.join(', ')}` });
		}
		const ok = AgentIncidentModel.resolve(req.params.incidentId, resolvedBy, notes, reason);
		if (!ok) return res.status(404).json({ error: 'Incident not found or already resolved' });
		const updated = AgentIncidentModel.getById(req.params.incidentId);
		res.json(updated);
	} catch (err) {
		next(err);
	}
});

// ── Alerts ────────────────────────────────────────────────────────────────────

eventsRouter.get('/v1/alerts', (req: Request, res: Response, next: NextFunction) => {
	try {
		const result = AgentAlertModel.list({
			source:   parseSources(req.query.source as string | undefined),
			severity: req.query.severity as string | undefined,
			from:  req.query.from  ? Number(req.query.from)   : undefined,
			to:    req.query.to    ? Number(req.query.to)     : undefined,
			limit: req.query.limit ? Number(req.query.limit)  : undefined,
			offset:req.query.offset? Number(req.query.offset) : undefined,
		});
		res.json({ ...result, alerts: result.alerts.map(withPrettyDeviceName) });
	} catch (err) {
		next(err);
	}
});

eventsRouter.get('/v1/alerts/:alertId', (req: Request, res: Response, next: NextFunction) => {
	try {
		const alert = AgentAlertModel.getById(req.params.alertId);
		if (!alert) return res.status(404).json({ error: 'Alert not found' });

		const incident = AgentIncidentModel.getById(alert.incident_id);
		res.json({
			...withPrettyDeviceName(alert),
			incident: incident ? withPrettyDeviceName(incident) : incident,
		});
	} catch (err) {
		next(err);
	}
});

// ── Backward-compatible aliases for the anomaly frontend ─────────────────────

eventsRouter.get('/v1/anomaly-events', (req: Request, res: Response, next: NextFunction) => {
	req.query.source = ANOMALY_SOURCES.join(',');
	const result = AgentEventModel.list({
		source:      ANOMALY_SOURCES,
		fingerprint: req.query.fingerprint as string | undefined,
		severity:    req.query.severity    as string | undefined,
		from:  req.query.from  ? Number(req.query.from)   : undefined,
		to:    req.query.to    ? Number(req.query.to)     : undefined,
		limit: req.query.limit ? Number(req.query.limit)  : undefined,
		offset:req.query.offset? Number(req.query.offset) : undefined,
	});
	res.json({ ...result, events: result.events.map(withPrettyDeviceName) });
});

eventsRouter.get('/v1/anomaly-incidents/stats', (req: Request, res: Response, next: NextFunction) => {
	try {
		const windowHours = req.query.windowHours ? Number(req.query.windowHours) : 24;
		const stats = AgentIncidentModel.stats({
			source: ANOMALY_SOURCES,
			windowMs: windowHours * 60 * 60 * 1000,
		});
		res.json(stats);
	} catch (err) {
		next(err);
	}
});

eventsRouter.get('/v1/anomaly-incidents/bad-actors', (req: Request, res: Response, next: NextFunction) => {
	try {
		const windowDays = req.query.windowDays ? Number(req.query.windowDays) : 30;
		const limit = req.query.limit ? Number(req.query.limit) : 20;
		const badActors = AgentIncidentModel.badActors({
			source: ANOMALY_SOURCES,
			windowMs: windowDays * 24 * 60 * 60 * 1000,
			limit,
		});
		res.json({ badActors: badActors.map(withPrettyDeviceName), windowDays });
	} catch (err) {
		next(err);
	}
});

eventsRouter.get('/v1/anomaly-incidents', (req: Request, res: Response, next: NextFunction) => {
	try {
		const result = AgentIncidentModel.list({
			source:   ANOMALY_SOURCES,
			status:   req.query.status   as string | undefined,
			severity: req.query.severity as string | undefined,
			from:  req.query.from  ? Number(req.query.from)   : undefined,
			to:    req.query.to    ? Number(req.query.to)     : undefined,
			limit: req.query.limit ? Number(req.query.limit)  : undefined,
			offset:req.query.offset? Number(req.query.offset) : undefined,
		});
		res.json({ ...result, incidents: result.incidents.map(withPrettyDeviceName) });
	} catch (err) {
		next(err);
	}
});

eventsRouter.get('/v1/anomaly-incidents/:incidentId', (req: Request, res: Response, next: NextFunction) => {
	try {
		const incident = AgentIncidentModel.getById(req.params.incidentId);
		if (!incident) return res.status(404).json({ error: 'Incident not found' });

		const alerts = AgentAlertModel.getByIncidentId(req.params.incidentId);
		const recentEvents = AgentEventModel.list({ fingerprint: incident.fingerprint, limit: 20 });
		res.json({
			...withPrettyDeviceName(incident),
			alerts: alerts.map(withPrettyDeviceName),
			recentEvents: recentEvents.events.map(withPrettyDeviceName),
		});
	} catch (err) {
		next(err);
	}
});

eventsRouter.patch('/v1/anomaly-incidents/:incidentId/resolve', requireRole('operator'), (req: Request, res: Response, next: NextFunction) => {
	try {
		const { resolvedBy = 'local-user', notes, reason } = req.body ?? {};
		if (reason !== undefined && !VALID_RESOLUTION_REASONS.includes(reason)) {
			return res.status(400).json({ error: `reason must be one of: ${VALID_RESOLUTION_REASONS.join(', ')}` });
		}
		const ok = AgentIncidentModel.resolve(req.params.incidentId, resolvedBy, notes, reason);
		if (!ok) return res.status(404).json({ error: 'Incident not found or already resolved' });
		const updated = AgentIncidentModel.getById(req.params.incidentId);
		res.json(updated);
	} catch (err) {
		next(err);
	}
});

eventsRouter.get('/v1/anomaly-alerts', (req: Request, res: Response, next: NextFunction) => {
	try {
		const result = AgentAlertModel.list({
			source:   ANOMALY_SOURCES,
			severity: req.query.severity as string | undefined,
			from:  req.query.from  ? Number(req.query.from)   : undefined,
			to:    req.query.to    ? Number(req.query.to)     : undefined,
			limit: req.query.limit ? Number(req.query.limit)  : undefined,
			offset:req.query.offset? Number(req.query.offset) : undefined,
		});
		res.json({ ...result, alerts: result.alerts.map(withPrettyDeviceName) });
	} catch (err) {
		next(err);
	}
});

eventsRouter.get('/v1/anomaly-alerts/:alertId', (req: Request, res: Response, next: NextFunction) => {
	try {
		const alert = AgentAlertModel.getById(req.params.alertId);
		if (!alert) return res.status(404).json({ error: 'Alert not found' });

		const incident = AgentIncidentModel.getById(alert.incident_id);
		res.json({
			...withPrettyDeviceName(alert),
			incident: incident ? withPrettyDeviceName(incident) : incident,
		});
	} catch (err) {
		next(err);
	}
});
