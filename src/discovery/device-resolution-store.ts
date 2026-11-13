import type { DatabaseSync } from 'node:sqlite';
import { transact } from '../db/sqlite.js';
import {
	confirmDeviceResolution,
	previewDeviceResolution,
	type ConfirmedDeviceIdentity,
	type ConfirmedDeviceResolution,
	type DeviceResolutionCandidate,
	type DeviceResolutionPreview,
} from './device-resolution.js';

type SourceRow = { id: number; protocol: string };
type KeyRow = { device_uuid: string; kind: string; value: string };

function sourceByUuid(db: DatabaseSync, sourceUuid: string): SourceRow {
	const source = db.prepare('SELECT id, protocol FROM endpoints WHERE uuid = ?').get(sourceUuid) as SourceRow | undefined;
	if (!source) throw new Error('Source not found');
	return source;
}

function identities(db: DatabaseSync, sourceUuid: string, endpointId: number): ConfirmedDeviceIdentity[] {
	const rows = db.prepare(`
		SELECT k.device_uuid, k.kind, k.value
		FROM device_resolution_keys k
		JOIN devices d ON d.uuid = k.device_uuid AND d.endpoint_id = k.endpoint_id
		WHERE k.endpoint_id = ?
		ORDER BY k.device_uuid, k.kind, k.value
	`).all(endpointId) as KeyRow[];
	const devices = new Map<string, ConfirmedDeviceIdentity>();
	for (const row of rows) {
		let identity = devices.get(row.device_uuid);
		if (!identity) {
			identity = { sourceUuid, deviceUuid: row.device_uuid, keys: [] };
			devices.set(row.device_uuid, identity);
		}
		identity.keys.push({ kind: row.kind, value: row.value });
	}
	return [...devices.values()];
}

function addPointConflicts(db: DatabaseSync, endpointId: number, previews: DeviceResolutionPreview[]): void {
	const rows = db.prepare('SELECT address, device_uuid FROM device_resolution_points WHERE endpoint_id = ?')
		.all(endpointId) as Array<{ address: string; device_uuid: string }>;
	const owners = new Map(rows.map(row => [row.address, row.device_uuid]));
	for (const item of previews) {
		if (item.candidate.pointAddresses.some(address => owners.has(address) && owners.get(address) !== item.deviceUuid)) {
			item.status = 'conflict';
			delete item.deviceUuid;
			item.conflicts.push('A point is already assigned to another confirmed device');
		}
	}
}

/** Persistent, source-scoped identity evidence shared by protocol adapters. */
export class DeviceResolutionStore {
	constructor(private readonly db: DatabaseSync) {}

	preview(sourceUuid: string, candidates: DeviceResolutionCandidate[]): DeviceResolutionPreview[] {
		const source = sourceByUuid(this.db, sourceUuid);
		const previews = previewDeviceResolution(sourceUuid, candidates, identities(this.db, sourceUuid, source.id));
		addPointConflicts(this.db, source.id, previews);
		return previews;
	}

	/**
	 * Reconciles against current database state under a write lock. Callers must
	 * obtain candidates from a fresh protocol scan, not from untrusted client data.
	 */
	confirm(sourceUuid: string, candidates: DeviceResolutionCandidate[], selectedCandidateIds: string[]): ConfirmedDeviceResolution[] {
		return transact(this.db, () => {
			const source = sourceByUuid(this.db, sourceUuid);
			const resolutions = confirmDeviceResolution(
				sourceUuid, candidates, identities(this.db, sourceUuid, source.id), selectedCandidateIds,
			);
			const pointOwner = this.db.prepare(
				'SELECT device_uuid FROM device_resolution_points WHERE endpoint_id = ? AND address = ?',
			);
			for (const resolution of resolutions) {
				for (const address of resolution.pointAddresses) {
					const owner = pointOwner.get(source.id, address) as { device_uuid: string } | undefined;
					if (owner && owner.device_uuid !== resolution.identity.deviceUuid) {
						throw new Error(`Point "${address}" is already assigned to another confirmed device`);
					}
				}
			}

			const insertDevice = this.db.prepare(`
				INSERT INTO devices (uuid, endpoint_id, name, protocol, enabled, identifier)
				VALUES (?, ?, ?, ?, 1, ?)
			`);
			const findDevice = this.db.prepare('SELECT endpoint_id FROM devices WHERE uuid = ?');
			const insertKey = this.db.prepare(`
				INSERT INTO device_resolution_keys (endpoint_id, device_uuid, kind, value)
				VALUES (?, ?, ?, ?)
				ON CONFLICT (endpoint_id, kind, value) DO UPDATE SET device_uuid = excluded.device_uuid
				WHERE device_resolution_keys.device_uuid = excluded.device_uuid
			`);
			const clearPoints = this.db.prepare('DELETE FROM device_resolution_points WHERE endpoint_id = ? AND device_uuid = ?');
			const insertPoint = this.db.prepare('INSERT INTO device_resolution_points (endpoint_id, device_uuid, address) VALUES (?, ?, ?)');
			for (const resolution of resolutions) {
				const { deviceUuid, keys } = resolution.identity;
				const device = findDevice.get(deviceUuid) as { endpoint_id: number } | undefined;
				if (device && device.endpoint_id !== source.id) throw new Error('Device belongs to a different source');
				if (!device) {
					const candidate = candidates.find(item => item.candidateId === resolution.candidateId)!;
					insertDevice.run(deviceUuid, source.id, candidate.name, source.protocol, deviceUuid);
				}
				for (const key of keys) {
					if (insertKey.run(source.id, deviceUuid, key.kind, key.value).changes !== 1) {
						throw new Error('Identity evidence belongs to another device');
					}
				}
				clearPoints.run(source.id, deviceUuid);
				for (const address of new Set(resolution.pointAddresses)) insertPoint.run(source.id, deviceUuid, address);
			}
			return resolutions;
		}, 'IMMEDIATE');
	}
}
