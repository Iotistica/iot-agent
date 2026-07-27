import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	const columns = db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>;
	const hasColumn = columns.some((col) => col.name === 'role');

	if (!hasColumn) {
		db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'operator';`);
	}

	// Backfill from the existing flat is_superuser flag. is_superuser=1 -> admin
	// (matches today's meaning exactly). is_superuser=0 -> operator, not
	// viewer — every non-superuser account already has full access today
	// (nothing currently restricts them), so operator is the no-regression
	// default; nobody is silently granted or stripped of capability by this
	// migration. New accounts default to 'operator' too (see the ALTER above),
	// for the same reason.
	db.exec(`UPDATE users SET role = 'admin' WHERE is_superuser = 1;`);
}

export const migration: NativeSqliteMigration = {
	name: '20260726000000_add_role_to_users.js',
	up,
};
