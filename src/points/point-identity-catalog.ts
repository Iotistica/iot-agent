import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transact } from '../db/sqlite.js';
import { canonicalizeAddress, CANONICAL_ADDRESS_VERSION, MAX_CANONICAL_ADDRESS_BYTES, type AddressProtocol } from './canonical-address.js';
import { MAX_MQTT_FIELD_IDENTITIES } from './mqtt-configured-fields.js';

export interface PointScope {
	endpointUuid: string;
	protocol: AddressProtocol;
}

export interface PointAddress extends PointScope {
	version: number;
	key: string;
}

export interface PointIdentityRecord extends PointScope {
	pointUuid: string;
	deviceUuid: string | null;
}

export interface PointAlias extends PointScope {
	kind: string;
	key: string;
	evidence: string;
}

export type CatalogReason =
	| 'not-found' | 'source-missing' | 'source-ambiguous' | 'protocol-mismatch'
	| 'invalid-input' | 'evidence-missing' | 'stale-configuration'
	| 'identity-ambiguous' | 'address-conflict' | 'alias-conflict'
	| 'association-conflict' | 'version-unreconciled'
	| 'foreign-keys-disabled' | 'read-only' | 'transaction-active' | 'reentrant-operation' | 'busy'
	| 'field-capacity-exceeded';

export type CatalogResult<T> =
	| { status: 'resolved'; value: T }
	| { status: 'unresolved'; reason: CatalogReason; retryable: boolean };

export type CatalogEvidenceRequest =
	| { operation: 'resolve'; address: PointAddress; aliases: readonly PointAlias[]; evidence: unknown }
	| { operation: 'create'; address: PointAddress; evidence: unknown }
	| { operation: 'attach-address'; pointUuid: string; address: PointAddress; evidence: unknown }
	| { operation: 'attach-alias'; pointUuid: string; alias: PointAlias; evidence: unknown }
	| { operation: 'associate'; pointUuid: string; scope: PointScope; deviceUuid: string | null; expectedDeviceUuid: string | null; associationSource: string; evidence: unknown };

export interface CatalogEvidenceVerifier {
	verify(request: CatalogEvidenceRequest): boolean;
}

type SourceRow = Record<string, unknown> & {
	id: number;
	uuid: string;
	protocol: string;
};
type IdentityRow = { point_uuid: string | null; endpoint_uuid: string | null; protocol: string | null; device_uuid: string | null };
type AliasRow = { alias_kind: string; alias_key: string; evidence: string };

const protocols = new Set<string>(['opcua', 'mqtt', 'modbus', 'bacnet']);
const busyAttempts = 3;
const busyDelayMs = 10;
const verifyingConnections = new WeakSet<DatabaseSync>();

function isProtocol(value: string): value is AddressProtocol {
	return protocols.has(value);
}

function unresolved<T>(reason: CatalogReason, retryable = false): CatalogResult<T> {
	return { status: 'unresolved', reason, retryable };
}

function resolved<T>(value: T): CatalogResult<T> {
	return { status: 'resolved', value };
}

function nonempty(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0') &&
		!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}

function validScope(scope: PointScope): boolean {
	return scope !== null && typeof scope === 'object' && nonempty(scope.endpointUuid) && isProtocol(scope.protocol);
}

function validAddress(address: PointAddress): boolean {
	return validScope(address) && Number.isSafeInteger(address.version) && address.version > 0 &&
		nonempty(address.key) && Buffer.byteLength(address.key, 'utf8') <= MAX_CANONICAL_ADDRESS_BYTES;
}

function validAlias(alias: PointAlias): boolean {
	return validScope(alias) && nonempty(alias.kind) && nonempty(alias.key) && nonempty(alias.evidence);
}

function sameScope(left: PointScope, right: PointScope): boolean {
	return left.endpointUuid === right.endpointUuid && left.protocol === right.protocol;
}

function isBusy(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_SQLITE_ERROR' &&
		'errcode' in error && typeof error.errcode === 'number' &&
		(error.errcode & 0xff) === 5;
}

