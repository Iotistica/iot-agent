import { getDatabase } from '../../db/sqlite.js';
import type { AgentIncidentRow, EventSource, ResolutionReason } from '../types.js';

export class AgentIncidentModel {
	static create(row: Omit<AgentIncidentRow, 'id' | 'created_at' | 'updated_at'>): AgentIncidentRow {
		const db = getDatabase();
		db.prepare(`
			INSERT INTO agent_incidents
				(incident_id, source, fingerprint, severity, device_name,
				 first_seen, last_seen, event_count, status)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			row.incident_id,
			row.source,
			row.fingerprint,
			row.severity,
			row.device_name,
			row.first_seen,
			row.last_seen,
			row.event_count,
			row.status,
		);
		return db.prepare(`SELECT * FROM agent_incidents WHERE incident_id = ?`).get(row.incident_id) as unknown as AgentIncidentRow;
	}

	static findActiveByFingerprint(fingerprint: string): AgentIncidentRow | null {
		return (getDatabase().prepare(`
			SELECT * FROM agent_incidents
			WHERE fingerprint = ? AND status IN ('open', 'active')
			ORDER BY created_at DESC LIMIT 1
		`).get(fingerprint) as unknown as AgentIncidentRow) ?? null;
	}

	static updateByEvent(incidentId: string, params: {
		last_seen: number;
		event_count: number;
		severity: 'info' | 'warning' | 'critical';
		status: 'open' | 'active' | 'resolved';
	}): void {
		getDatabase().prepare(`
			UPDATE agent_incidents
			SET last_seen = ?, event_count = ?, severity = ?, status = ?, updated_at = ?
			WHERE incident_id = ?
		`).run(
			params.last_seen,
			params.event_count,
			params.severity,
			params.status,
			Date.now(),
			incidentId,
		);
	}

	static setLastAlertAt(incidentId: string, ts: number): void {
		getDatabase().prepare(`
			UPDATE agent_incidents SET last_alert_at = ?, updated_at = ? WHERE incident_id = ?
		`).run(ts, Date.now(), incidentId);
	}

	static resolve(incidentId: string, resolvedBy: string, notes?: string, reason?: ResolutionReason): boolean {
		const info = getDatabase().prepare(`
			UPDATE agent_incidents
			SET status = 'resolved', acknowledged_at = ?, acknowledged_by = ?,
			    resolution_notes = ?, resolution_reason = ?, updated_at = ?
			WHERE incident_id = ? AND status != 'resolved'
		`).run(Date.now(), resolvedBy, notes ?? null, reason ?? null, Date.now(), incidentId);
		return Number(info.changes) > 0;
	}

	static autoResolveStale(cutoffMs: number): number {
		const info = getDatabase().prepare(`
			UPDATE agent_incidents
			SET status = 'resolved', updated_at = ?
			WHERE status IN ('open', 'active') AND last_seen < ?
		`).run(Date.now(), cutoffMs);
		return Number(info.changes);
	}

	static getById(incidentId: string): AgentIncidentRow | null {
		return (getDatabase().prepare(`SELECT * FROM agent_incidents WHERE incident_id = ?`)
			.get(incidentId) as unknown as AgentIncidentRow) ?? null;
	}

	static list(filters: {
		source?: EventSource | EventSource[];
		status?: string;
		severity?: string;
		from?: number;
		to?: number;
		limit?: number;
		offset?: number;
	} = {}): { incidents: AgentIncidentRow[]; total: number } {
		const db = getDatabase();
		const where: string[] = [];
		const args: (string | number | null)[] = [];

		if (filters.source) {
			const sources = Array.isArray(filters.source) ? filters.source : [filters.source];
			where.push(`source IN (${sources.map(() => '?').join(',')})`);
			args.push(...sources);
		}
		if (filters.status)      { where.push('status = ?');     args.push(filters.status); }
		if (filters.severity)    { where.push('severity = ?');   args.push(filters.severity); }
		if (filters.from != null){ where.push('first_seen >= ?'); args.push(filters.from); }
		if (filters.to   != null){ where.push('first_seen <= ?'); args.push(filters.to); }

		const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
		const total = (db.prepare(`SELECT COUNT(*) as n FROM agent_incidents ${clause}`)
			.get(...args) as unknown as { n: number }).n;

		const limit  = Math.min(filters.limit  ?? 50, 500);
		const offset = filters.offset ?? 0;
		const incidents = db.prepare(
			`SELECT * FROM agent_incidents ${clause} ORDER BY first_seen DESC LIMIT ? OFFSET ?`
		).all(...args, limit, offset) as unknown as AgentIncidentRow[];

		return { incidents, total };
	}

	static badActors(filters: {
		source?: EventSource | EventSource[];
		windowMs: number;
		limit?: number;
	}): Array<{
		fingerprint: string;
		device_name: string;
		incident_count: number;
		total_events: number;
		critical_count: number;
		warning_count: number;
		info_count: number;
		open_count: number;
		resolved_count: number;
		false_positive_count: number;
		true_positive_count: number;
		expected_count: number;
		accepted_count: number;
		unclassified_resolved_count: number;
		last_seen: number;
	}> {
		const db = getDatabase();
		const cutoff = Date.now() - filters.windowMs;
		const where: string[] = ['first_seen >= ?'];
		const args: (string | number)[] = [cutoff];

		if (filters.source) {
			const sources = Array.isArray(filters.source) ? filters.source : [filters.source];
			where.push(`source IN (${sources.map(() => '?').join(',')})`);
			args.push(...sources);
		}

		const clause = where.join(' AND ');
		const limit = filters.limit ?? 20;

		return db.prepare(`
			SELECT
				fingerprint,
				device_name,
				COUNT(*) as incident_count,
				SUM(event_count) as total_events,
				SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical_count,
				SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) as warning_count,
				SUM(CASE WHEN severity = 'info' THEN 1 ELSE 0 END) as info_count,
				SUM(CASE WHEN status != 'resolved' THEN 1 ELSE 0 END) as open_count,
				SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved_count,
				SUM(CASE WHEN resolution_reason = 'false_positive' THEN 1 ELSE 0 END) as false_positive_count,
				SUM(CASE WHEN resolution_reason = 'true_positive' THEN 1 ELSE 0 END) as true_positive_count,
				SUM(CASE WHEN resolution_reason = 'expected' THEN 1 ELSE 0 END) as expected_count,
				SUM(CASE WHEN resolution_reason = 'accepted' THEN 1 ELSE 0 END) as accepted_count,
				SUM(CASE WHEN status = 'resolved' AND resolution_reason IS NULL THEN 1 ELSE 0 END) as unclassified_resolved_count,
				MAX(last_seen) as last_seen
			FROM agent_incidents
			WHERE ${clause}
			GROUP BY fingerprint, device_name
			ORDER BY incident_count DESC
			LIMIT ?
		`).all(...args, limit) as unknown as Array<{
			fingerprint: string; device_name: string; incident_count: number; total_events: number;
			critical_count: number; warning_count: number; info_count: number;
			open_count: number; resolved_count: number;
			false_positive_count: number; true_positive_count: number; expected_count: number;
			accepted_count: number; unclassified_resolved_count: number; last_seen: number;
		}>;
	}

	static stats(filters: {
		source?: EventSource | EventSource[];
		windowMs: number;
	}): {
		open: number; active: number; resolved: number; total: number;
		critical: number; warning: number; info: number;
	} {
		const db = getDatabase();
		const cutoff = Date.now() - filters.windowMs;
		const where: string[] = ['first_seen >= ?'];
		const args: (string | number)[] = [cutoff];

		if (filters.source) {
			const sources = Array.isArray(filters.source) ? filters.source : [filters.source];
			where.push(`source IN (${sources.map(() => '?').join(',')})`);
			args.push(...sources);
		}

		const clause = where.join(' AND ');
		const rows = db.prepare(`
			SELECT status, severity, COUNT(*) as n
			FROM agent_incidents
			WHERE ${clause}
			GROUP BY status, severity
		`).all(...args) as { status: string; severity: string; n: number }[];

		const result = { open: 0, active: 0, resolved: 0, total: 0, critical: 0, warning: 0, info: 0 };
		for (const r of rows) {
			if (r.status in result) (result as any)[r.status] += r.n;
			if (r.severity in result) (result as any)[r.severity] += r.n;
		}
		result.total = result.open + result.active + result.resolved;
		return result;
	}
}
