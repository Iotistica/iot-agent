import type { DatabaseSync } from 'node:sqlite';
import {
	canonicalizeAddress, canonicalizeModbusAddresses, CANONICAL_ADDRESS_VERSION,
	type AddressProtocol, type CanonicalAddressResult,
	type MqttAddressInput, type ModbusAddressInput, type BacnetAddressInput, type OpcuaAddressInput,
} from './canonical-address.js';
import { PointIdentityCatalog, type CatalogResult, type PointIdentityRecord } from './point-identity-catalog.js';
import { ConfiguredPointVerifier, type VerifierEvidence } from './configured-point-verifier.js';

export interface PointResolution {
	pointName: string;
	result: CanonicalAddressResult;
}

export interface EndpointResolution {
	endpointUuid: string;
	endpointName: string;
	protocol: string;
	points: PointResolution[];
}

export interface ResolverResult {
	endpoints: EndpointResolution[];
	summary: { resolved: number; unresolved: number; deferred: number; endpoints: number };
}

function mqttInput(dp: Record<string, unknown>): MqttAddressInput | undefined {
	const topic = dp.fullTopic;
	if (typeof topic !== 'string' || !topic) return undefined;
	return { protocol: 'mqtt', topic, selector: { kind: 'whole' }, selectorSource: 'configured' };
}

function modbusInput(dp: Record<string, unknown>, unitId: number): ModbusAddressInput | undefined {
	const address = dp.address;
	if (typeof address !== 'number') return undefined;
	const type = typeof dp.type === 'string' ? dp.type as ModbusAddressInput['type'] : undefined;
	const functionCode = typeof dp.functionCode === 'number' ? dp.functionCode as 1 | 2 | 3 | 4 : undefined;
	if (!type && !functionCode) return undefined;
	const dataType = typeof dp.dataType === 'string' ? dp.dataType : 'float32';
	const count = typeof dp.count === 'number' ? dp.count
		: (['float32', 'int32', 'uint32'].includes(dataType) ? 2 : 1);
	const projection: ModbusAddressInput['projection'] = { dataType: dataType as ModbusAddressInput['projection']['dataType'], count };
	if (typeof dp.byteOrder === 'string') projection.byteOrder = dp.byteOrder as ModbusAddressInput['projection']['byteOrder'];
	if (typeof dp.endianness === 'string') projection.endianness = dp.endianness as ModbusAddressInput['projection']['endianness'];
	if (typeof dp.encoding === 'string') projection.encoding = dp.encoding as ModbusAddressInput['projection']['encoding'];
	if (typeof dp.scale === 'number') projection.scale = dp.scale;
	if (typeof dp.offset === 'number') projection.offset = dp.offset;
	return { protocol: 'modbus', unitId, address, type, functionCode, projection };
}

function bacnetInput(dp: Record<string, unknown>, deviceInstance: number): BacnetAddressInput | undefined {
	const objectType = dp.objectType;
	const objectInstance = dp.objectInstance;
	if ((typeof objectType !== 'string' && typeof objectType !== 'number') || typeof objectInstance !== 'number') return undefined;
	const input: BacnetAddressInput = {
		protocol: 'bacnet', deviceInstance,
		networkScope: { uniqueDeviceInstance: true, source: 'configured' },
		objectType, objectInstance,
	};
	if (typeof dp.propertyId === 'number') input.propertyId = dp.propertyId;
	return input;
}

function opcuaInput(dp: Record<string, unknown>, namespaceArray?: OpcuaAddressInput['namespaceArray']): OpcuaAddressInput | undefined {
	const nodeId = dp.nodeId;
	if (typeof nodeId !== 'string' || !nodeId) return undefined;
	if (!namespaceArray) return undefined;
	return { protocol: 'opcua', nodeId, namespaceArray, nodeIdVerifiedAgainstNamespaceArray: true };
}

