import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	// Insert default admin user if no users exist (bootstrap for first login)
	// Username: admin
	// Password: admin
	const passwordHash = '$2b$10$Nv0gYHWFYNs0YJ7Po6eHWuqyFk.qDxlWweWq2qKxo6HcaIwxl5K3a';
	
	const now = new Date().toISOString();
	const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
	
	if (userCount.count === 0) {
		db.prepare(
			'INSERT INTO users (username, password_hash, is_superuser, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
		).run('admin', passwordHash, 1, 'admin', 1, now, now);
	}
}

export const migration: NativeSqliteMigration = {
	name: '20261122000000_bootstrap_admin_user.ts',
	up,
};

