import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../db/sqlite.js';
import { EndpointModel, type Endpoint } from '../db/models/endpoint.model.js';
import {
	CANONICAL_ADDRESS_VERSION, canonicalizeAddress,
	type CanonicalAddressResult, type MqttSelector,
} from '../points/canonical-address.js';
import { PointIdentityCatalog } from '../points/point-identity-catalog.js';
import { resolveEndpoint } from '../points/configured-point-resolver.js';
import { resolveMqttConfiguredFields } from '../points/mqtt-configured-fields.js';
import { requireRole } from './middleware/roles.js';
import { getAdapterManager } from './actions.js';

export interface ConfiguredPointRow {
	name: string;
	protocolAddress: string | Record<string, unknown> | null;
	canonicalStatus: 'resolved' | 'unresolved' | 'deferred';
	canonicalReason: string | null;
	identityStatus: 'resolved' | 'unresolved' | 'deferred';
	identityReason: string | null;
	pointUuid?: string;
	deviceUuid?: string;
	deviceName?: string;
}

export type ConfiguredEndpoint = Omit<Endpoint, 'protocol'> & { protocol: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pointName(point: Record<string, unknown>, index: number): string {
	for (const key of ['name', 'subTopic', 'fullTopic', 'nodeId']) {
		if (typeof point[key] === 'string' && point[key]) return point[key];
	}
	return `unnamed-${index + 1}`;
}

function protocolAddress(endpoint: ConfiguredEndpoint, point: Record<string, unknown>): string | Record<string, unknown> | null {
	const protocol: string = endpoint.protocol;
	switch (protocol) {
		case 'mqtt':
			return typeof point.fullTopic === 'string' ? point.fullTopic : null;
		case 'opcua':
			return typeof point.nodeId === 'string' ? point.nodeId : null;
		case 'modbus': {
			const connection = endpoint.connection ?? {};
			const address: Record<string, unknown> = {
				unitId: typeof connection.slaveId === 'number' ? connection.slaveId : 1,
				address: point.address ?? null,
			};
			for (const key of ['type', 'functionCode', 'dataType', 'count', 'byteOrder', 'endianness', 'encoding', 'scale', 'offset']) {
				if (point[key] !== undefined) address[key] = point[key];
			}
			return address;
		}
		case 'bacnet': {
			const connection = endpoint.connection ?? {};
			return {
				deviceInstance: typeof connection.deviceInstance === 'number' ? connection.deviceInstance
					: typeof connection.deviceId === 'number' ? connection.deviceId : 0,
				objectType: point.objectType ?? null,
				objectInstance: point.objectInstance ?? null,
				propertyId: point.propertyId ?? 85,
			};
		}
		default:
			return null;
	}
}

function isDeferred(reason: string | undefined): boolean {
	return reason === 'namespace-evidence-required';
}

function mqttFieldName(selector: MqttSelector): string {
	if (selector.kind !== 'path') return '';
	return selector.tokens.map(t => t.kind === 'key' ? t.key : `[${t.index}]`).join('.');
}

function findAssociatedDevice(
	db: DatabaseSync,
	endpoint: ConfiguredEndpoint,
	deviceUuid: string | null,
): { uuid: string; name: string } | undefined {
	const endpointId = endpoint.id;
	if (!deviceUuid || typeof endpointId !== 'number' || !Number.isSafeInteger(endpointId)) return undefined;
	const rows = db.prepare(`
		SELECT uuid, name FROM devices
		WHERE uuid = ? AND endpoint_id = ? AND protocol = ?
		LIMIT 2
	`).all(deviceUuid, endpointId, endpoint.protocol) as Array<{ uuid: string; name: string }>;
	if (rows.length !== 1 || rows[0].uuid !== deviceUuid || typeof rows[0].name !== 'string') return undefined;
	return rows[0];
}

/**
 * Resolves configured addresses and performs catalog lookups only. It never
 * creates or otherwise mutates point identities.
 */
export function getConfiguredPointRows(
	endpoint: ConfiguredEndpoint,
	db: DatabaseSync,
	opcuaEvidence?: { namespaceArray: readonly string[]; validatedNodeIds: ReadonlySet<string> },
): ConfiguredPointRow[] {
	const evidenceCheck = opcuaEvidence && canonicalizeAddress({
		protocol: 'opcua', nodeId: 'i=2255',
		namespaceArray: { verified: true, uris: opcuaEvidence.namespaceArray },
		nodeIdVerifiedAgainstNamespaceArray: true,
	});
	const verifiedEvidence = evidenceCheck?.status === 'resolved' ? opcuaEvidence : undefined;
	const configuredPoints = Array.isArray(endpoint.data_points) ? endpoint.data_points : [];
	const points = configuredPoints.map(point => isRecord(point) ? point : {});
	const resolution = resolveEndpoint({
		uuid: endpoint.uuid,
		name: endpoint.name,
		protocol: endpoint.protocol,
		connection: endpoint.connection ?? {},
		data_points: points,
	}, verifiedEvidence && { verified: true, uris: verifiedEvidence.namespaceArray });
	const duplicateAddressKeys = new Set<string>();
	const addressCounts = new Map<string, number>();

	for (const point of resolution.points) {
		if (point.result.status !== 'resolved') continue;
		addressCounts.set(point.result.addressKey, (addressCounts.get(point.result.addressKey) ?? 0) + 1);
	}
	for (const [key, count] of addressCounts) {
		if (count > 1) duplicateAddressKeys.add(key);
	}

	const catalog = new PointIdentityCatalog(db);

	// For MQTT endpoints, resolve per-field entries from pointIdentityFields
	let mqttFieldsByTopic: Map<string, Array<Extract<CanonicalAddressResult, { status: 'resolved' }>>> | undefined;
	if (endpoint.protocol === 'mqtt') {
		const fieldsResult = resolveMqttConfiguredFields(endpoint.connection ?? {});
		if (fieldsResult.status === 'resolved' && fieldsResult.fields.length > 0) {
			mqttFieldsByTopic = new Map();
			for (const field of fieldsResult.fields) {
				if (field.provenance.protocol !== 'mqtt') continue;
				const topic = field.provenance.topic;
				let bucket = mqttFieldsByTopic.get(topic);
				if (!bucket) { bucket = []; mqttFieldsByTopic.set(topic, bucket); }
				bucket.push(field);
				addressCounts.set(field.addressKey, (addressCounts.get(field.addressKey) ?? 0) + 1);
			}
			duplicateAddressKeys.clear();
			for (const [key, count] of addressCounts) {
				if (count > 1) duplicateAddressKeys.add(key);
			}
		}
	}

	const rows: ConfiguredPointRow[] = [];
	for (let index = 0; index < resolution.points.length; index++) {
		const resolvedPoint = resolution.points[index];
		const result = endpoint.protocol === 'opcua' &&
			(typeof points[index].nodeId !== 'string' || !verifiedEvidence?.validatedNodeIds.has(points[index].nodeId as string))
			? { status: 'unresolved' as const, protocol: 'opcua', reason: 'namespace-evidence-required' as const }
			: resolvedPoint.result;

		const fullTopic = points[index].fullTopic;
		const topic = typeof fullTopic === 'string' ? fullTopic : undefined;
		const fieldEntries = topic ? mqttFieldsByTopic?.get(topic) : undefined;

		if (fieldEntries && fieldEntries.length > 0) {
			for (const field of fieldEntries) {
				const fieldName = field.provenance.protocol === 'mqtt'
					? mqttFieldName(field.provenance.selector) : '';
				const row: ConfiguredPointRow = {
					name: fieldName || `unnamed-field`,
					protocolAddress: field.provenance.protocol === 'mqtt'
						? { topic: field.provenance.topic, field: fieldName }
						: null,
					canonicalStatus: 'resolved',
					canonicalReason: null,
					identityStatus: 'unresolved',
					identityReason: null,
				};

				if (duplicateAddressKeys.has(field.addressKey)) {
					row.identityReason = 'identity-ambiguous';
					rows.push(row);
					continue;
				}

				const identity = catalog.findByCanonicalAddress({
					endpointUuid: endpoint.uuid ?? '',
					protocol: field.protocol,
					version: CANONICAL_ADDRESS_VERSION,
					key: field.addressKey,
				});
				if (identity.status === 'resolved') {
					row.identityStatus = 'resolved';
					row.identityReason = null;
					row.pointUuid = identity.value.pointUuid;
					const device = findAssociatedDevice(db, endpoint, identity.value.deviceUuid);
					if (device) {
						row.deviceUuid = device.uuid;
						row.deviceName = device.name;
					}
				} else {
					row.identityReason = identity.reason;
				}
				rows.push(row);
			}
			continue;
		}

		const row: ConfiguredPointRow = {
			name: pointName(points[index], index),
			protocolAddress: protocolAddress(endpoint, points[index]),
			canonicalStatus: result.status === 'resolved' ? 'resolved'
				: isDeferred(result.reason) ? 'deferred' : 'unresolved',
			canonicalReason: result.status === 'resolved' ? null : result.reason,
			identityStatus: result.status === 'resolved' ? 'unresolved'
				: isDeferred(result.reason) ? 'deferred' : 'unresolved',
			identityReason: result.status === 'resolved' ? null : result.reason,
		};

		if (result.status !== 'resolved') { rows.push(row); continue; }
		if (duplicateAddressKeys.has(result.addressKey)) {
			row.identityReason = 'identity-ambiguous';
			rows.push(row);
			continue;
		}

		const identity = catalog.findByCanonicalAddress({
			endpointUuid: endpoint.uuid ?? '',
			protocol: result.protocol,
			version: CANONICAL_ADDRESS_VERSION,
			key: result.addressKey,
		});
		if (identity.status === 'resolved') {
			row.identityStatus = 'resolved';
			row.identityReason = null;
			row.pointUuid = identity.value.pointUuid;
			const device = findAssociatedDevice(db, endpoint, identity.value.deviceUuid);
			if (device) {
				row.deviceUuid = device.uuid;
				row.deviceName = device.name;
			}
		} else {
			row.identityReason = identity.reason;
		}
		rows.push(row);
	}
	return rows;
}

export const configuredPointsRouter = express.Router();

configuredPointsRouter.get(
	'/v1/endpoints/:uuid/points',
	requireRole('viewer'),
	async (req: Request, res: Response, next: NextFunction) => {
		try {
			const db = getDatabase();
			const matches = db.prepare('SELECT id FROM endpoints WHERE uuid = ? LIMIT 2').all(req.params.uuid);
			if (matches.length === 0) return res.status(404).json({ error: 'Endpoint not found' });
			if (matches.length !== 1) return res.status(409).json({ error: 'Endpoint UUID is ambiguous' });

			const endpoint = await EndpointModel.getByUuid(req.params.uuid);
			if (!endpoint) return res.status(404).json({ error: 'Endpoint not found' });
			const evidence = endpoint.protocol === 'opcua'
				? getAdapterManager()?.getOpcuaNamespaceEvidence(endpoint) : undefined;
			return res.status(200).json({
				endpointUuid: req.params.uuid,
				points: getConfiguredPointRows(endpoint, db, evidence),
			});
		} catch (error) {
			next(error);
		}
	},
);
