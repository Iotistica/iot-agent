import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import type { NativeSqliteMigration } from '../migration-types.js';

function generateRandomPassword(): string {
	// 12 bytes -> 16 base64url chars, no ambiguous separators, ~96 bits of entropy
	return randomBytes(12).toString('base64url');
}

function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS users (
			id                    INTEGER PRIMARY KEY AUTOINCREMENT,
			username              TEXT    NOT NULL,
			password_hash         TEXT    NOT NULL,
			is_superuser          INTEGER NOT NULL DEFAULT 0,
			is_active             INTEGER NOT NULL DEFAULT 1,
			must_change_password  INTEGER NOT NULL DEFAULT 0,
			created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			updated_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
	`);
	db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (username);`);

	// Seed default admin user with a random password (never a fixed default).
	// INITIAL_ADMIN_PASSWORD lets a provisioner (e.g. the live demo) set a known
	// password up front; otherwise one is generated and logged for the operator
	// to retrieve. Either way the account is forced to change it on first login.
	const generated = !process.env.INITIAL_ADMIN_PASSWORD;
	const password = process.env.INITIAL_ADMIN_PASSWORD || generateRandomPassword();
	const hash = bcrypt.hashSync(password, 10);
	const now = new Date().toISOString();
	db.prepare(
		`INSERT OR IGNORE INTO users (username, password_hash, is_superuser, must_change_password, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)`
	).run('admin', hash, now, now);

	if (generated) {
		// eslint-disable-next-line no-console
		console.log(
			'\n' +
			'============================================================\n' +
			'  Iotistica Agent — initial admin account created\n' +
			'  Username: admin\n' +
			`  Password: ${password}\n` +
			'  You will be required to change this password on first login.\n' +
			'============================================================\n'
		);
	}
}

export const migration: NativeSqliteMigration = {
	name: '20260620010000_add_admin_users.js',
	up,
};
