import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { AnomalyEventModel } from '../db/models/anomaly-event.model.js';
import { AnomalyIncidentModel } from '../db/models/anomaly-incident.model.js';
import type { ResolutionReason } from '../db/models/anomaly-incident.model.js';
import { AnomalyAlertModel } from '../db/models/anomaly-alert.model.js';

export const anomalyRouter = express.Router();

const VALID_RESOLUTION_REASONS: ResolutionReason[] = ['false_positive', 'true_positive', 'expected', 'accepted'];

// ── Events ────────────────────────────────────────────────────────────────────

anomalyRouter.get('/v1/anomaly-events', (req: Request, res: Response, next: NextFunction) => {
	try {
		const result = AnomalyEventModel.list({
			fingerprint: req.query.fingerprint as string | undefined,
			severity:    req.query.severity    as string | undefined,
			from:  req.query.from  ? Number(req.query.from)   : undefined,
			to:    req.query.to    ? Number(req.query.to)     : undefined,
			limit: req.query.limit ? Number(req.query.limit)  : undefined,
			offset:req.query.offset? Number(req.query.offset) : undefined,
		});
		res.json(result);
	} catch (err) {
		next(err);
	}
});

// ── Incidents ─────────────────────────────────────────────────────────────────

anomalyRouter.get('/v1/anomaly-incidents/stats', (req: Request, res: Response, next: NextFunction) => {
	try {
		const windowHours = req.query.windowHours ? Number(req.query.windowHours) : 24;
		const stats = AnomalyIncidentModel.stats(windowHours * 60 * 60 * 1000);
		res.json(stats);
	} catch (err) {
		next(err);
	}
});

anomalyRouter.get('/v1/anomaly-incidents/bad-actors', (req: Request, res: Response, next: NextFunction) => {
	try {
		const windowDays = req.query.windowDays ? Number(req.query.windowDays) : 30;
		const limit = req.query.limit ? Number(req.query.limit) : 20;
		const badActors = AnomalyIncidentModel.badActors(windowDays * 24 * 60 * 60 * 1000, limit);
		res.json({ badActors, windowDays });
	} catch (err) {
		next(err);
	}
});

anomalyRouter.get('/v1/anomaly-incidents', (req: Request, res: Response, next: NextFunction) => {
	try {
		const result = AnomalyIncidentModel.list({
			status:   req.query.status   as string | undefined,
			severity: req.query.severity as string | undefined,
			from:  req.query.from  ? Number(req.query.from)   : undefined,
			to:    req.query.to    ? Number(req.query.to)     : undefined,
			limit: req.query.limit ? Number(req.query.limit)  : undefined,
			offset:req.query.offset? Number(req.query.offset) : undefined,
		});
		res.json(result);
	} catch (err) {
		next(err);
	}
});

anomalyRouter.get('/v1/anomaly-incidents/:incidentId', (req: Request, res: Response, next: NextFunction) => {
	try {
		const incident = AnomalyIncidentModel.getById(req.params.incidentId);
		if (!incident) return res.status(404).json({ error: 'Incident not found' });

		const alerts = AnomalyAlertModel.getByIncidentId(req.params.incidentId);
		const recentEvents = AnomalyEventModel.list({ fingerprint: incident.fingerprint, limit: 20 });
		res.json({ ...incident, alerts, recentEvents: recentEvents.events });
	} catch (err) {
		next(err);
	}
});

anomalyRouter.patch('/v1/anomaly-incidents/:incidentId/resolve', (req: Request, res: Response, next: NextFunction) => {
	try {
		const { resolvedBy = 'local-user', notes, reason } = req.body ?? {};
		if (reason !== undefined && !VALID_RESOLUTION_REASONS.includes(reason)) {
			return res.status(400).json({ error: `reason must be one of: ${VALID_RESOLUTION_REASONS.join(', ')}` });
		}
		const ok = AnomalyIncidentModel.resolve(req.params.incidentId, resolvedBy, notes, reason);
		if (!ok) return res.status(404).json({ error: 'Incident not found or already resolved' });
		const updated = AnomalyIncidentModel.getById(req.params.incidentId);
		res.json(updated);
	} catch (err) {
		next(err);
	}
});

// ── Alerts ────────────────────────────────────────────────────────────────────

anomalyRouter.get('/v1/anomaly-alerts', (req: Request, res: Response, next: NextFunction) => {
	try {
		const result = AnomalyAlertModel.list({
			severity: req.query.severity as string | undefined,
			from:  req.query.from  ? Number(req.query.from)   : undefined,
			to:    req.query.to    ? Number(req.query.to)     : undefined,
			limit: req.query.limit ? Number(req.query.limit)  : undefined,
			offset:req.query.offset? Number(req.query.offset) : undefined,
		});
		res.json(result);
	} catch (err) {
		next(err);
	}
});

anomalyRouter.get('/v1/anomaly-alerts/:alertId', (req: Request, res: Response, next: NextFunction) => {
	try {
		const alert = AnomalyAlertModel.getById(req.params.alertId);
		if (!alert) return res.status(404).json({ error: 'Alert not found' });

		const incident = AnomalyIncidentModel.getById(alert.incident_id);
		res.json({ ...alert, incident });
	} catch (err) {
		next(err);
	}
});
