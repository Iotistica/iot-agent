import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

/**
 * One row per module ('maintenance' | 'energy') — same shape both need
 * (mqtt/cloud toggles, a destination FK, a topic string), so a shared table
 * with a `module` discriminator is appropriate here (unlike the
 * recommendation tables themselves, which the plan's decision #1 deliberately
 * keeps un-shared because their *event* shapes genuinely differ — this is
 * just settings, identical shape, no forcing).
 */
function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS recommendation_publish_settings (
			module TEXT PRIMARY KEY,
			mqtt INTEGER NOT NULL DEFAULT 0,
			cloud INTEGER NOT NULL DEFAULT 1,
			alert_destination_id INTEGER,
			alert_topic TEXT,
			updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		);
	`);
}

export const migration: NativeSqliteMigration = {
	name: '20260728020000_add_recommendation_publish_settings.js',
	up,
};
