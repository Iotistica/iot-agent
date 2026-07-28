import { getDatabase } from '../sqlite.js';

export interface ProtocolAlarmRow {
	id?: number;
	protocol: string;
	condition_id: string;
	event_type: string;
	device_name: string;
	message: string;
	severity: number;
	active: number;
	opened_at?: string;
	cleared_at?: string | null;
	created_at?: string;
}

export class ProtocolAlarmModel {
	static insert(row: { protocol: string; condition_id: string; event_type: string; device_name: string; message: string; severity: number }): ProtocolAlarmRow {
		const db = getDatabase();
		db.prepare(`
			INSERT INTO protocol_alarms (protocol, condition_id, event_type, device_name, message, severity, active)
			VALUES (?, ?, ?, ?, ?, ?, 1)
		`).run(row.protocol, row.condition_id, row.event_type, row.device_name, row.message, row.severity);
		return db.prepare(`SELECT * FROM protocol_alarms WHERE protocol = ? AND condition_id = ? ORDER BY id DESC LIMIT 1`)
			.get(row.protocol, row.condition_id) as unknown as ProtocolAlarmRow;
	}

	static markCleared(protocol: string, conditionId: string): void {
		getDatabase().prepare(`
			UPDATE protocol_alarms
			SET active = 0, cleared_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			WHERE protocol = ? AND condition_id = ? AND active = 1
		`).run(protocol, conditionId);
	}

	static getActive(protocol?: string): ProtocolAlarmRow[] {
		const db = getDatabase();
		if (protocol) {
			return db.prepare(
				`SELECT * FROM protocol_alarms WHERE active = 1 AND protocol = ? ORDER BY opened_at DESC`
			).all(protocol) as unknown as ProtocolAlarmRow[];
		}
		return db.prepare(
			`SELECT * FROM protocol_alarms WHERE active = 1 ORDER BY opened_at DESC`
		).all() as unknown as ProtocolAlarmRow[];
	}
}
