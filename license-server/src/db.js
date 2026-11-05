const { DatabaseSync } = require('node:sqlite');

function openDb(file = ':memory:') {
	const db = new DatabaseSync(file);
	db.exec(`
		CREATE TABLE IF NOT EXISTS agents (
			uuid TEXT PRIMARY KEY,
			public_key TEXT NOT NULL,
			trial_used_at INTEGER,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS license_keys (
			key_hash TEXT PRIMARY KEY,
			agent_uuid TEXT,
			license_id TEXT NOT NULL,
			expires_at INTEGER,          -- NULL = perpetual
			revoked_at INTEGER,
			features TEXT                -- JSON array, optional
		);
	`);
	return db;
}

module.exports = { openDb };
