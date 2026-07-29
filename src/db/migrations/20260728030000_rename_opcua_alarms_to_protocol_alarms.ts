import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function tableExists(db: DatabaseSync, name: string): boolean {
	return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function up(db: DatabaseSync): void {
	// 20260727000000_add_opcua_alarms was edited in place after it had already run
	// on some devices: it originally created `opcua_alarms` (no `protocol` column),
	// then was changed to create `protocol_alarms` instead. Migrations are tracked
	// by filename, so devices that already applied it under the old name never
	// picked up the rename and are stuck without a `protocol_alarms` table. This
	// carries them forward without losing any recorded alarm history. Devices that
	// never had `opcua_alarms` already got `protocol_alarms` straight from
	// migration 20260727000000 and need no action here.
	if (!tableExists(db, 'opcua_alarms') || tableExists(db, 'protocol_alarms')) {
		return;
	}

	db.exec(`ALTER TABLE opcua_alarms RENAME TO protocol_alarms;`);
	db.exec(`ALTER TABLE protocol_alarms ADD COLUMN protocol TEXT NOT NULL DEFAULT 'opcua';`);
	db.exec(`DROP INDEX IF EXISTS idx_opcua_alarms_condition_id;`);
	db.exec(`DROP INDEX IF EXISTS idx_opcua_alarms_device_name;`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_protocol_alarms_condition_id ON protocol_alarms(protocol, condition_id);`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_protocol_alarms_device_name ON protocol_alarms(device_name);`);
}

export const migration: NativeSqliteMigration = {
	name: '20260728030000_rename_opcua_alarms_to_protocol_alarms.js',
	up,
};
