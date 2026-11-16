import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../sqlite';

export interface BlockedDevice {
	id: number;
	fingerprint: string;
	protocol: string;
	name: string;
	created_at: string;
}

export class DiscoveryBlocklistModel {
	private static table = 'discovery_blocklist';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	static getAll(): BlockedDevice[] {
		return this.getDb()
			.prepare(`SELECT * FROM ${this.table} ORDER BY created_at DESC`)
			.all() as unknown as BlockedDevice[];
	}

	static getByFingerprint(fingerprint: string): BlockedDevice | null {
		const row = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE fingerprint = ? LIMIT 1`)
			.get(fingerprint) as unknown as BlockedDevice | undefined;
		return row ?? null;
	}

	static getFingerprints(): Set<string> {
		const rows = this.getDb()
			.prepare(`SELECT fingerprint FROM ${this.table}`)
			.all() as unknown as Array<{ fingerprint: string }>;
		return new Set(rows.map(r => r.fingerprint));
	}

	static add(entry: { fingerprint: string; protocol: string; name: string }): BlockedDevice {
		this.getDb().prepare(`
			INSERT OR IGNORE INTO ${this.table} (fingerprint, protocol, name)
			VALUES (@fingerprint, @protocol, @name)
		`).run(entry);
		return this.getByFingerprint(entry.fingerprint)!;
	}

	static remove(fingerprint: string): boolean {
		return this.getDb()
			.prepare(`DELETE FROM ${this.table} WHERE fingerprint = ?`)
			.run(fingerprint).changes > 0;
	}
}
