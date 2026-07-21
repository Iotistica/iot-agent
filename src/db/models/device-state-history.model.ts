import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../sqlite.js';

export interface DeviceStateHistoryRecord {
	device_key: string;
	state: string;
	since_ms: number;
}

export class DeviceStateHistoryModel {
	private static table = 'device_state_history';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	static get(deviceKey: string): DeviceStateHistoryRecord | null {
		const row = this.getDb()
			.prepare(`SELECT device_key, state, since_ms FROM ${this.table} WHERE device_key = ?`)
			.get(deviceKey) as DeviceStateHistoryRecord | undefined;

		return row ?? null;
	}

	static upsert(record: DeviceStateHistoryRecord): void {
		this.getDb()
			.prepare(`
				INSERT INTO ${this.table} (device_key, state, since_ms, updated_at)
				VALUES (?, ?, ?, strftime('%s','now') * 1000)
				ON CONFLICT(device_key) DO UPDATE SET
					state = excluded.state,
					since_ms = excluded.since_ms,
					updated_at = excluded.updated_at
			`)
			.run(record.device_key, record.state, record.since_ms);
	}
}
