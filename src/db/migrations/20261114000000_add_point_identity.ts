import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE point_identity (
			point_uuid TEXT PRIMARY KEY NOT NULL CHECK (length(trim(point_uuid)) > 0),
			endpoint_uuid TEXT NOT NULL CHECK (length(trim(endpoint_uuid)) > 0),
			protocol TEXT NOT NULL CHECK (length(trim(protocol)) > 0),
			device_uuid TEXT CHECK (device_uuid IS NULL OR length(trim(device_uuid)) > 0),
			association_source TEXT,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE (point_uuid, endpoint_uuid),
			UNIQUE (point_uuid, endpoint_uuid, protocol)
		);

		CREATE TABLE point_identity_address (
			endpoint_uuid TEXT NOT NULL CHECK (length(trim(endpoint_uuid)) > 0),
			protocol TEXT NOT NULL CHECK (length(trim(protocol)) > 0),
			address_version INTEGER NOT NULL CHECK (typeof(address_version) = 'integer' AND address_version > 0),
			address_key TEXT NOT NULL COLLATE BINARY CHECK (length(address_key) > 0),
			point_uuid TEXT NOT NULL CHECK (length(trim(point_uuid)) > 0),
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY (endpoint_uuid, protocol, address_version, address_key),
			FOREIGN KEY (point_uuid, endpoint_uuid, protocol)
				REFERENCES point_identity (point_uuid, endpoint_uuid, protocol)
		);

		CREATE TABLE point_identity_alias (
			endpoint_uuid TEXT NOT NULL CHECK (length(trim(endpoint_uuid)) > 0),
			alias_kind TEXT NOT NULL CHECK (length(trim(alias_kind)) > 0),
			alias_key TEXT NOT NULL COLLATE BINARY CHECK (length(alias_key) > 0),
			point_uuid TEXT NOT NULL CHECK (length(trim(point_uuid)) > 0),
			evidence TEXT NOT NULL CHECK (length(trim(evidence)) > 0),
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY (endpoint_uuid, alias_kind, alias_key),
			FOREIGN KEY (point_uuid, endpoint_uuid)
				REFERENCES point_identity (point_uuid, endpoint_uuid)
		);

		CREATE INDEX idx_point_identity_source
			ON point_identity (endpoint_uuid, protocol);
		CREATE INDEX idx_point_identity_device
			ON point_identity (device_uuid) WHERE device_uuid IS NOT NULL;
		CREATE INDEX idx_point_identity_address_point
			ON point_identity_address (point_uuid);
		CREATE INDEX idx_point_identity_alias_point
			ON point_identity_alias (point_uuid);
	`);
}

export const migration: NativeSqliteMigration = {
	name: '20261114000000_add_point_identity.js',
	up,
};
