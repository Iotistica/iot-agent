import { columnExists } from '../migration-helpers.js';
import type { NativeSqliteMigration } from '../migration-types.js';
import type { DatabaseSync } from 'node:sqlite';

function up(db: DatabaseSync): void {
	if (!columnExists(db, 'devices', 'asset_path')) {
		db.exec(`ALTER TABLE devices ADD COLUMN asset_path TEXT`);
	}
}

export const migration: NativeSqliteMigration = {
	name: '20261102000000_add_asset_path_to_devices.js',
	up,
};
