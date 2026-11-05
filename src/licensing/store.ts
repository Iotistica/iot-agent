import { getDatabase } from '../db/sqlite.js';
import type { LicenseStore, StoredLicense } from './types';

export class SqliteLicenseStore implements LicenseStore {
	load(): StoredLicense | null {
		const row = getDatabase()
			.prepare('SELECT token, activated_at FROM license WHERE id = 1')
			.get() as { token: string; activated_at: number } | undefined;
		return row ? { token: row.token, activatedAt: row.activated_at } : null;
	}

	save(license: StoredLicense): void {
		getDatabase()
			.prepare(
				`INSERT INTO license (id, token, activated_at) VALUES (1, @token, @activatedAt)
				 ON CONFLICT(id) DO UPDATE SET token = excluded.token, activated_at = excluded.activated_at`,
			)
			.run({ token: license.token, activatedAt: license.activatedAt });
	}

	clear(): void {
		getDatabase().prepare('DELETE FROM license WHERE id = 1').run();
	}
}
