import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	// observed_metrics was keyed by name alone, assuming metric names are
	// globally unique — true for BACnet/UUID-scoped endpoint metrics, false
	// for OPC-UA sources using bare field names shared across many devices
	// (e.g. "hc_valve" reported identically by 8 different AHUs). That
	// collapsed every device's occurrence of a shared field name into one
	// catalog row, discarding which devices actually report it — see
	// AnomalyDetectionService's observedMetrics Map. SQLite can't change a
	// primary key via ALTER TABLE, so recreate with device_id as part of the
	// key: each (metric, device) pair now gets its own row. Existing rows
	// predate this column and have no device recorded — backfilled to ''
	// rather than guessed, since which device an already-collapsed row
	// belonged to isn't recoverable from what's stored.
	db.exec(`DROP TABLE IF EXISTS observed_metrics_new;`);
	db.exec(`
		CREATE TABLE observed_metrics_new (
			name               TEXT    NOT NULL,
			device_id          TEXT    NOT NULL DEFAULT '',
			source             TEXT    NOT NULL DEFAULT 'unknown',
			protocol           TEXT,
			unit               TEXT,
			last_seen_at       INTEGER NOT NULL,
			observation_count  INTEGER NOT NULL DEFAULT 1,
			created_at         INTEGER NOT NULL,
			PRIMARY KEY (name, device_id)
		)
	`);
	db.exec(`
		INSERT INTO observed_metrics_new (name, device_id, source, protocol, unit, last_seen_at, observation_count, created_at)
		SELECT name, '', source, protocol, unit, last_seen_at, observation_count, created_at
		FROM observed_metrics
	`);
	db.exec(`DROP TABLE observed_metrics;`);
	db.exec(`ALTER TABLE observed_metrics_new RENAME TO observed_metrics;`);

	db.exec(`DROP INDEX IF EXISTS idx_observed_metrics_last_seen;`);
	db.exec(`DROP INDEX IF EXISTS idx_observed_metrics_source;`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_observed_metrics_last_seen ON observed_metrics(last_seen_at DESC)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_observed_metrics_source ON observed_metrics(source)`);
}

export const migration: NativeSqliteMigration = {
	name: '20260729000000_add_device_id_to_observed_metrics.js',
	up,
};
