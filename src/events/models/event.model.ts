import crypto from 'node:crypto';
import { getDatabase } from '../../db/sqlite.js';
import type { AgentEventRow, EventSource } from '../types.js';

export interface AgentEventInsert {
	msg_id?: string;
	source: string;
	category: string;
	severity: string;
	fingerprint: string;
	message: string;
	device_name?: string;
	timestamp_ms: number;
	actor?: string;
	resource_type?: string;
	resource_id?: string;
	metadata?: Record<string, unknown>;
}

export class AgentEventModel {
	static insert(payload: AgentEventInsert): void {
		const db = getDatabase();
		const msg_id = payload.msg_id ?? crypto.randomUUID();
		db.prepare(`
			INSERT OR IGNORE INTO agent_events
				(msg_id, source, category, severity, fingerprint, message,
				 device_name, timestamp_ms, actor, resource_type, resource_id, metadata)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			msg_id,
			payload.source,
			payload.category,
			payload.severity,
			payload.fingerprint,
			payload.message,
			payload.device_name ?? null,
			payload.timestamp_ms,
			payload.actor ?? null,
			payload.resource_type ?? null,
			payload.resource_id ?? null,
			payload.metadata ? JSON.stringify(payload.metadata) : null,
		);
	}

	static list(filters: {
		source?: EventSource | EventSource[];
		fingerprint?: string;
		severity?: string;
		from?: number;
		to?: number;
		limit?: number;
		offset?: number;
	} = {}): { events: AgentEventRow[]; total: number } {
		const db = getDatabase();
		const where: string[] = [];
		const args: (string | number | null)[] = [];

		if (filters.source) {
			const sources = Array.isArray(filters.source) ? filters.source : [filters.source];
			where.push(`source IN (${sources.map(() => '?').join(',')})`);
			args.push(...sources);
		}
		if (filters.fingerprint) { where.push('fingerprint = ?'); args.push(filters.fingerprint); }
		if (filters.severity)    { where.push('severity = ?');    args.push(filters.severity); }
		if (filters.from != null){ where.push('timestamp_ms >= ?'); args.push(filters.from); }
		if (filters.to   != null){ where.push('timestamp_ms <= ?'); args.push(filters.to); }

		const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
		const total = (db.prepare(`SELECT COUNT(*) as n FROM agent_events ${clause}`)
			.get(...args) as unknown as { n: number }).n;

		const limit  = Math.min(filters.limit  ?? 50, 500);
		const offset = filters.offset ?? 0;
		const events = db.prepare(
			`SELECT * FROM agent_events ${clause} ORDER BY timestamp_ms DESC LIMIT ? OFFSET ?`
		).all(...args, limit, offset) as unknown as AgentEventRow[];

		return { events, total };
	}

	static getById(id: number): AgentEventRow | null {
		return (getDatabase().prepare(`SELECT * FROM agent_events WHERE id = ?`).get(id) as unknown as AgentEventRow) ?? null;
	}
}
