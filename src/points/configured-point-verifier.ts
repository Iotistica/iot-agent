import type { DatabaseSync } from 'node:sqlite';
import {
	canonicalizeAddress, CANONICAL_ADDRESS_VERSION,
	type CanonicalAddressInput, type CanonicalAddressResult,
} from './canonical-address.js';
import type { CatalogEvidenceRequest, CatalogEvidenceVerifier } from './point-identity-catalog.js';
import { resolveMqttConfiguredFields } from './mqtt-configured-fields.js';

export interface VerifierEvidence {
	resolverRef: object;
	canonicalInput: CanonicalAddressInput;
	endpointUuid: string;
	protocol: string;
	ambiguousAddressKeys?: ReadonlySet<string>;
	isCurrent?: () => boolean;
}

function isVerifierEvidence(value: unknown): value is VerifierEvidence {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const ev = value as Record<string, unknown>;
	return typeof ev.resolverRef === 'object' && ev.resolverRef !== null &&
		typeof ev.canonicalInput === 'object' && ev.canonicalInput !== null &&
		typeof ev.endpointUuid === 'string' && ev.endpointUuid.length > 0 &&
		typeof ev.protocol === 'string' && ev.protocol.length > 0 &&
		(ev.isCurrent === undefined || typeof ev.isCurrent === 'function');
}

type EndpointRow = { uuid: string; protocol: string; connection: string; revision: number };

export class ConfiguredPointVerifier implements CatalogEvidenceVerifier {
	private readonly authorizedResolver: WeakRef<object>;
	private stmtEndpoint: ReturnType<DatabaseSync['prepare']> | undefined;
	private stmtRevision: ReturnType<DatabaseSync['prepare']> | undefined;
	private endpointCache = new Map<string, { revision: number; row: EndpointRow } | null>();

	constructor(
		private readonly db: DatabaseSync,
		resolverRef: object,
	) {
		this.authorizedResolver = new WeakRef(resolverRef);
	}

	private getEndpoint(endpointUuid: string): EndpointRow | undefined {
		const cached = this.endpointCache.get(endpointUuid);
		if (cached !== undefined) {
			if (cached === null) return undefined;
			this.stmtRevision ??= this.db.prepare('SELECT revision FROM endpoints WHERE uuid = ? AND enabled = 1 LIMIT 1');
			const rev = this.stmtRevision.get(endpointUuid) as { revision: number } | undefined;
			if (rev && rev.revision === cached.revision) return cached.row;
			this.endpointCache.delete(endpointUuid);
		}
		this.stmtEndpoint ??= this.db.prepare('SELECT uuid, protocol, connection, revision FROM endpoints WHERE uuid = ? AND enabled = 1 LIMIT 1');
		const row = this.stmtEndpoint.get(endpointUuid) as EndpointRow | undefined;
		if (!row) { this.endpointCache.set(endpointUuid, null); return undefined; }
		this.endpointCache.set(endpointUuid, { revision: row.revision, row });
		return row;
	}

	verify(request: CatalogEvidenceRequest): boolean {
		if (request.operation !== 'create' && request.operation !== 'resolve') return false;

		const evidence = request.evidence;
		if (!isVerifierEvidence(evidence)) return false;

		const resolver = this.authorizedResolver.deref();
		if (!resolver || evidence.resolverRef !== resolver) return false;
		if (evidence.isCurrent && !evidence.isCurrent()) return false;

		if (request.operation === 'create' || request.operation === 'resolve') {
			const address = request.address;
			if (address.endpointUuid !== evidence.endpointUuid) return false;
			if (address.protocol !== evidence.protocol) return false;

			const row = this.getEndpoint(evidence.endpointUuid);
			if (!row) return false;
			if (row.protocol !== evidence.protocol) return false;
			if (evidence.canonicalInput.protocol === 'mqtt' && evidence.canonicalInput.selector.kind === 'path') {
				let connection: unknown;
				try {
					connection = JSON.parse(row.connection);
				} catch {
					return false;
				}
				const fields = resolveMqttConfiguredFields(connection);
				if (fields.status !== 'resolved' ||
					!fields.fields.some(field => field.addressKey === address.key)) return false;
			}
		}

		if (request.operation === 'create') {
			const rederived: CanonicalAddressResult = canonicalizeAddress(evidence.canonicalInput);
			if (rederived.status !== 'resolved') return false;
			if (rederived.version !== CANONICAL_ADDRESS_VERSION) return false;
			if (rederived.addressKey !== request.address.key) return false;
			if (rederived.protocol !== request.address.protocol) return false;
		}

		if (evidence.ambiguousAddressKeys?.has(request.address.key)) return false;

		return true;
	}
}
