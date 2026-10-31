import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	const cols = db.prepare("PRAGMA table_info('mqtt_users')").all() as { name: string }[];
	if (cols.some(c => c.name === 'password_plaintext')) return;
	db.exec("ALTER TABLE mqtt_users ADD COLUMN password_plaintext varchar(255) DEFAULT NULL");
}

export const migration: NativeSqliteMigration = {
	name: '20261031010000_add_mqtt_user_password_plaintext.js',
	up,
};
