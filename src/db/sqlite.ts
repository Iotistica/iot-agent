import { DatabaseSync } from 'node:sqlite';
import { getDatabasePath } from './db-path';

let directDb: DatabaseSync | undefined;

export function getDatabase(): DatabaseSync {
	if (!directDb) {
		const db = new DatabaseSync(getDatabasePath());
		const busyTimeoutMs = Number.parseInt(process.env.SQLITE_BUSY_TIMEOUT_MS || '15000', 10);
		const safeBusyTimeoutMs = Number.isFinite(busyTimeoutMs) && busyTimeoutMs > 0 ? busyTimeoutMs : 15000;

		db.exec(`PRAGMA journal_mode = WAL`);
		db.exec('PRAGMA foreign_keys = ON');
		db.exec(`PRAGMA busy_timeout = ${safeBusyTimeoutMs}`);

		if (process.env.SQLITE_READONLY_MODE === 'true') {
			db.exec('PRAGMA query_only = ON');
		}

		directDb = db;
	}

	return directDb;
}

export function closeDatabase(): void {
	if (!directDb) {
		return;
	}

	directDb.close();
	directDb = undefined;
}

let lastPassiveCheckpointMs = 0;
const PASSIVE_CHECKPOINT_INTERVAL_MS = 60_000;

/**
 * Run a PASSIVE WAL checkpoint if at least PASSIVE_CHECKPOINT_INTERVAL_MS has
 * elapsed since the last one.  PASSIVE never blocks writers — it only moves
 * pages that are already no longer needed by any reader, so it is safe to call
 * during normal runtime (unlike TRUNCATE which requires an exclusive lock).
 *
 * Returns true when a checkpoint actually ran.
 */
export function walCheckpointIfDue(): boolean {
	const now = Date.now();
	if (now - lastPassiveCheckpointMs < PASSIVE_CHECKPOINT_INTERVAL_MS) return false;
	lastPassiveCheckpointMs = now;
	try {
		getDatabase().exec('PRAGMA wal_checkpoint(PASSIVE)');
		return true;
	} catch {
		return false;
	}
}

/** Run fn inside a transaction, committing on success and rolling back on error. */
export function transact<T>(db: DatabaseSync, fn: () => T, mode: 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE' = 'DEFERRED'): T {
	db.exec(`BEGIN ${mode}`);
	try {
		const result = fn();
		db.exec('COMMIT');
		return result;
	} catch (err) {
		try { db.exec('ROLLBACK'); } catch (_) { /* ignore rollback errors */ }
		throw err;
	}
}
