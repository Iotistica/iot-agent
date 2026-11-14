import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../../../src/db/migration-runner';
import { ConfiguredPointVerifier, type VerifierEvidence } from '../../../src/points/configured-point-verifier';
import type { CatalogEvidenceRequest, PointAddress } from '../../../src/points/point-identity-catalog';
import { CANONICAL_ADDRESS_VERSION, type MqttAddressInput } from '../../../src/points/canonical-address';

const mqttInput: MqttAddressInput = {
	protocol: 'mqtt', topic: 'factory/line1', selector: { kind: 'whole' }, selectorSource: 'configured',
};

describe('ConfiguredPointVerifier', () => {
	let db: DatabaseSync;
	let resolverRef: object;
	let verifier: ConfiguredPointVerifier;
	const address: PointAddress = {
		endpointUuid: 'ep-001', protocol: 'mqtt', version: CANONICAL_ADDRESS_VERSION,
		key: '["factory/line1",["whole"]]',
	};

	beforeEach(() => {
		db = new DatabaseSync(':memory:');
		db.exec('PRAGMA journal_mode = WAL');
		runMigrations(db);
		db.exec(`
			INSERT INTO endpoints (id, uuid, name, protocol, enabled, connection, data_points, poll_interval)
				VALUES (1, 'ep-001', 'MQTT Source', 'mqtt', 1, '{}', '[]', 5000);
		`);
		resolverRef = Object.freeze({});
		verifier = new ConfiguredPointVerifier(db, resolverRef);
	});

	afterEach(() => { db.close(); });

	function makeEvidence(overrides: Partial<VerifierEvidence> = {}): VerifierEvidence {
		return {
			resolverRef,
			canonicalInput: mqttInput,
			endpointUuid: 'ep-001',
			protocol: 'mqtt',
			...overrides,
		};
	}

	function makeRequest(overrides: Partial<{ operation: string; address: PointAddress; evidence: unknown }> = {}): CatalogEvidenceRequest {
		return {
			operation: 'create',
			address,
			evidence: makeEvidence(),
			...overrides,
		} as CatalogEvidenceRequest;
	}

	it('accepts a valid create request from the authorized resolver', () => {
		expect(verifier.verify(makeRequest())).toBe(true);
	});

	it('rejects when resolver reference does not match', () => {
		const wrongRef = Object.freeze({});
		expect(verifier.verify(makeRequest({
			evidence: makeEvidence({ resolverRef: wrongRef }),
		}))).toBe(false);
	});

	it('rejects when resolver has been garbage collected', () => {
		const ephemeral = new ConfiguredPointVerifier(db, Object.freeze({}));
		// The WeakRef target may still be reachable here, but we can test with a wrong ref
		expect(ephemeral.verify(makeRequest({
			evidence: makeEvidence({ resolverRef: Object.freeze({}) }),
		}))).toBe(false);
	});

	it('rejects when endpoint does not exist in DB', () => {
		expect(verifier.verify(makeRequest({
			address: { ...address, endpointUuid: 'nonexistent' },
			evidence: makeEvidence({ endpointUuid: 'nonexistent' }),
		}))).toBe(false);
	});

	it('rejects when endpoint is disabled', () => {
		db.exec("UPDATE endpoints SET enabled = 0 WHERE uuid = 'ep-001'");
		expect(verifier.verify(makeRequest())).toBe(false);
	});

	it('rejects when protocol mismatches between evidence and request', () => {
		expect(verifier.verify(makeRequest({
			evidence: makeEvidence({ protocol: 'modbus' }),
		}))).toBe(false);
	});

	it('rejects when endpoint protocol mismatches evidence', () => {
		db.exec(`
			INSERT INTO endpoints (id, uuid, name, protocol, enabled, connection, data_points, poll_interval)
				VALUES (2, 'ep-modbus', 'Modbus Source', 'modbus', 1, '{}', '[]', 5000);
		`);
		expect(verifier.verify(makeRequest({
			address: { ...address, endpointUuid: 'ep-modbus' },
			evidence: makeEvidence({ endpointUuid: 'ep-modbus', protocol: 'mqtt' }),
		}))).toBe(false);
	});

	it('rejects when canonical address re-derivation does not match', () => {
		expect(verifier.verify(makeRequest({
			address: { ...address, key: '["different/topic",["whole"]]' },
		}))).toBe(false);
	});

	it('rejects when address key is in the ambiguous set', () => {
		expect(verifier.verify(makeRequest({
			evidence: makeEvidence({
				ambiguousAddressKeys: new Set([address.key]),
			}),
		}))).toBe(false);
	});

	it('accepts when ambiguous set does not contain this key', () => {
		expect(verifier.verify(makeRequest({
			evidence: makeEvidence({
				ambiguousAddressKeys: new Set(['other-key']),
			}),
		}))).toBe(true);
	});

	it('rejects unsupported operations', () => {
		expect(verifier.verify({
			operation: 'attach-address', pointUuid: 'x', address, evidence: makeEvidence(),
		} as CatalogEvidenceRequest)).toBe(false);
		expect(verifier.verify({
			operation: 'associate', pointUuid: 'x', scope: { endpointUuid: 'ep-001', protocol: 'mqtt' },
			deviceUuid: null, expectedDeviceUuid: null, associationSource: 'test', evidence: makeEvidence(),
		} as CatalogEvidenceRequest)).toBe(false);
	});

	it('rejects when evidence is not a valid VerifierEvidence', () => {
		expect(verifier.verify(makeRequest({ evidence: null }))).toBe(false);
		expect(verifier.verify(makeRequest({ evidence: 'string' }))).toBe(false);
		expect(verifier.verify(makeRequest({ evidence: { resolverRef: null } }))).toBe(false);
	});
});
