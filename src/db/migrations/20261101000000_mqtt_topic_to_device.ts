import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { NativeSqliteMigration } from '../migration-types.js';

/**
 * Migrate MQTT endpoints from per-topic model to per-device model.
 *
 * Before: each MQTT topic = one endpoint, connection.topic = full path, data_points = []
 * After:  each device prefix = one endpoint, connection.baseTopic = prefix, data_points = sub-topics
 *
 * Groups existing per-topic endpoints by extracting a common device prefix.
 * Keeps the first endpoint as primary (updates it), disables duplicates.
 */
function up(db: DatabaseSync): void {
	const rows = db.prepare(
		"SELECT id, name, protocol, connection, data_points, metadata, enabled, fingerprint FROM endpoints WHERE protocol = 'mqtt'"
	).all() as Array<{
		id: number;
		name: string;
		protocol: string;
		connection: string;
		data_points: string | null;
		metadata: string | null;
		enabled: number;
		fingerprint: string | null;
	}>;

	if (rows.length === 0) return;

	// Parse connection JSON and filter to endpoints that have the old `topic` field but no `baseTopic`
	const legacyEndpoints = rows
		.map(r => ({
			...r,
			conn: JSON.parse(r.connection || '{}') as Record<string, any>,
			meta: JSON.parse(r.metadata || '{}') as Record<string, any>,
		}))
		.filter(r => r.conn.topic && !r.conn.baseTopic);

	if (legacyEndpoints.length === 0) return;

	// Group by device prefix: for "factory/sim-001/telemetry", prefix = "factory/sim-001"
	const groups = new Map<string, typeof legacyEndpoints>();

	for (const ep of legacyEndpoints) {
		const topic: string = ep.conn.topic;
		const segments = topic.split('/');

		// If topic has 2+ segments, group by all-but-last (device prefix)
		// If topic is flat (1 segment), it stays as its own group
		const baseTopic = segments.length >= 2
			? segments.slice(0, -1).join('/')
			: topic;

		if (!groups.has(baseTopic)) {
			groups.set(baseTopic, []);
		}
		groups.get(baseTopic)!.push(ep);
	}

	const updateStmt = db.prepare(
		"UPDATE endpoints SET name = ?, connection = ?, data_points = ?, metadata = ?, fingerprint = ? WHERE id = ?"
	);
	const disableStmt = db.prepare(
		"UPDATE endpoints SET enabled = 0, metadata = ? WHERE id = ?"
	);

	for (const [baseTopic, endpoints] of groups) {
		if (endpoints.length === 1 && endpoints[0].conn.topic === baseTopic) {
			// Single flat topic — just add baseTopic field, no grouping needed
			const ep = endpoints[0];
			const newConn: Record<string, any> = { ...ep.conn, baseTopic: ep.conn.topic };
			delete newConn.topic;
			if (newConn.autoMetrics === undefined) newConn.autoMetrics = true;
			const newFingerprint = createHash('sha256')
				.update(`mqtt:${baseTopic}`)
				.digest('hex')
				.substring(0, 32);

			updateStmt.run(
				ep.name,
				JSON.stringify(newConn),
				ep.data_points || '[]',
				ep.metadata || '{}',
				newFingerprint,
				ep.id,
			);
			continue;
		}

		// Multi-topic group: merge into one device endpoint
		const primary = endpoints[0];
		const newFingerprint = createHash('sha256')
			.update(`mqtt:${baseTopic}`)
			.digest('hex')
			.substring(0, 32);

		// Build data_points from all topics in the group
		const dataPoints = endpoints.map(ep => {
			const topic: string = ep.conn.topic;
			const segments = topic.split('/');
			const subTopic = segments.length >= 2
				? segments.slice(baseTopic.split('/').length).join('/')
				: '';

			return {
				subTopic: subTopic || segments[segments.length - 1],
				fullTopic: topic,
				dataType: ep.conn.dataType || 'json',
			};
		});

		// Build new device name from baseTopic
		let topicName = baseTopic.replace(/\//g, '_');
		if (topicName.length > 58) {
			topicName = "..." + topicName.slice(-55);
		}
		const newName = `mqtt_${topicName}`;

		// New connection: baseTopic instead of topic
		const newConn: Record<string, any> = {
			baseTopic,
			autoMetrics: true,
		};
		// Preserve broker connection info from primary
		if (primary.conn.host) newConn.host = primary.conn.host;
		if (primary.conn.port) newConn.port = primary.conn.port;
		if (primary.conn.qos !== undefined) newConn.qos = primary.conn.qos;
		// Preserve any advanced config from primary
		if (primary.conn.metrics) newConn.metrics = primary.conn.metrics;
		if (primary.conn.defaultUnits) newConn.defaultUnits = primary.conn.defaultUnits;
		if (primary.conn.defaultPrecisions) newConn.defaultPrecisions = primary.conn.defaultPrecisions;
		if (primary.conn.deviceId) newConn.deviceId = primary.conn.deviceId;
		if (primary.conn.timestampField) newConn.timestampField = primary.conn.timestampField;

		// Update the primary endpoint
		updateStmt.run(
			newName,
			JSON.stringify(newConn),
			JSON.stringify(dataPoints),
			JSON.stringify({ ...primary.meta, migratedFrom: 'per-topic' }),
			newFingerprint,
			primary.id,
		);

		// Disable duplicates
		for (let i = 1; i < endpoints.length; i++) {
			const dup = endpoints[i];
			const dupMeta = JSON.stringify({
				...dup.meta,
				migratedInto: newName,
				originalTopic: dup.conn.topic,
			});
			disableStmt.run(dupMeta, dup.id);
		}
	}
}

export const migration: NativeSqliteMigration = {
	name: '20261101000000_mqtt_topic_to_device.js',
	up,
};
