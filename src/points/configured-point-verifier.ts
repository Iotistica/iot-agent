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

export class ConfiguredPointVerifier implements CatalogEvidenceVerifier {
	private readonly authorizedResolver: WeakRef<object>;

	constructor(
		private readonly db: DatabaseSync,
		resolverRef: object,
	) {
		this.authorizedResolver = new WeakRef(resolverRef);
	}

	verify(request: CatalogEvidenceRequest): boolean {
		if (request.operation !== 'create' && request.operation !== 'resolve') return false;

		const evidence = request.evidence;
		if (!isVerifierEvidence(evidence)) return false;

		// 1. Authorization: confirm the caller is the authorized resolver instance
		const resolver = this.authorizedResolver.deref();
		if (!resolver || evidence.resolverRef !== resolver) return false;
		if (evidence.isCurrent && !evidence.isCurrent()) return false;

		// 2. Persistent source: verify endpoint exists in DB and protocol matches
		if (request.operation === 'create' || request.operation === 'resolve') {
			const address = request.address;
			if (address.endpointUuid !== evidence.endpointUuid) return false;
			if (address.protocol !== evidence.protocol) return false;

			const row = this.db.prepare('SELECT uuid, protocol, connection FROM endpoints WHERE uuid = ? AND enabled = 1 LIMIT 1')
				.get(evidence.endpointUuid) as { uuid: string; protocol: string; connection: string } | undefined;
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

		// 3. Canonical address validity: re-derive and confirm match
		if (request.operation === 'create') {
			const rederived: CanonicalAddressResult = canonicalizeAddress(evidence.canonicalInput);
			if (rederived.status !== 'resolved') return false;
			if (rederived.version !== CANONICAL_ADDRESS_VERSION) return false;
			if (rederived.addressKey !== request.address.key) return false;
			if (rederived.protocol !== request.address.protocol) return false;
		}

		// 4. Unique point definition: reject if address was flagged ambiguous in resolver pass
		if (evidence.ambiguousAddressKeys?.has(request.address.key)) return false;

		return true;
	}
}
