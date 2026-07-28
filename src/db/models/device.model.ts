/**
 * Protocol Devices Model
 *
 * Manages the `devices` table — the physical/logical devices reachable
 * through protocol endpoints.
 *
 * Relationship to endpoints:
 *   endpoint = the connection point  (Modbus TCP bus, OPC-UA server URL)
 *   device   = a device accessible via that connection
 *
 *   Modbus  → N slaves per bus endpoint, identifier = slaveId string
 *   OPC-UA  → N logical devices per server endpoint, identifier = device_uuid
 *   BACnet/SNMP/MQTT/CAN → 1:1 with endpoint, identifier = null
 *
 * The `uuid` column is the stable identity carried in metric payloads
 * (deviceDataPoint.device_uuid).
 */

import { randomUUID, createHash } from 'crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../sqlite';
import type { Endpoint } from './endpoint.model';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Some OPC-UA servers tag device groups with a human-readable identifier
// (e.g. "pump-1") rather than an actual UUID, despite the "DeviceUUID" node
// name. The devices table's uuid column must always be a real UUID (it's
// reported to the cloud, which stores it in a uuid-typed column) — derive a
// stable one from the raw tag instead of trusting it verbatim.
// (RFC4122 v5: SHA-1 of namespace+name, with version/variant bits set —
// implemented inline since the `uuid` package is ESM-only and this file
// compiles as CommonJS.)
const DEVICE_UUID_NAMESPACE = '6f1f9b1e-2b0a-4c9a-9e2a-5f6a7c8d9e0f';

