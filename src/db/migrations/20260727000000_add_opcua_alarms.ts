import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS protocol_alarms (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			protocol TEXT NOT NULL,
			condition_id TEXT NOT NULL,
			event_type TEXT NOT NULL,
			device_name TEXT NOT NULL,
			message TEXT NOT NULL,
			severity INTEGER NOT NULL,
			active INTEGER NOT NULL DEFAULT 1,
			opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			cleared_at TEXT,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
	`);

	db.exec(`CREATE INDEX IF NOT EXISTS idx_protocol_alarms_condition_id ON protocol_alarms(protocol, condition_id);`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_protocol_alarms_device_name ON protocol_alarms(device_name);`);
}

export const migration: NativeSqliteMigration = {
	name: '20260727000000_add_opcua_alarms.js',
	up,
};