function identity(row: IdentityRow): PointIdentityRecord {
	if (row.point_uuid === null || row.endpoint_uuid === null || row.protocol === null || !isProtocol(row.protocol)) {
		throw new Error('Stored point identity has an invalid scope or protocol');
	}
	return {
		pointUuid: row.point_uuid,
		endpointUuid: row.endpoint_uuid,
		protocol: row.protocol,
		deviceUuid: row.device_uuid,
	};
}

function storedMqttSelector(key: string): 'whole' | 'path' | undefined {
	let parts: unknown;
	try {
		parts = JSON.parse(key);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parts) || parts.length !== 2 || !Array.isArray(parts[1])) return undefined;
	const selector = parts[1];
	let input: unknown;
	if (selector.length === 1 && selector[0] === 'whole') {
		input = { kind: 'whole' };
	} else if (selector.length === 2 && selector[0] === 'path' && Array.isArray(selector[1])) {
		const tokens: unknown[] = [];
		for (const token of selector[1]) {
			if (!Array.isArray(token) || token.length !== 2) return undefined;
			if (token[0] === 'key') tokens.push({ kind: 'key', key: token[1] });
			else if (token[0] === 'index') tokens.push({ kind: 'index', index: token[1] });
			else return undefined;
		}
		input = { kind: 'path', tokens };
	} else return undefined;
	const result = canonicalizeAddress({ protocol: 'mqtt', topic: parts[0], selector: input, selectorSource: 'configured' });
	return result.status === 'resolved' && result.addressKey === key ? selector[0] : undefined;
}

/**
 * Isolated catalog. The optional verifier has no production implementation;
 * callers without one cannot create, attach, reconcile or change associations.
 */
export class PointIdentityCatalog {
	constructor(private readonly db: DatabaseSync, private readonly verifier?: CatalogEvidenceVerifier) {}

	private foreignKeysEnabled(): boolean {
		return this.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys === 1;
	}

	private verify(request: CatalogEvidenceRequest): CatalogResult<true> {
		if (this.db.isTransaction === true) return unresolved('transaction-active');
		if (verifyingConnections.has(this.db)) return unresolved('reentrant-operation');
		if (!this.verifier) return unresolved('evidence-missing');
		verifyingConnections.add(this.db);
		try {
			return this.verifier.verify(Object.freeze(request)) === true ? resolved(true) : unresolved('evidence-missing');
		} finally {
			verifyingConnections.delete(this.db);
		}
	}

	private source(scope: PointScope): CatalogResult<SourceRow> {
		if (!validScope(scope)) return unresolved('invalid-input');
		const rows = this.db.prepare('SELECT * FROM endpoints WHERE uuid = ? LIMIT 2')
			.all(scope.endpointUuid) as SourceRow[];
		if (rows.length === 0) return unresolved('source-missing');
		if (rows.length !== 1) return unresolved('source-ambiguous');
		if (rows[0].protocol !== scope.protocol) return unresolved('protocol-mismatch');
		return resolved(rows[0]);
	}

	private point(pointUuid: string, scope: PointScope): CatalogResult<PointIdentityRecord> {
		const row = this.db.prepare(`
			SELECT point_uuid, endpoint_uuid, protocol, device_uuid FROM point_identity WHERE point_uuid = ?
		`).get(pointUuid) as IdentityRow | undefined;
		if (!row) return unresolved('not-found');
		const result = identity(row);
		if (!sameScope(result, scope)) return unresolved('protocol-mismatch');
		return resolved(result);
	}

	private addressOwner(address: PointAddress): PointIdentityRecord | undefined {
		const row = this.db.prepare(`
			SELECT p.point_uuid, p.endpoint_uuid, p.protocol, p.device_uuid
			FROM point_identity_address a LEFT JOIN point_identity p ON p.point_uuid = a.point_uuid
			WHERE a.endpoint_uuid = ? AND a.protocol = ? AND a.address_version = ? AND a.address_key = ?
		`).get(address.endpointUuid, address.protocol, address.version, address.key) as IdentityRow | undefined;
		if (row?.point_uuid === null) throw new Error('Point address references a missing identity');
		return row ? identity(row) : undefined;
	}