function pointName(dp: Record<string, unknown>): string {
	if (typeof dp.name === 'string' && dp.name) return dp.name;
	if (typeof dp.subTopic === 'string' && dp.subTopic) return dp.subTopic;
	if (typeof dp.fullTopic === 'string' && dp.fullTopic) return dp.fullTopic;
	return `unnamed-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveModbus(dataPoints: Record<string, unknown>[], unitId: number): PointResolution[] {
	const inputs: (ModbusAddressInput | null)[] = dataPoints.map((dp) => modbusInput(dp, unitId) ?? null);
	const validInputs = inputs.filter((i): i is ModbusAddressInput => i !== null);
	const validIndexes = inputs.map((inp, idx) => inp !== null ? idx : -1).filter((i) => i >= 0);

	if (validInputs.length === 0) {
		return dataPoints.map((dp) => ({
			pointName: pointName(dp),
			result: { status: 'unresolved' as const, protocol: 'modbus', reason: 'invalid-input' as const },
		}));
	}

	const batchResults = canonicalizeModbusAddresses(validInputs, { complete: true });
	const resultMap = new Map<number, CanonicalAddressResult>();
	validIndexes.forEach((originalIdx, batchIdx) => { resultMap.set(originalIdx, batchResults[batchIdx]); });

	return dataPoints.map((dp, idx) => ({
		pointName: pointName(dp),
		result: resultMap.get(idx) ?? { status: 'unresolved' as const, protocol: 'modbus', reason: 'invalid-input' as const },
	}));
}

export interface EndpointInput {
	uuid?: string;
	name: string;
	protocol: string;
	connection: Record<string, any>;
	data_points?: any[] | null;
}

export function resolveEndpoint(
	endpoint: EndpointInput,
	opcuaNamespaceArray?: OpcuaAddressInput['namespaceArray'],
): EndpointResolution {
	const uuid = endpoint.uuid ?? '';
	const protocol = endpoint.protocol;
	const dataPoints: Record<string, unknown>[] = Array.isArray(endpoint.data_points) ? endpoint.data_points : [];
	const connection = endpoint.connection ?? {};

	if (protocol === 'modbus') {
		const unitId = typeof connection.slaveId === 'number' ? connection.slaveId : 1;
		return { endpointUuid: uuid, endpointName: endpoint.name, protocol, points: resolveModbus(dataPoints, unitId) };
	}

	const points: PointResolution[] = dataPoints.map((dp) => {
		let input: MqttAddressInput | BacnetAddressInput | OpcuaAddressInput | undefined;
		switch (protocol) {
			case 'mqtt':
				input = mqttInput(dp);
				break;
			case 'bacnet': {
				const deviceInstance = typeof connection.deviceInstance === 'number'
					? connection.deviceInstance
					: (typeof connection.deviceId === 'number' ? connection.deviceId : 0);
				input = bacnetInput(dp, deviceInstance);
				break;
			}
			case 'opcua':
				input = opcuaInput(dp, opcuaNamespaceArray);
				if (!input) {
					return {
						pointName: pointName(dp),
						result: { status: 'unresolved' as const, protocol: 'opcua', reason: 'namespace-evidence-required' as const },
					};
				}
				break;
			default:
				return {
					pointName: pointName(dp),
					result: { status: 'unresolved' as const, protocol: protocol ?? 'unknown', reason: 'unsupported-protocol' as const },
				};
		}
		if (!input) {
			return {
				pointName: pointName(dp),
				result: { status: 'unresolved' as const, protocol, reason: 'invalid-input' as const },
			};
		}
		return { pointName: pointName(dp), result: canonicalizeAddress(input) };
	});

	return { endpointUuid: uuid, endpointName: endpoint.name, protocol, points };
}

export function resolveEndpoints(
	endpoints: EndpointInput[],
	opcuaNamespaceArrays?: Map<string, OpcuaAddressInput['namespaceArray']>,
): ResolverResult {
	const results: EndpointResolution[] = [];
	let resolved = 0;
	let unresolved = 0;
	let deferred = 0;

	for (const endpoint of endpoints) {
		const nsArray = opcuaNamespaceArrays?.get(endpoint.uuid ?? '');
		const resolution = resolveEndpoint(endpoint, nsArray);
		results.push(resolution);
		for (const p of resolution.points) {
			if (p.result.status === 'resolved') {
				resolved++;
			} else if (p.result.protocol === 'opcua' && p.result.reason === 'namespace-evidence-required') {
				deferred++;
			} else {
				unresolved++;
			}
		}
	}

	return { endpoints: results, summary: { resolved, unresolved, deferred, endpoints: results.length } };
}

export interface IdentityResult {
	pointName: string;
	addressKey: string;
	catalogResult: CatalogResult<PointIdentityRecord>;
}

export interface CreateIdentitiesResult {
	identities: IdentityResult[];
	lookup: Map<string, string>;
	pointNameLookup: Map<string, string>;
	summary: { created: number; failed: number };
}

function findAmbiguousKeys(resolution: EndpointResolution): Set<string> {
	const keyCounts = new Map<string, number>();
	for (const p of resolution.points) {
		if (p.result.status === 'resolved') {
			keyCounts.set(p.result.addressKey, (keyCounts.get(p.result.addressKey) ?? 0) + 1);
		}
	}
	const ambiguous = new Set<string>();
	for (const [key, count] of keyCounts) {
		if (count > 1) ambiguous.add(key);
	}
	return ambiguous;
}

export async function createIdentities(
	db: DatabaseSync,
	resolverResult: ResolverResult,
	opcuaNamespaceArrays?: Map<string, OpcuaAddressInput['namespaceArray']>,
	isCurrent?: () => boolean,
): Promise<CreateIdentitiesResult> {
	const resolverRef = Object.freeze({});
	const verifier = new ConfiguredPointVerifier(db, resolverRef);
	const catalog = new PointIdentityCatalog(db, verifier);
	const identities: IdentityResult[] = [];
	const lookup = new Map<string, string>();
	const pointNameLookup = new Map<string, string>();
	let created = 0;
	let failed = 0;

	const BATCH_SIZE = 20;

	for (const ep of resolverResult.endpoints) {
		if (!ep.endpointUuid) continue;
		const protocol = ep.protocol as AddressProtocol;
		const ambiguousKeys = findAmbiguousKeys(ep);
		let batchCount = 0;

		for (const p of ep.points) {
			if (p.result.status !== 'resolved') continue;

			if (batchCount === 0) {
				if (isCurrent && !isCurrent()) return { identities, lookup, pointNameLookup, summary: { created, failed } };
				db.exec('BEGIN IMMEDIATE');
				catalog.enterBatchMode();
			}

			const addressKey = p.result.addressKey;

			const evidence: VerifierEvidence = {
				resolverRef,
				canonicalInput: buildCanonicalInput(ep, p, opcuaNamespaceArrays),
				endpointUuid: ep.endpointUuid,
				protocol: ep.protocol,
				ambiguousAddressKeys: ambiguousKeys.size > 0 ? ambiguousKeys : undefined,
				isCurrent,
			};

			const result = await catalog.createIdentityIfAbsent(
				{ endpointUuid: ep.endpointUuid, protocol, version: CANONICAL_ADDRESS_VERSION, key: addressKey },
				evidence,
			);

			identities.push({ pointName: p.pointName, addressKey, catalogResult: result });

			if (result.status === 'resolved') {
				const lookupKey = `${ep.endpointUuid}:${protocol}:${addressKey}`;
				const existed = lookup.has(lookupKey);
				lookup.set(lookupKey, result.value.pointUuid);
				pointNameLookup.set(`${ep.endpointUuid}\0${p.pointName}`, result.value.pointUuid);
				if (!existed) created++;
			} else {
				failed++;
			}

			batchCount++;
			if (batchCount >= BATCH_SIZE) {
				catalog.exitBatchMode();
				db.exec('COMMIT');
				batchCount = 0;
				await new Promise<void>(resolve => setImmediate(resolve));
			}
		}

		if (batchCount > 0) {
			catalog.exitBatchMode();
			db.exec('COMMIT');
			await new Promise<void>(resolve => setImmediate(resolve));
		}
	}

	return { identities, lookup, pointNameLookup, summary: { created, failed } };
}

function buildCanonicalInput(
	ep: EndpointResolution,
	p: PointResolution,
	opcuaNamespaceArrays?: Map<string, OpcuaAddressInput['namespaceArray']>,
): OpcuaAddressInput | MqttAddressInput | ModbusAddressInput | BacnetAddressInput {
	if (p.result.status !== 'resolved') throw new Error('Cannot build input for unresolved point');
	const prov = p.result.provenance;
	switch (prov.protocol) {
		case 'mqtt':
			return { protocol: 'mqtt', topic: prov.topic, selector: prov.selector, selectorSource: prov.selectorSource };
		case 'modbus':
			return {
				protocol: 'modbus', unitId: prov.unitId, address: JSON.parse(p.result.addressKey)[2] as number,
				type: prov.addressSpace,
				projection: { dataType: prov.dataType as ModbusAddressInput['projection']['dataType'], count: prov.count },
			};
		case 'bacnet':
			return {
				protocol: 'bacnet', deviceInstance: prov.deviceInstance,
				networkScope: { uniqueDeviceInstance: true, source: prov.networkScope },
				objectType: prov.objectType, objectInstance: prov.objectInstance,
				propertyId: prov.propertyId,
			};
		case 'opcua': {
			const nsArray = opcuaNamespaceArrays?.get(ep.endpointUuid);
			if (!nsArray) throw new Error('OPC UA namespace array required for identity creation');
			return {
				protocol: 'opcua', nodeId: `ns=${prov.namespaceIndex};${prov.identifierType}=${JSON.parse(p.result.addressKey)[2]}`,
				namespaceArray: nsArray, nodeIdVerifiedAgainstNamespaceArray: true,
			};
		}
	}
}
