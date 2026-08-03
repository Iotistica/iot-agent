import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

/**
 * Marks at most one `mqtt`-type publish destination as the source for
 * inbound device-write commands (src/commands/). Destinations were
 * previously outbound-publish-only; this repurposes an existing,
 * admin-configured MQTT destination as the command transport too, instead
 * of the command feature inventing its own separate connection — see
 * GitHub issues #4/#5/#6.
 */
function up(db: DatabaseSync): void {
	const columns = db.prepare(`PRAGMA table_info(publish_destinations)`).all() as Array<{ name: string }>;
	const hasColumn = columns.some((col) => col.name === 'use_for_commands');

	if (!hasColumn) {
		db.exec(`ALTER TABLE publish_destinations ADD COLUMN use_for_commands INTEGER NOT NULL DEFAULT 0;`);
	}
}

export const migration: NativeSqliteMigration = {
	name: '20260802000000_add_use_for_commands_to_publish_destinations.js',
	up,
};
