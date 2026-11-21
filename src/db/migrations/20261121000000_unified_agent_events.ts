import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	db.exec(`DROP TABLE IF EXISTS anomaly_alerts;`);
	db.exec(`DROP TABLE IF EXISTS anomaly_incidents;`);
	db.exec(`DROP TABLE IF EXISTS anomaly_events;`);

	db.exec(`
		CREATE TABLE agent_events (
			id            INTEGER PRIMARY KEY AUTOINCREMENT,
			msg_id        TEXT    NOT NULL UNIQUE,
			source        TEXT    NOT NULL,
			category      TEXT    NOT NULL,
			severity      TEXT    NOT NULL CHECK (severity IN ('info','warning','critical')),
			fingerprint   TEXT    NOT NULL,
			message       TEXT    NOT NULL,
			device_name   TEXT,
			timestamp_ms  INTEGER NOT NULL,
			actor         TEXT,
			resource_type TEXT,
			resource_id   TEXT,
			metadata      TEXT,
			created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
		);
	`);
	db.exec(`CREATE INDEX idx_agent_events_fingerprint ON agent_events (fingerprint);`);
	db.exec(`CREATE INDEX idx_agent_events_source      ON agent_events (source);`);
	db.exec(`CREATE INDEX idx_agent_events_severity    ON agent_events (severity);`);
	db.exec(`CREATE INDEX idx_agent_events_timestamp   ON agent_events (timestamp_ms DESC);`);
	db.exec(`CREATE INDEX idx_agent_events_actor       ON agent_events (actor) WHERE actor IS NOT NULL;`);

	db.exec(`
		CREATE TABLE agent_incidents (
			id                INTEGER PRIMARY KEY AUTOINCREMENT,
			incident_id       TEXT    NOT NULL UNIQUE,
			source            TEXT    NOT NULL,
			fingerprint       TEXT    NOT NULL,
			severity          TEXT    NOT NULL CHECK (severity IN ('info','warning','critical')),
			device_name       TEXT    NOT NULL DEFAULT 'Unknown',
			first_seen        INTEGER NOT NULL,
			last_seen         INTEGER NOT NULL,
			event_count       INTEGER NOT NULL DEFAULT 1,
			status            TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','active','resolved')),
			last_alert_at     INTEGER,
			acknowledged_at   INTEGER,
			acknowledged_by   TEXT,
			resolution_notes  TEXT,
			resolution_reason TEXT,
			created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
			updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
		);
	`);
	db.exec(`CREATE INDEX idx_agent_incidents_fp_status  ON agent_incidents (fingerprint, status);`);
	db.exec(`CREATE INDEX idx_agent_incidents_source     ON agent_incidents (source);`);
	db.exec(`CREATE INDEX idx_agent_incidents_first_seen ON agent_incidents (first_seen DESC);`);

	db.exec(`
		CREATE TABLE agent_alerts (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			alert_id    TEXT    NOT NULL UNIQUE,
			incident_id TEXT    NOT NULL,
			source      TEXT    NOT NULL,
			severity    TEXT    NOT NULL CHECK (severity IN ('info','warning','critical')),
			device_name TEXT    NOT NULL DEFAULT 'Unknown',
			message     TEXT    NOT NULL,
			created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
		);
	`);
	db.exec(`CREATE INDEX idx_agent_alerts_incident ON agent_alerts (incident_id);`);
	db.exec(`CREATE INDEX idx_agent_alerts_source   ON agent_alerts (source);`);
	db.exec(`CREATE INDEX idx_agent_alerts_created  ON agent_alerts (created_at DESC);`);
}

export const migration: NativeSqliteMigration = {
	name: '20261121000000_unified_agent_events.js',
	up,
};
