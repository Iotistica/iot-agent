import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';
import type { PublishSubscriptionRoute } from '../models/publish-subscriptions.model.js';
import { writeSubscriptionSources } from '../subscription-sources.js';

export const migration: NativeSqliteMigration = {
	name: '20261116000000_subscription_sources',
	up(db: DatabaseSync): void {
		db.exec(`
			CREATE TABLE subscription_source_filters (
				subscription_id INTEGER PRIMARY KEY REFERENCES publish_subscriptions(id) ON DELETE CASCADE,
				include_selected INTEGER NOT NULL CHECK (include_selected IN (0, 1))
			);
			CREATE TABLE subscription_source_members (
				subscription_id INTEGER NOT NULL REFERENCES subscription_source_filters(subscription_id) ON DELETE CASCADE,
				endpoint_id INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
				kind TEXT NOT NULL CHECK (kind IN ('include', 'exclude')),
				position INTEGER NOT NULL,
				PRIMARY KEY (subscription_id, endpoint_id, kind)
			);
			CREATE INDEX idx_subscription_source_endpoint ON subscription_source_members(endpoint_id);
		`);
		const rows = db.prepare('SELECT id, route_json FROM publish_subscriptions WHERE route_json IS NOT NULL')
			.all() as Array<{ id: number; route_json: string }>;
		const update = db.prepare('UPDATE publish_subscriptions SET route_json = ? WHERE id = ?');
		for (const row of rows) {
			const route: unknown = JSON.parse(row.route_json);
			if (!route || typeof route !== 'object' || Array.isArray(route)) {
				throw new Error(`Invalid routing configuration for subscription ${row.id}`);
			}
			const remaining = writeSubscriptionSources(db, row.id, route as PublishSubscriptionRoute, true);
			update.run(JSON.stringify(remaining), row.id);
		}
	},
};