	private aliasOwner(alias: PointAlias): PointIdentityRecord | undefined {
		const row = this.db.prepare(`
			SELECT p.point_uuid, p.endpoint_uuid, p.protocol, p.device_uuid
			FROM point_identity_alias a LEFT JOIN point_identity p ON p.point_uuid = a.point_uuid
			WHERE a.endpoint_uuid = ? AND a.alias_kind = ? AND a.alias_key = ?
		`).get(alias.endpointUuid, alias.kind, alias.key) as IdentityRow | undefined;
		if (row?.point_uuid === null) throw new Error('Point alias references a missing identity');
		return row ? identity(row) : undefined;
	}

	findByCanonicalAddress(address: PointAddress): CatalogResult<PointIdentityRecord> {
		if (!this.foreignKeysEnabled()) return unresolved('foreign-keys-disabled');
		if (!validAddress(address)) return unresolved('invalid-input');
		if (address.version !== CANONICAL_ADDRESS_VERSION) return unresolved('version-unreconciled');
		const source = this.source(address);
		if (source.status === 'unresolved') return source;
		const owner = this.addressOwner(address);
		if (owner && !sameScope(owner, address)) return unresolved('identity-ambiguous');
		return owner ? resolved(owner) : unresolved('not-found');
	}

	findAliases(scope: PointScope, pointUuid: string): CatalogResult<PointAlias[]> {
		if (!this.foreignKeysEnabled()) return unresolved('foreign-keys-disabled');
		if (!validScope(scope) || !nonempty(pointUuid)) return unresolved('invalid-input');
		const source = this.source(scope);
		if (source.status === 'unresolved') return source;
		const point = this.point(pointUuid, scope);
		if (point.status === 'unresolved') return point;
		const rows = this.db.prepare(`
			SELECT alias_kind, alias_key, evidence FROM point_identity_alias
			WHERE endpoint_uuid = ? AND point_uuid = ? ORDER BY alias_kind, alias_key
		`).all(scope.endpointUuid, pointUuid) as AliasRow[];
		return resolved(rows.map(row => ({
			endpointUuid: scope.endpointUuid, protocol: scope.protocol,
			kind: row.alias_kind, key: row.alias_key, evidence: row.evidence,
		})));
	}

	resolveExistingIdentity(address: PointAddress, aliases: readonly PointAlias[], evidence: unknown): CatalogResult<PointIdentityRecord> {
		if (!this.foreignKeysEnabled()) return unresolved('foreign-keys-disabled');
		if (!validAddress(address) || !Array.isArray(aliases) ||
			aliases.some(alias => !validAlias(alias) || !sameScope(address, alias))) return unresolved('invalid-input');
		address = Object.freeze({ ...address });
		aliases = Object.freeze(aliases.map(alias => Object.freeze({ ...alias })));
		if (address.version !== CANONICAL_ADDRESS_VERSION) return unresolved('version-unreconciled');
		const source = this.source(address);
		if (source.status === 'unresolved') return source;
		const verification = this.verify({ operation: 'resolve', address, aliases, evidence });
		if (verification.status === 'unresolved') return verification;
		if (!this.foreignKeysEnabled()) return unresolved('foreign-keys-disabled');
		if (this.db.isTransaction === true) return unresolved('transaction-active');
		return transact(this.db, () => {
			const current = this.source(address);
			if (current.status === 'unresolved') return current;
			if (JSON.stringify(source.value) !== JSON.stringify(current.value)) return unresolved('stale-configuration');
			const addressOwner = this.addressOwner(address);
			if (addressOwner && !sameScope(addressOwner, address)) return unresolved('identity-ambiguous');
			const owners = [addressOwner, ...aliases.map(alias => this.aliasOwner(alias))].filter(
				(owner): owner is PointIdentityRecord => owner !== undefined,
			);
			if (owners.some(owner => !sameScope(owner, address))) return unresolved('alias-conflict');
			if (new Set(owners.map(owner => owner.pointUuid)).size > 1) return unresolved('identity-ambiguous');
			return owners.length ? resolved(owners[0]) : unresolved('not-found');
		});
	}

