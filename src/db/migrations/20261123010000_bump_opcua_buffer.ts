import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	db.exec(`
		UPDATE endpoint_outputs
		SET buffer_capacity = ${8 * 1024 * 1024}
		WHERE protocol = 'opcua'
		  AND buffer_capacity <= ${1024 * 1024}
	`);
}

export const migration: NativeSqliteMigration = {
	name: '20261123010000_bump_opcua_buffer.js',
	up,
};
