import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: DatabaseSync): void {
	// If no unified 'target' row exists, reconstruct one from legacy fragments
	const hasTarget = db.prepare(
		`SELECT 1 FROM stateSnapshot WHERE type = 'target' LIMIT 1`
	).get();

	if (!hasTarget) {
		const appsRow = db.prepare(
			`SELECT state FROM stateSnapshot WHERE type = 'apps-target' ORDER BY createdAt DESC LIMIT 1`
		).get() as { state: string } | undefined;

		const configRow = db.prepare(
			`SELECT state FROM stateSnapshot WHERE type = 'config' ORDER BY createdAt DESC LIMIT 1`
		).get() as { state: string } | undefined;

		if (appsRow || configRow) {
			const apps = appsRow ? (JSON.parse(appsRow.state).apps || {}) : {};
			const config = configRow ? JSON.parse(configRow.state) : {};
			const unified = JSON.stringify({ apps, config });

			db.prepare(
				`INSERT INTO stateSnapshot (type, state) VALUES ('target', ?)`
			).run(unified);
		}
	}

	// If no unified 'current' row exists, create one from the config checkpoint
	const hasCurrent = db.prepare(
		`SELECT 1 FROM stateSnapshot WHERE type = 'current' LIMIT 1`
	).get();

	if (!hasCurrent) {
		const configRow = db.prepare(
			`SELECT state FROM stateSnapshot WHERE type = 'config' ORDER BY createdAt DESC LIMIT 1`
		).get() as { state: string } | undefined;

		if (configRow) {
			const config = JSON.parse(configRow.state);
			const unified = JSON.stringify({ apps: {}, config });

			db.prepare(
				`INSERT INTO stateSnapshot (type, state) VALUES ('current', ?)`
			).run(unified);
		}
	}

	// Remove all legacy apps-target rows (redundant with target.apps)
	db.prepare(`DELETE FROM stateSnapshot WHERE type = 'apps-target'`).run();
}

export const migration: NativeSqliteMigration = {
	name: '20261115000000_unify_state_snapshots',
	up,
};