	async createIdentityIfAbsent(address: PointAddress, evidence: unknown): Promise<CatalogResult<PointIdentityRecord>> {
		if (!validAddress(address)) return unresolved('invalid-input');
		address = Object.freeze({ ...address });
		if (address.version !== CANONICAL_ADDRESS_VERSION) return unresolved('version-unreconciled');
		return this.write(address, { operation: 'create', address, evidence }, () => {
			const owner = this.addressOwner(address);
			if (owner) return sameScope(owner, address) ? resolved(owner) : unresolved('identity-ambiguous');
			if (address.protocol === 'mqtt') {
				const kind = storedMqttSelector(address.key);
				if (kind === 'path') {
					const rows = this.db.prepare(`
						SELECT address_key FROM point_identity_address WHERE endpoint_uuid = ? AND protocol = 'mqtt'
					`).all(address.endpointUuid) as Array<{ address_key: string }>;
					let count = 0;
					for (const row of rows) {
						const stored = storedMqttSelector(row.address_key);
						if (!stored) return unresolved('invalid-input');
						if (stored === 'path') count++;
					}
					if (count >= MAX_MQTT_FIELD_IDENTITIES) return unresolved('field-capacity-exceeded');
				}
			}
			const otherVersion = this.db.prepare(`
				SELECT 1 FROM point_identity_address WHERE endpoint_uuid = ? AND protocol = ? AND address_version != ? LIMIT 1
			`).get(address.endpointUuid, address.protocol, address.version);
			if (otherVersion) return unresolved('version-unreconciled');
			const pointUuid = randomUUID();
			this.db.prepare('INSERT INTO point_identity (point_uuid, endpoint_uuid, protocol) VALUES (?, ?, ?)')
				.run(pointUuid, address.endpointUuid, address.protocol);
			this.db.prepare(`
				INSERT INTO point_identity_address (endpoint_uuid, protocol, address_version, address_key, point_uuid)
				VALUES (?, ?, ?, ?, ?)
			`).run(address.endpointUuid, address.protocol, address.version, address.key, pointUuid);
			return resolved({ endpointUuid: address.endpointUuid, protocol: address.protocol, pointUuid, deviceUuid: null });
		});
	}

	async attachVerifiedAddress(pointUuid: string, address: PointAddress, evidence: unknown): Promise<CatalogResult<PointIdentityRecord>> {
		if (!nonempty(pointUuid) || !validAddress(address)) return unresolved('invalid-input');
		address = Object.freeze({ ...address });
		if (address.version !== CANONICAL_ADDRESS_VERSION) return unresolved('version-unreconciled');
		return this.write(address, { operation: 'attach-address', pointUuid, address, evidence }, () => {
			const point = this.point(pointUuid, address);
			if (point.status === 'unresolved') return point;
			const owner = this.addressOwner(address);
			if (owner) return owner.pointUuid === pointUuid ? resolved(owner) : unresolved('address-conflict');
			const sameVersion = this.db.prepare(`
				SELECT 1 FROM point_identity_address WHERE point_uuid = ? AND address_version = ? LIMIT 1
			`).get(pointUuid, address.version);
			if (sameVersion) return unresolved('address-conflict');
			this.db.prepare(`
				INSERT INTO point_identity_address (endpoint_uuid, protocol, address_version, address_key, point_uuid)
				VALUES (?, ?, ?, ?, ?)
			`).run(address.endpointUuid, address.protocol, address.version, address.key, pointUuid);
			return point;
		});
	}

	async attachVerifiedAlias(pointUuid: string, alias: PointAlias, evidence: unknown): Promise<CatalogResult<PointIdentityRecord>> {
		if (!nonempty(pointUuid) || !validAlias(alias)) return unresolved('invalid-input');
		alias = Object.freeze({ ...alias });
		return this.write(alias, { operation: 'attach-alias', pointUuid, alias, evidence }, () => {
			const point = this.point(pointUuid, alias);
			if (point.status === 'unresolved') return point;
			const owner = this.aliasOwner(alias);
			if (owner) return owner.pointUuid === pointUuid && sameScope(owner, alias) ? resolved(owner) : unresolved('alias-conflict');
			this.db.prepare(`
				INSERT INTO point_identity_alias (endpoint_uuid, alias_kind, alias_key, point_uuid, evidence)
				VALUES (?, ?, ?, ?, ?)
			`).run(alias.endpointUuid, alias.kind, alias.key, pointUuid, alias.evidence);
			return point;
		});
	}

