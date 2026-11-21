import { getDatabase } from '../../db/sqlite.js';
import type { AgentAlertRow, EventSource } from '../types.js';

export class AgentAlertModel {
	static insert(row: Omit<AgentAlertRow, 'id' | 'created_at'>): AgentAlertRow {
		const db = getDatabase();
		db.prepare(`
			INSERT INTO agent_alerts
				(alert_id, incident_id, source, severity, device_name, message)
			VALUES (?, ?, ?, ?, ?, ?)
		`).run(
			row.alert_id,
			row.incident_id,
			row.source,
			row.severity,
			row.device_name,
			row.message,
		);
		return db.prepare(`SELECT * FROM agent_alerts WHERE alert_id = ?`).get(row.alert_id) as unknown as AgentAlertRow;
	}

	static getById(alertId: string): AgentAlertRow | null {
		return (getDatabase().prepare(`SELECT * FROM agent_alerts WHERE alert_id = ?`)
			.get(alertId) as unknown as AgentAlertRow) ?? null;
	}

	static getByIncidentId(incidentId: string): AgentAlertRow[] {
		return getDatabase().prepare(
			`SELECT * FROM agent_alerts WHERE incident_id = ? ORDER BY created_at DESC`
		).all(incidentId) as unknown as AgentAlertRow[];
	}

	static list(filters: {
		source?: EventSource | EventSource[];
		severity?: string;
		from?: number;
		to?: number;
		limit?: number;
		offset?: number;
	} = {}): { alerts: AgentAlertRow[]; total: number } {
		const db = getDatabase();
		const where: string[] = [];
		const args: (string | number | null)[] = [];

		if (filters.source) {
			const sources = Array.isArray(filters.source) ? filters.source : [filters.source];
			where.push(`source IN (${sources.map(() => '?').join(',')})`);
			args.push(...sources);
		}
		if (filters.severity)    { where.push('severity = ?');    args.push(filters.severity); }
		if (filters.from != null){ where.push('created_at >= ?'); args.push(filters.from); }
		if (filters.to   != null){ where.push('created_at <= ?'); args.push(filters.to); }

		const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
		const total = (db.prepare(`SELECT COUNT(*) as n FROM agent_alerts ${clause}`)
			.get(...args) as unknown as { n: number }).n;

		const limit  = Math.min(filters.limit  ?? 50, 500);
		const offset = filters.offset ?? 0;
		const alerts = db.prepare(
			`SELECT * FROM agent_alerts ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
		).all(...args, limit, offset) as unknown as AgentAlertRow[];

		return { alerts, total };
	}
}
