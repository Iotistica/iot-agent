import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS device_resolution_keys (
			endpoint_id INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
			device_uuid TEXT NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
			kind TEXT NOT NULL,
			value TEXT NOT NULL,
			PRIMARY KEY (endpoint_id, kind, value)
		);
		CREATE INDEX IF NOT EXISTS idx_device_resolution_keys_device
			ON device_resolution_keys (device_uuid);
		CREATE TABLE IF NOT EXISTS device_resolution_points (
			endpoint_id INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
			device_uuid TEXT NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
			address TEXT NOT NULL,
			PRIMARY KEY (endpoint_id, address)
		);
		CREATE INDEX IF NOT EXISTS idx_device_resolution_points_device
			ON device_resolution_points (device_uuid);
		CREATE TRIGGER IF NOT EXISTS device_resolution_cleanup_device
			AFTER DELETE ON devices BEGIN
				DELETE FROM device_resolution_keys WHERE device_uuid = OLD.uuid;
				DELETE FROM device_resolution_points WHERE device_uuid = OLD.uuid;
			END;
		CREATE TRIGGER IF NOT EXISTS device_resolution_cleanup_endpoint
			AFTER DELETE ON endpoints BEGIN
				DELETE FROM device_resolution_keys WHERE endpoint_id = OLD.id;
				DELETE FROM device_resolution_points WHERE endpoint_id = OLD.id;
			END;
	`);
}

export const migration: NativeSqliteMigration = {
	name: '20261113000000_add_device_resolution_evidence.js',
	up,
};