	async updateOptionalDeviceAssociation(
		pointUuid: string, scope: PointScope, deviceUuid: string | null, expectedDeviceUuid: string | null,
		associationSource: string, evidence: unknown,
	): Promise<CatalogResult<PointIdentityRecord>> {
		if (!nonempty(pointUuid) || !validScope(scope) || (deviceUuid !== null && !nonempty(deviceUuid)) ||
			(expectedDeviceUuid !== null && !nonempty(expectedDeviceUuid)) || !nonempty(associationSource)) return unresolved('invalid-input');
		scope = Object.freeze({ ...scope });
		return this.write(scope, { operation: 'associate', pointUuid, scope, deviceUuid, expectedDeviceUuid, associationSource, evidence }, (source) => {
			const point = this.point(pointUuid, scope);
			if (point.status === 'unresolved') return point;
			if (point.value.deviceUuid !== expectedDeviceUuid) return unresolved('association-conflict');
			if (deviceUuid !== null) {
				const confirmed = this.db.prepare(`
					SELECT 1 FROM devices d WHERE d.uuid = ? AND d.endpoint_id = ? AND d.protocol = ?
					AND (EXISTS (SELECT 1 FROM device_resolution_keys k WHERE k.endpoint_id = d.endpoint_id AND k.device_uuid = d.uuid)
						OR EXISTS (SELECT 1 FROM device_resolution_points p WHERE p.endpoint_id = d.endpoint_id AND p.device_uuid = d.uuid))
				`).get(deviceUuid, source.id, scope.protocol);
				if (!confirmed) return unresolved('association-conflict');
			}
			const current = this.db.prepare('SELECT association_source FROM point_identity WHERE point_uuid = ?')
				.get(pointUuid) as { association_source: string | null };
			if (point.value.deviceUuid === deviceUuid && current.association_source === associationSource) return point;
			this.db.prepare(`
				UPDATE point_identity SET device_uuid = ?, association_source = ?, updated_at = CURRENT_TIMESTAMP
				WHERE point_uuid = ? AND endpoint_uuid = ? AND protocol = ?
			`).run(deviceUuid, associationSource, pointUuid, scope.endpointUuid, scope.protocol);
			return resolved({ ...point.value, deviceUuid });
		});
	}

	private async write<T>(
		scope: PointScope, request: CatalogEvidenceRequest, operation: (source: SourceRow) => CatalogResult<T>,
	): Promise<CatalogResult<T>> {
		if (!this.foreignKeysEnabled()) return unresolved('foreign-keys-disabled');
		if (this.db.prepare('PRAGMA query_only').get()?.query_only === 1) return unresolved('read-only');
		const before = this.source(scope);
		if (before.status === 'unresolved') return before;
		const verification = this.verify(request);
		if (verification.status === 'unresolved') return verification;
		for (let attempt = 0; attempt < busyAttempts; attempt++) {
			if (!this.foreignKeysEnabled()) return unresolved('foreign-keys-disabled');
			if (this.db.prepare('PRAGMA query_only').get()?.query_only === 1) return unresolved('read-only');
			if (this.db.isTransaction === true) return unresolved('transaction-active');
			try {
				if (attempt > 0) {
					// Evidence can expire while waiting for the write lock.
					const currentVerification = this.verify(request);
					if (currentVerification.status === 'unresolved') return currentVerification;
				}
				return transact(this.db, () => {
					const current = this.source(scope);
					if (current.status === 'unresolved') return current;
					if (JSON.stringify(current.value) !== JSON.stringify(before.value)) return unresolved('stale-configuration');
					return operation(current.value);
				}, 'IMMEDIATE');
			} catch (error) {
				if (!isBusy(error)) throw error;
				if (attempt === busyAttempts - 1) return unresolved('busy', true);
				await new Promise<void>(resolve => setTimeout(resolve, busyDelayMs * (attempt + 1)));
			}
		}
		throw new Error('Unreachable catalog retry state');
	}
}
