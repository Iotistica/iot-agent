import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS device_state_history (
			device_key TEXT    PRIMARY KEY,
			state      TEXT    NOT NULL,
			since_ms   INTEGER NOT NULL,
			updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
		);
	`);
}

export const migration: NativeSqliteMigration = {
	name: '20260719000000_add_device_state_history.js',
	up,
};
