import type { DatabaseSync } from 'node:sqlite';
import { columnExists } from '../migration-helpers.js';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	if (!columnExists(db, 'endpoints', 'revision')) {
		db.exec(`ALTER TABLE endpoints ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`);
	}

	db.exec(`
		CREATE TRIGGER IF NOT EXISTS endpoints_bump_revision
		AFTER UPDATE ON endpoints
		FOR EACH ROW
		WHEN OLD.revision = NEW.revision
		BEGIN
			UPDATE endpoints SET revision = OLD.revision + 1 WHERE rowid = NEW.rowid;
		END
	`);
}

export const migration: NativeSqliteMigration = {
	name: '20261118000000_add_endpoint_revision.js',
	up,
};
