
import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	const columns = db
		.prepare('PRAGMA table_info(firewall_rules)')
		.all() as unknown as Array<{ name: string }>;

	if (columns.some((column) => column.name === 'action')) {
		return;
	}

	db.exec(`
        ALTER TABLE firewall_rules
        ADD COLUMN action TEXT NOT NULL DEFAULT 'ACCEPT'
        CHECK (action IN ('ACCEPT', 'REJECT', 'DROP'));
    `);
}

export const migration: NativeSqliteMigration = {
	name: '20261111000000_add_firewall_rule_action.js',
	up,
};
