import type { DatabaseSync } from 'node:sqlite';
import type { PublishSubscriptionRoute } from './models/publish-subscriptions.model.js';

export function writeSubscriptionSources(
	db: DatabaseSync,
	subscriptionId: number,
	route: PublishSubscriptionRoute | null | undefined,
	allowMissing = false,
): PublishSubscriptionRoute | null {
	db.prepare('DELETE FROM subscription_source_filters WHERE subscription_id = ?').run(subscriptionId);
	if (!route) return null;

	const { includeDevices, excludeDevices, sourceFilterMode, ...otherRoute } = route;
	if (sourceFilterMode !== undefined && sourceFilterMode !== 'specific') {
		throw new Error('Invalid source filter mode');
	}
	const selected = sourceFilterMode === 'specific' || (includeDevices?.length ?? 0) > 0;
	db.prepare('INSERT INTO subscription_source_filters (subscription_id, include_selected) VALUES (?, ?)')
		.run(subscriptionId, selected ? 1 : 0);
	const find = db.prepare('SELECT id FROM endpoints WHERE name = ?');
	const insert = db.prepare(
		'INSERT INTO subscription_source_members (subscription_id, endpoint_id, kind, position) VALUES (?, ?, ?, ?)',
	);
	for (const [kind, names] of [['include', includeDevices], ['exclude', excludeDevices]] as const) {
		if (names === undefined) continue;
		if (!Array.isArray(names) || !names.every(name => typeof name === 'string')) {
			throw new Error(`Invalid ${kind} source filter for subscription ${subscriptionId}`);
		}
		for (const [position, name] of [...new Set(names)].entries()) {
			const rows = find.all(name) as Array<{ id: number }>;
			if (rows.length === 0 && allowMissing) {
				console.warn(`Skipping missing ${kind} source "${name}" for subscription ${subscriptionId} during migration`);
				continue;
			}
			if (rows.length !== 1) {
				throw new Error(`Source "${name}" is missing or ambiguous for subscription ${subscriptionId}`);
			}
			insert.run(subscriptionId, rows[0].id, kind, position);
		}
	}
	return otherRoute;
}

export function readSubscriptionSources(
	db: DatabaseSync,
	subscriptionId: number,
	route: PublishSubscriptionRoute | null,
): PublishSubscriptionRoute | null {
	const filter = db.prepare('SELECT include_selected FROM subscription_source_filters WHERE subscription_id = ?')
		.get(subscriptionId) as { include_selected: number } | undefined;
	if (!filter) return route;
	const members = db.prepare(`
		SELECT e.name, m.kind FROM subscription_source_members m
		JOIN endpoints e ON e.id = m.endpoint_id
		WHERE m.subscription_id = ? ORDER BY m.position, m.endpoint_id
	`).all(subscriptionId) as Array<{ name: string; kind: 'include' | 'exclude' }>;
	const includeDevices = members.filter(member => member.kind === 'include').map(member => member.name);
	const excludeDevices = members.filter(member => member.kind === 'exclude').map(member => member.name);
	return {
		...route,
		...(filter.include_selected ? { sourceFilterMode: 'specific' as const, includeDevices } : {}),
		...(excludeDevices.length ? { excludeDevices } : {}),
	};
}
