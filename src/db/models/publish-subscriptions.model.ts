import type { DatabaseSync } from 'node:sqlite';
import { getDatabase, transact } from '../sqlite';
import { readSubscriptionSources, writeSubscriptionSources } from '../subscription-sources.js';

export type PublishPayloadFormat = 'custom' | 'tags' | 'ecp' | 'ml';
export type SubscriptionCompression = 'json' | 'msgpack' | 'json+deflate' | 'msgpack+deflate';

export interface PublishSubscriptionRoute {
	includeMetrics?: string[];
	excludeMetrics?: string[];
	includeDevices?: string[];
	excludeDevices?: string[];
	sourceFilterMode?: 'specific';
	qualities?: Array<'GOOD' | 'BAD' | 'UNCERTAIN'>;
	minIntervalMs?: number;
	maxPointsPerMessage?: number;
	topic?: string;
}

export interface PublishSubscriptionRecord {
	id?: number;
	publish_destination_id: number;
	topics: string[];
	route_json?: PublishSubscriptionRoute | null;
	payload_format: PublishPayloadFormat;
	compression?: SubscriptionCompression | null;
	ml_dataset_id?: string | null;
	enabled: boolean;
	created_at?: Date;
	updated_at?: Date;
}

type PublishSubscriptionRow = Omit<PublishSubscriptionRecord, 'topics' | 'route_json' | 'ml_dataset_id' | 'enabled' | 'created_at' | 'updated_at'> & {
	topics: string;
	route_json?: string | null;
	ml_dataset_id?: string | null;
	enabled: number;
	created_at?: string | Date;
	updated_at?: string | Date;
};

export class PublishSubscriptionsModel {
	private static readonly table = 'publish_subscriptions';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	private static parseJsonArray(value: string): string[] {
		try {
			const parsed = JSON.parse(value);
			if (!Array.isArray(parsed)) {
				return [];
			}
			return parsed.filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
		} catch {
			return [];
		}
	}

	private static mapRow(row: PublishSubscriptionRow | undefined): PublishSubscriptionRecord | null {
		if (!row) {
			return null;
		}

		let route: PublishSubscriptionRoute | null = null;
		if (typeof row.route_json === 'string' && row.route_json.trim().length > 0) {
			try {
				route = JSON.parse(row.route_json) as PublishSubscriptionRoute;
			} catch {
				throw new Error(`Invalid routing configuration for subscription ${row.id}`);
			}
			route = readSubscriptionSources(this.getDb(), row.id!, route);
		}

		return {
			...row,
			topics: this.parseJsonArray(row.topics),
			route_json: route,
			ml_dataset_id: row.ml_dataset_id ?? null,
			enabled: !!row.enabled,
			created_at: row.created_at ? new Date(row.created_at) : undefined,
			updated_at: row.updated_at ? new Date(row.updated_at) : undefined,
		};
	}

	static getAll(includeDisabled: boolean = true): PublishSubscriptionRecord[] {
		const db = this.getDb();
		const rows = includeDisabled
			? (db.prepare(`SELECT * FROM ${this.table} ORDER BY id ASC`).all() as unknown as PublishSubscriptionRow[])
			: (db.prepare(`SELECT * FROM ${this.table} WHERE enabled = 1 ORDER BY id ASC`).all() as unknown as PublishSubscriptionRow[]);

		return rows
			.map((row) => this.mapRow(row))
			.filter((row): row is PublishSubscriptionRecord => row !== null);
	}

	static getByPublishDestinationId(publishDestinationId: number, includeDisabled: boolean = true): PublishSubscriptionRecord[] {
		const db = this.getDb();
		const rows = includeDisabled
			? (db.prepare(`SELECT * FROM ${this.table} WHERE publish_destination_id = ? ORDER BY id ASC`).all(publishDestinationId) as unknown as PublishSubscriptionRow[])
			: (db.prepare(`SELECT * FROM ${this.table} WHERE publish_destination_id = ? AND enabled = 1 ORDER BY id ASC`).all(publishDestinationId) as unknown as PublishSubscriptionRow[]);

		return rows
			.map((row) => this.mapRow(row))
			.filter((row): row is PublishSubscriptionRecord => row !== null);
	}

	static getById(id: number): PublishSubscriptionRecord | null {
		const row = this.getDb().prepare(`SELECT * FROM ${this.table} WHERE id = ? LIMIT 1`).get(id) as unknown as PublishSubscriptionRow | undefined;
		return this.mapRow(row);
	}

	static create(input: Omit<PublishSubscriptionRecord, 'id' | 'created_at' | 'updated_at'>): PublishSubscriptionRecord | null {
		const now = new Date().toISOString();
		const db = this.getDb();
		return transact(db, () => {
			const result = db.prepare(`
				INSERT INTO ${this.table} (
					publish_destination_id, topics, route_json, payload_format, compression,
					ml_dataset_id, enabled, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
				input.publish_destination_id,
				JSON.stringify(input.topics || []),
				null,
				input.payload_format,
				input.compression ?? null,
				input.ml_dataset_id ?? null,
				input.enabled ? 1 : 0,
				now,
				now,
			);

			const id = Number(result.lastInsertRowid);
			const route = writeSubscriptionSources(db, id, input.route_json);
			if (route) db.prepare(`UPDATE ${this.table} SET route_json = ? WHERE id = ?`).run(JSON.stringify(route), id);
			return this.getById(id);
		}, 'IMMEDIATE');
	}

	static update(id: number, updates: Partial<Omit<PublishSubscriptionRecord, 'id' | 'created_at'>>): PublishSubscriptionRecord | null {
		const db = this.getDb();
		return transact(db, () => {
			if (!db.prepare(`SELECT 1 FROM ${this.table} WHERE id = ?`).get(id)) return null;
			const payload: Record<string, unknown> = {
				updated_at: new Date().toISOString(),
			};

			if (updates.publish_destination_id !== undefined) payload.publish_destination_id = updates.publish_destination_id;
			if (updates.topics !== undefined) payload.topics = JSON.stringify(updates.topics || []);
			if (updates.route_json !== undefined) {
				const route = writeSubscriptionSources(db, id, updates.route_json);
				payload.route_json = route ? JSON.stringify(route) : null;
			}
			if (updates.payload_format !== undefined) payload.payload_format = updates.payload_format;
			if (updates.compression !== undefined) payload.compression = updates.compression ?? null;
			if (updates.ml_dataset_id !== undefined) payload.ml_dataset_id = updates.ml_dataset_id ?? null;
			if (updates.enabled !== undefined) payload.enabled = updates.enabled ? 1 : 0;

			const columns = Object.keys(payload);
			const sql = `UPDATE ${this.table} SET ${columns.map((column) => `${column} = @${column}`).join(', ')} WHERE id = @id`;
			db.prepare(sql).run({ ...payload, id });
			return this.getById(id);
		}, 'IMMEDIATE');
	}

	static delete(id: number): boolean {
		const result = this.getDb().prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id);
		return Number(result.changes) > 0;
	}

	static deleteByPublishDestinationId(publishDestinationId: number): number {
		const result = this.getDb().prepare(`DELETE FROM ${this.table} WHERE publish_destination_id = ?`).run(publishDestinationId);
		return Number(result.changes);
	}
}
