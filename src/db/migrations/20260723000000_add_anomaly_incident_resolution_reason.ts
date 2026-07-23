import type { DatabaseSync } from 'node:sqlite';
import { columnExists } from '../migration-helpers.js';
import type { NativeSqliteMigration } from '../migration-types.js';

// Structured classification captured alongside the existing free-text
// resolution_notes, so future reporting (e.g. false-positive rate per rule)
// can group on a controlled vocabulary instead of parsing prose.
function up(db: DatabaseSync): void {
	if (!columnExists(db, 'anomaly_incidents', 'resolution_reason')) {
		db.exec(`ALTER TABLE anomaly_incidents ADD COLUMN resolution_reason TEXT;`);
	}
}

export const migration: NativeSqliteMigration = {
	name: '20260723000000_add_anomaly_incident_resolution_reason.js',
	up,
};
