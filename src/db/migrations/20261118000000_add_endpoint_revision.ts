import type { DatabaseSync } from 'node:sqlite';
import { columnExists } from '../migration-helpers.js';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	if (!columnExists(db, 'endpoints', 'revision')) {
		db.exec(`ALTER TABLE endpoints ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`);
	}

	db.exec(`DROP TRIGGER IF EXISTS endpoints_bump_revision`);
	db.exec(`
		CREATE TRIGGER endpoints_bump_revision
		AFTER UPDATE ON endpoints
		FOR EACH ROW
		WHEN OLD.revision = NEW.revision AND (
			OLD.uuid IS NOT NEW.uuid OR
			OLD.name IS NOT NEW.name OR
			OLD.protocol IS NOT NEW.protocol OR
			OLD.group_name IS NOT NEW.group_name OR
			OLD.enabled IS NOT NEW.enabled OR
			OLD.poll_interval IS NOT NEW.poll_interval OR
			OLD.connection IS NOT NEW.connection OR
			OLD.data_points IS NOT NEW.data_points OR
			OLD.metadata IS NOT NEW.metadata OR
			OLD.fingerprint IS NOT NEW.fingerprint
		)
		BEGIN
			UPDATE endpoints SET revision = OLD.revision + 1 WHERE rowid = NEW.rowid;
		END
	`);
}

export const migration: NativeSqliteMigration = {
	name: '20261118000000_add_endpoint_revision.js',
	up,
};