function uuidv5(name: string, namespace: string): string {
	const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
	const hash = createHash('sha1').update(nsBytes).update(name, 'utf8').digest();
	hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
	hash[8] = (hash[8] & 0x3f) | 0x80; // variant RFC4122
	const hex = hash.subarray(0, 16).toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function toDeviceUuid(rawDeviceUuid: string): string {
	return UUID_RE.test(rawDeviceUuid) ? rawDeviceUuid : uuidv5(rawDeviceUuid, DEVICE_UUID_NAMESPACE);
}

/**
 * Build a device-name suffix from a raw device_uuid. Real UUIDs (the common
 * case — most OPC-UA servers report an actual UUID) are truncated to 8 hex
 * chars for readability; their entropy makes a prefix collision practically
 * impossible. Non-UUID human-readable identifiers (e.g. this project's own
 * simulator uses tags like "lighting-f10") are used in full instead — those
 * are often short already, and truncating them collides for real whenever
 * multiple devices share a common prefix ("lighting-f10"/"lighting-f11"/...
 * all truncate to "lighting"). Exported so src/plugins/index.ts's metric/
 * anomaly-detection deviceName pipeline stays consistent with this table's
 * device Name — a mismatch would make UI rows impossible to correlate with
 * their own telemetry.
 */
export function deviceNameSuffix(rawDeviceUuid: string): string {
	const stripped = rawDeviceUuid.replace(/-/g, '');
	return UUID_RE.test(rawDeviceUuid) ? stripped.slice(0, 8) : stripped;
}

function normalizeForCompare(s: string): string {
	return s.toLowerCase().replace(/[-_\s]/g, '');
}

/**
 * Same as deviceNameSuffix(), but omits the suffix entirely when it would be
 * redundant with the display name it'd be appended to — e.g. a non-UUID
 * device_uuid of "vav-f9c" against a display name of "VAV-F9-C" strips down
 * to "vavf9c" either way, so appending it just repeats the name back
 * ("VAV-F9-C-vavf9c") instead of disambiguating anything. Real UUIDs never
 * trip this (their hex slice essentially never matches a human-readable name).
 */
export function deviceNameSuffixFor(displayName: string, rawDeviceUuid: string): string {
	const suffix = deviceNameSuffix(rawDeviceUuid);
	if (!suffix) return suffix;
	return normalizeForCompare(displayName).includes(normalizeForCompare(suffix)) ? '' : suffix;
}

export interface Device {
  id?: number;
  /** Stable UUID used in metric payloads (deviceDataPoint.device_uuid) */
  uuid: string;
  endpoint_id: number;
  name: string;
  protocol: string;
  enabled: boolean;
  /**
   * Protocol-specific sub-address within the endpoint:
   *   Modbus  → slaveId as string ("3")
   *   OPC-UA  → device_uuid from the DeviceUUID node
   *   others  → undefined/null
   */
  identifier?: string | null;
  metadata?: Record<string, any>;
  lastSeenAt?: Date | string | null;
  created_at?: Date | string;
  updated_at?: Date | string;
}

type DeviceRow = Omit<Device, 'enabled' | 'metadata'> & {
  enabled: number;
  metadata?: string | Record<string, any> | null;
};

export class DeviceModel {
	private static readonly table = 'devices';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	static async getAll(protocol?: string): Promise<Device[]> {
		const rows = protocol
			? this.getDb().prepare(`SELECT * FROM ${this.table} WHERE protocol = ? ORDER BY name ASC`).all(protocol) as unknown as DeviceRow[]
			: this.getDb().prepare(`SELECT * FROM ${this.table} ORDER BY name ASC`).all() as unknown as DeviceRow[];

		return rows.map(this.parse);
	}

	/**
   * Return all devices joined with their parent endpoint UUID.
   * Used by CloudSync to include the `devices` field in state reports so the
   * cloud can store agent-reported devices without re-parsing endpoint metadata.
   */
	static async getAllWithEndpointUuid(): Promise<Array<Device & { endpoint_uuid: string }>> {
		const rows = this.getDb()
			.prepare(`
        SELECT d.*, e.uuid as endpoint_uuid
        FROM devices d
        JOIN endpoints e ON e.id = d.endpoint_id
        ORDER BY d.name ASC
      `)
			.all() as unknown as Array<DeviceRow & { endpoint_uuid: string }>;

		return rows.map((row) => ({ ...this.parse(row), endpoint_uuid: row.endpoint_uuid }));
	}

	static async getByEndpointId(endpointId: number): Promise<Device[]> {
		const rows = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE endpoint_id = ?`)
			.all(endpointId) as unknown as DeviceRow[];

		return rows.map(this.parse);
	}

	static async getByUuid(uuid: string): Promise<Device | null> {
		const row = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE uuid = ? LIMIT 1`)
			.get(uuid) as unknown as DeviceRow | undefined;

		return row ? this.parse(row) : null;
	}

	static async updateLastSeen(uuid: string): Promise<void> {
		const now = new Date().toISOString();
		this.getDb()
			.prepare(`UPDATE ${this.table} SET lastSeenAt = ?, updated_at = ? WHERE uuid = ?`)
			.run(now, now, uuid);
	}

	/**
   * Update lastSeenAt for all devices belonging to the named endpoint.
   * Called from the poll adapters on each successful read.
   */
	static async updateLastSeenByEndpointName(endpointName: string): Promise<void> {
		const db = this.getDb();
		const now = new Date().toISOString();
		const endpoint = db
			.prepare('SELECT id FROM endpoints WHERE name = ? LIMIT 1')
			.get(endpointName) as { id: number } | undefined;

		if (!endpoint) return;

		db.prepare(`UPDATE ${this.table} SET lastSeenAt = ?, updated_at = ? WHERE endpoint_id = ?`)
			.run(now, now, endpoint.id);
	}

	/**
   * Enable/disable a device. Always updates this device's own `devices.enabled`
   * row. Additionally cascades to the parent endpoint's `enabled` — but ONLY
   * when this device is in a genuine 1:1 relationship with its endpoint
   * (BACnet/SNMP/MQTT/CAN, or an OPC-UA endpoint with just one device group):
   * that's the case where "enable this device" and "enable this connection"
   * are actually the same action, and the only place enabled state has a real
   * runtime effect today (the poll/connect loop reads endpoint.enabled, not
   * devices.enabled). For an OPC-UA endpoint with many devices sharing one
   * connection, cascading would incorrectly enable/disable every other
   * sibling device's connection too — so multi-device endpoints only get the
   * (display-only, for now) devices.enabled column updated.
   */
	static async setEnabled(uuid: string, enabled: boolean): Promise<Device | null> {
		const db = this.getDb();
		const now = new Date().toISOString();

		const device = db.prepare(`SELECT * FROM ${this.table} WHERE uuid = ? LIMIT 1`).get(uuid) as unknown as DeviceRow | undefined;
		if (!device) return null;

		db.prepare(`UPDATE ${this.table} SET enabled = ?, updated_at = ? WHERE uuid = ?`)
			.run(enabled ? 1 : 0, now, uuid);

		const siblingCount = (db.prepare(`SELECT COUNT(*) as n FROM ${this.table} WHERE endpoint_id = ?`)
			.get(device.endpoint_id) as { n: number }).n;

		if (siblingCount <= 1) {
			db.prepare(`UPDATE endpoints SET enabled = ?, updated_at = ? WHERE id = ?`)
				.run(enabled ? 1 : 0, now, device.endpoint_id);
		}

		const updated = db.prepare(`SELECT * FROM ${this.table} WHERE uuid = ? LIMIT 1`).get(uuid) as unknown as DeviceRow;
		return this.parse(updated);
	}

	/**
   * Upsert a device by (endpoint_id, identifier).
   * For 1:1 protocols (identifier null/undefined), matches on endpoint_id alone.
   */
	static async upsertDevice(device: Omit<Device, 'id'>): Promise<void> {
		const db = this.getDb();
		const now = new Date().toISOString();

		const hasIdentifier = device.identifier !== undefined && device.identifier !== null;

		const existing = hasIdentifier
			? db
				.prepare(`SELECT id FROM ${this.table} WHERE endpoint_id = ? AND identifier = ? LIMIT 1`)
				.get(device.endpoint_id, device.identifier ?? null) as unknown as { id: number } | undefined
			: db
				.prepare(`SELECT id FROM ${this.table} WHERE endpoint_id = ? AND identifier IS NULL LIMIT 1`)
				.get(device.endpoint_id) as { id: number } | undefined;

		if (existing) {
			db.prepare(`
        UPDATE ${this.table}
        SET name = ?,
            enabled = ?,
            metadata = ?,
            lastSeenAt = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
				device.name,
				device.enabled ? 1 : 0,
				device.metadata ? JSON.stringify(device.metadata) : null,
				device.lastSeenAt instanceof Date ? device.lastSeenAt.toISOString() : (device.lastSeenAt ?? null),
				now,
				existing.id,
			);
		} else {
			db.prepare(`
        INSERT INTO ${this.table} (
          uuid,
          endpoint_id,
          name,
          protocol,
          enabled,
          identifier,
          metadata,
          lastSeenAt,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
				device.uuid,
				device.endpoint_id,
				device.name,
				device.protocol,
				device.enabled ? 1 : 0,
				device.identifier ?? null,
				device.metadata ? JSON.stringify(device.metadata) : null,
				device.lastSeenAt instanceof Date ? device.lastSeenAt.toISOString() : (device.lastSeenAt ?? null),
				now,
				now,
			);
		}
	}

	/**
   * Sync device rows from a saved endpoint.
   * Called after endpoint create/update in discovery to keep devices in step.
   *
   * Modbus  → 1 device per per-slave endpoint  (identifier = slaveId)
   * OPC-UA  → 1 device per device_uuid group in data_points;
   *           the catch-all default group (nodes without a device_uuid) is only
   *           persisted when the server exposes NO device grouping at all —
   *           stray untagged nodes are silently ignored when real devices exist
   * Others  → 1 device mirroring the endpoint  (no identifier)
   */
	static async syncFromEndpoint(endpoint: Endpoint): Promise<void> {
		if (!endpoint.id) return;

		const endpointId = endpoint.id;
		const protocol = endpoint.protocol;
		const lastSeenAt = endpoint.lastSeenAt ?? null;

		if (protocol === 'modbus') {
			const slaveId = endpoint.connection?.slaveId;
			if (slaveId === undefined) return;

			await this.upsertDevice({
				uuid: endpoint.uuid || randomUUID(),
				endpoint_id: endpointId,
				name: endpoint.name,
				protocol,
				enabled: endpoint.enabled,
				identifier: String(slaveId),
				metadata: { slaveId },
				lastSeenAt,
			});

		} else if (protocol === 'opcua') {
			const dataPoints: any[] = endpoint.data_points || [];

			// Collect distinct device_uuid values (undefined → '__default__'), along
			// with a representative friendly name if the server exposed one (the
			// browseName of the folder that owns the DeviceUUID marker — see
			// discovery.ts's folderDeviceName — e.g. "FCU-11A", not every server
			// provides this).
			const seen = new Map<string, { nodeCount: number; deviceName?: string }>();
			for (const dp of dataPoints) {
				const key = dp.device_uuid || '__default__';
				const existing = seen.get(key);
				seen.set(key, {
					nodeCount: (existing?.nodeCount ?? 0) + 1,
					deviceName: existing?.deviceName || dp.device_name,
				});
			}

			if (seen.size === 0) {
				// No data points yet — placeholder device for the server
				await this.upsertDevice({
					uuid: endpoint.uuid || randomUUID(),
					endpoint_id: endpointId,
					name: endpoint.name,
					protocol,
					enabled: endpoint.enabled,
					identifier: null,
					lastSeenAt,
				});
				return;
			}

			const hasIdentifiedDevices = [...seen.keys()].some(k => k !== '__default__');

			for (const [deviceUuid, { nodeCount, deviceName }] of seen) {
				const isDefault = deviceUuid === '__default__';

				// Skip the catch-all default group when there are real identified devices.
				// Stray untagged nodes are an artefact of servers that only partially expose
				// DeviceUUID — they don't represent a distinct physical device.
				// Only emit a default row when the server exposes NO device grouping at all.
				if (isDefault && hasIdentifiedDevices) continue;

				// Prefer the device's own reported friendly name (e.g. "FCU-11A", from
				// discovery.ts's folderDeviceName) when the server exposed one — matches
				// how BACnet/etc. use their own objectName. Falls back to the technical
				// "{endpoint.name}-{suffix}" format (same one src/plugins/index.ts's
				// buildDeviceNames constructs for the live telemetry deviceName — see
				// deviceNameSuffix() above) for servers that don't provide a friendly
				// name. NOTE: when a friendly name IS used here, it intentionally
				// diverges from the telemetry-tag deviceName in plugins/index.ts, which
				// doesn't have this friendly name available at live-read time — devices
				// still correlate correctly via the uuid/identifier columns, just the
				// display strings differ between this table and raw telemetry.
				const uuidSuffix = isDefault ? '' : deviceNameSuffixFor(endpoint.name, deviceUuid);
				const devName = isDefault
					? endpoint.name
					: (deviceName || (uuidSuffix ? `${endpoint.name}-${uuidSuffix}` : endpoint.name));

				await this.upsertDevice({
					uuid: isDefault ? (endpoint.uuid || randomUUID()) : toDeviceUuid(deviceUuid),
					endpoint_id: endpointId,
					name: devName,
					protocol,
					enabled: endpoint.enabled,
					identifier: isDefault ? null : deviceUuid,
					metadata: { nodeCount },
					lastSeenAt,
				});
			}

		} else {
			// BACnet, SNMP, MQTT, CAN — 1:1 with the endpoint.
			// endpoint.name is a sanitized identifier (lowercased, no punctuation) used
			// internally; objectName (captured at discovery time from the device itself,
			// e.g. BACnet's Device object-name property) is the human-readable name the
			// physical device actually reports — carry it through so the admin UI can
			// display "RTU-1" instead of "rtu_1_2001".
			const objectName = typeof endpoint.metadata?.objectName === 'string' ? endpoint.metadata.objectName : undefined;

			await this.upsertDevice({
				uuid: endpoint.uuid || randomUUID(),
				endpoint_id: endpointId,
				name: endpoint.name,
				protocol,
				enabled: endpoint.enabled,
				identifier: null,
				metadata: objectName ? { objectName } : undefined,
				lastSeenAt,
			});
		}
	}

	/** Remove a device row. It reappears on the endpoint's next discovery/sync
   * if the endpoint is still reachable — this only clears the cached row,
   * it doesn't disable or delete the underlying endpoint. */
	static async deleteByUuid(uuid: string): Promise<boolean> {
		const result = this.getDb().prepare(`DELETE FROM ${this.table} WHERE uuid = ?`).run(uuid);
		return result.changes > 0;
	}

	private static parse(row: DeviceRow): Device {
		return {
			...row,
			enabled: Boolean(row.enabled),
			metadata: row.metadata
				? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata)
				: undefined,
		};
	}
}
