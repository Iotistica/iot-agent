import type { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	const columns = db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>;
	const hasColumn = columns.some((col) => col.name === 'must_change_password');

	// Fresh installs already get this column from the users CREATE TABLE
	// statement (see 20260620010000_add_admin_users) — only ALTER for
	// pre-existing databases that predate it.
	if (!hasColumn) {
		db.exec(`ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;`);
	}

	// Existing installs may still be sitting on the old hardcoded admin/admin
	// seed password (from before this column existed) — force those specific
	// accounts to change it, without touching anyone who already has a custom
	// password set.
	const rows = db.prepare(`SELECT id, password_hash FROM users`).all() as Array<{ id: number; password_hash: string }>;
	const forceChange = db.prepare(`UPDATE users SET must_change_password = 1 WHERE id = ?`);
	for (const row of rows) {
		if (bcrypt.compareSync('admin', row.password_hash)) {
			forceChange.run(row.id);
		}
	}
}

export const migration: NativeSqliteMigration = {
	name: '20260722000000_add_must_change_password_to_users.js',
	up,
};
