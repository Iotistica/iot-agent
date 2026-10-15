import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS ml_datasets (
			id                      TEXT PRIMARY KEY,
			name                    TEXT NOT NULL,
			description             TEXT NOT NULL DEFAULT '',
			owner_username          TEXT NOT NULL,
			point_keys              TEXT NOT NULL DEFAULT '[]',
			sampling_interval_secs  INTEGER NOT NULL DEFAULT 60,
			window_secs             INTEGER NOT NULL DEFAULT 900,
			missing_values          TEXT NOT NULL DEFAULT 'forward_fill',
			normalization           TEXT NOT NULL DEFAULT 'none',
			exclude_bad_quality     INTEGER NOT NULL DEFAULT 1,
			remove_outliers         INTEGER NOT NULL DEFAULT 0,
			outlier_method          TEXT NOT NULL DEFAULT 'iqr',
			output_format           TEXT NOT NULL DEFAULT 'jsonl',
			created_at              DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at              DATETIME DEFAULT CURRENT_TIMESTAMP
		);

		CREATE INDEX IF NOT EXISTS idx_ml_datasets_owner
			ON ml_datasets(owner_username);
	`);
}

export const migration: NativeSqliteMigration = {
	name: '20261015000000_add_ml_datasets.js',
	up,
};
