import { z } from 'zod';
import { AttributeIds, BrowseDirection, NodeClass, type BrowseResult, type ClientSession, type ReferenceDescription } from 'node-opcua-client';
import type { DiscoveryObject, DiscoveryPoint, DiscoverySnapshot } from '../../discovery/device-candidates.js';
import type { Logger } from '../types.js';

export const OPCUADeviceIdentificationSchema = z.object({
	rootNodeId: z.string().trim().min(1),
	scopeNodeId: z.string().trim().min(1),
	deviceTypeNodeId: z.string().trim().min(1),
	identifierProperty: z.string().trim().min(1),
	identifierPath: z.string().trim().min(1),
}).strict();
export type OPCUADeviceIdentification = z.infer<typeof OPCUADeviceIdentificationSchema>;

export interface IdentifiedDevice {
	identifier: string;
	name: string;
	identifierNodeId: string;
}

export async function browseHierarchicalReferences(session: ClientSession, nodeId: string): Promise<ReferenceDescription[]> {
	let result = await session.browse({
		nodeId, browseDirection: BrowseDirection.Forward,
		referenceTypeId: 'HierarchicalReferences', includeSubtypes: true, resultMask: 63,
	});
	const references: ReferenceDescription[] = [];
	for (;;) {
		if (!result.statusCode.isGood()) throw new Error(`Browse failed for ${nodeId}: ${result.statusCode.name}`);
		references.push(...(result.references ?? []));
		if (!result.continuationPoint) return references;
		result = await session.browseNext(result.continuationPoint, false);
	}
}

export async function identifyDevices(
	session: ClientSession,
	config: OPCUADeviceIdentification,
	options: { allowMissingIdentifiers?: boolean; onMissingIdentifier?: (nodeId: string, reason: string, identifierNodeId?: string) => void } = {},
): Promise<Map<string, IdentifiedDevice>> {
	const parts = config.identifierPath.split('/').map(part => part.trim());
	if (!config.rootNodeId || !config.scopeNodeId || !config.deviceTypeNodeId ||
		parts.some(part => !part) || parts[parts.length - 1] !== config.identifierProperty.trim()) {
		throw new Error('Select a device root and enter a relative identifier path ending in the identifier property name');
	}

	const results = new Map<string, IdentifiedDevice>();
	const owners = new Map<string, string>();
	const visited = new Set<string>();
	const queue = [config.scopeNodeId];
	let foundRoot = false;
	while (queue.length) {
		const nodeId = queue.shift()!;
		if (visited.has(nodeId)) continue;
		visited.add(nodeId);
		if (visited.size > 10000) throw new Error('Device identification scope exceeds 10,000 objects');

		for (const ref of await browseHierarchicalReferences(session, nodeId)) {
			if (ref.nodeClass !== NodeClass.Object || ref.nodeId.serverIndex || ref.nodeId.namespaceUri) continue;
			const childId = ref.nodeId.toString();
			if (ref.nodeId.namespace === 0 && childId !== config.rootNodeId) continue;
			if (!visited.has(childId)) queue.push(childId);
			if (ref.typeDefinition?.toString() !== config.deviceTypeNodeId) continue;
			if (childId === config.rootNodeId) foundRoot = true;

			let current = childId;
			let identifierRef: ReferenceDescription | undefined;
			for (const part of parts) {
				const matches = (await browseHierarchicalReferences(session, current))
					.filter(candidate => candidate.browseName?.name === part);
				if (matches.length > 1) throw new Error(`Identifier path "${config.identifierPath}" is ambiguous under ${childId}`);
				identifierRef = matches[0];
				if (!identifierRef) break;
				if (identifierRef.nodeId.serverIndex || identifierRef.nodeId.namespaceUri) {
					throw new Error(`Identifier path under ${childId} points to a remote server`);
				}
				current = identifierRef.nodeId.toString();
			}
			if (!identifierRef) {
				if (options.allowMissingIdentifiers) {
					options.onMissingIdentifier?.(childId, 'identifier path not found');
					continue;
				}
				if (childId === config.rootNodeId) throw new Error(`Identifier path not found under selected device ${childId}`);
				continue;
			}
			if (identifierRef.nodeClass !== NodeClass.Variable) throw new Error(`Identifier path under ${childId} is not a variable`);
			let value;
			try {
				value = await session.read({ nodeId: current, attributeId: AttributeIds.Value });
			} catch (error) {
				if (!options.allowMissingIdentifiers) throw error;
				options.onMissingIdentifier?.(childId, error instanceof Error ? error.message : String(error), current);
				continue;
			}
			const raw = value.value?.value;
			const identifier = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : '';
			if (!value.statusCode.isGood() || !identifier) {
				if (!options.allowMissingIdentifiers) throw new Error(`Identifier under ${childId} is not a readable, non-empty scalar`);
				options.onMissingIdentifier?.(childId, 'identifier is not a readable, non-empty scalar', current);
				continue;
			}
			const previous = owners.get(identifier);
			if (previous && previous !== childId) throw new Error(`Duplicate device identifier "${identifier}" within the selected scope`);
			owners.set(identifier, childId);
			results.set(childId, { identifier, identifierNodeId: current, name: ref.displayName?.text || ref.browseName.name || childId });
		}
	}
	if (!foundRoot) throw new Error('The selected device root was not found in the configured scope with its original type');
	return results;
}

const OBJECTS_NODE = 'ns=0;i=85';
const DI_NAMESPACE = 'http://opcfoundation.org/UA/DI/';

/**
 * Capture protocol evidence without creating devices or writing source state.
 * Paths contain namespace URIs, rather than unstable session namespace indexes.
 */
export async function collectOpcuaDeviceSnapshot(
	session: ClientSession,
	identifierPath?: string,
): Promise<DiscoverySnapshot> {
	const parts = identifierPath?.split('/').map(part => part.trim());
	if (parts?.some(part => !part)) throw new Error('Identifier path contains an empty browse name');
	const namespaceValue = await session.read({ nodeId: 'ns=0;i=2255', attributeId: AttributeIds.Value });
	const namespaces: unknown = namespaceValue.value?.value;
	if (!namespaceValue.statusCode.isGood() || !Array.isArray(namespaces) ||
		namespaces.some(value => typeof value !== 'string')) {
		throw new Error('OPC UA NamespaceArray is unavailable');
	}
	const namespaceUris: string[] = namespaces;
	const typeCache = new Map<string, boolean>();

	async function isDeviceType(typeId: string | undefined): Promise<boolean> {
		if (!typeId || !namespaceUris.includes(DI_NAMESPACE)) return false;
		const cached = typeCache.get(typeId);
		if (cached !== undefined) return cached;
		const visited = new Set<string>();
		let current: string | undefined = typeId;
		while (current) {
			if (visited.has(current) || visited.size >= 100) throw new Error('OPC UA type hierarchy is cyclic or too deep');
			visited.add(current);
			const browseName = await session.read({ nodeId: current, attributeId: AttributeIds.BrowseName });
			if (!browseName.statusCode.isGood()) throw new Error(`Cannot read OPC UA type name for ${current}`);
			const name = browseName.value?.value as { name?: string; namespaceIndex?: number } | undefined;
			if (name?.name === 'DeviceType' && namespaceUris[name.namespaceIndex ?? 0] === DI_NAMESPACE) {
				for (const type of visited) typeCache.set(type, true);
				return true;
			}
			let parent: BrowseResult = await session.browse({
				nodeId: current, browseDirection: BrowseDirection.Inverse,
				referenceTypeId: 'HasSubtype', includeSubtypes: false, resultMask: 63,
			});
			const parents = [];
			for (;;) {
				if (!parent.statusCode.isGood()) throw new Error(`Cannot browse OPC UA type hierarchy for ${current}`);
				parents.push(...(parent.references ?? []).filter(ref => ref.nodeClass === NodeClass.ObjectType));
				if (!parent.continuationPoint) break;
				parent = await session.browseNext(parent.continuationPoint, false);
			}
			if (parents.length > 1 || parents.some(ref => ref.nodeId.serverIndex || ref.nodeId.namespaceUri)) {
				throw new Error(`OPC UA type hierarchy for ${current} is ambiguous`);
			}
			current = parents[0]?.nodeId.toString();
		}
		for (const type of visited) typeCache.set(type, false);
		return false;
	}

	const root: DiscoveryObject = { address: OBJECTS_NODE, parentAddress: null, name: 'Objects', browsePath: ['Objects'] };
	const objects: DiscoveryObject[] = [root];
	const points: DiscoveryPoint[] = [];
	const seen = new Set([OBJECTS_NODE]);
	type QueueEntry = { object: DiscoveryObject; ancestors: Array<{ object: DiscoveryObject; names: string[] }>; depth: number };
	const queue: QueueEntry[] = [{ object: root, ancestors: [{ object: root, names: [] }], depth: 0 }];
	for (let index = 0; index < queue.length; index++) {
		const { object, ancestors, depth } = queue[index];
		if (depth > 20) throw new Error('OPC UA discovery exceeds the maximum object depth');
		for (const ref of await browseHierarchicalReferences(session, object.address)) {
			if (ref.nodeClass !== NodeClass.Object && ref.nodeClass !== NodeClass.Variable) continue;
			if (ref.nodeId.serverIndex || ref.nodeId.namespaceUri) throw new Error('Remote OPC UA references are not supported in device discovery');
			const address = ref.nodeId.toString();
			const name = ref.browseName?.name;
			if (!name) throw new Error(`OPC UA node ${address} has no browse name`);
			if (depth === 0 && ['Server', 'ServerInfo', 'Types', 'Views', 'Aliases'].includes(name)) continue;
			if (seen.has(address)) throw new Error(`OPC UA node ${address} has multiple browse paths or a cycle`);
			seen.add(address);
			if (seen.size > 10000) throw new Error('OPC UA device discovery exceeds 10,000 nodes');
			const namespaceUri = namespaceUris[ref.browseName.namespaceIndex];
			if (!namespaceUri) throw new Error(`OPC UA browse name for ${address} has an unknown namespace`);
			const path = [...object.browsePath, JSON.stringify([namespaceUri, name])];
			if (ref.nodeClass === NodeClass.Object) {
				const child: DiscoveryObject = {
					address, parentAddress: object.address, name: ref.displayName?.text || name,
					browsePath: path, isDeviceModel: await isDeviceType(ref.typeDefinition?.toString()),
				};
				objects.push(child);
				queue.push({
					object: child, depth: depth + 1,
					ancestors: [...ancestors.map(item => ({ object: item.object, names: [...item.names, name] })), { object: child, names: [] }],
				});
			} else {
				const owners = parts ? ancestors.filter(item => {
					const relative = [...item.names, name];
					return relative.length === parts.length && relative.every((part, index) => part === parts[index]);
				}) : [];
				if (owners.length) {
					const data = await session.read({ nodeId: address, attributeId: AttributeIds.Value });
					const value = data.value?.value;
					if (!data.statusCode.isGood() || !((typeof value === 'string' && value.trim()) ||
						(typeof value === 'number' && Number.isFinite(value)))) {
						throw new Error(`OPC UA identifier ${address} is not a readable, non-empty scalar`);
					}
					for (const owner of owners) {
						owner.object.identifiers ??= {};
						if (owner.object.identifiers[identifierPath!]) throw new Error(`Identifier path "${identifierPath}" is ambiguous under ${owner.object.address}`);
						owner.object.identifiers[identifierPath!] = String(value).trim();
					}
				} else {
					points.push({ address, parentAddress: object.address, name });
				}
			}
		}
	}
	return { objects, points };
}

const BATCH_SIZE = 100;
const IDENTIFIER_PRIORITY = new Map([
	['deviceid', 0],
	['deviceidentifier', 1],
	['deviceuuid', 2],
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveDeviceDisplayNames(
	session: ClientSession,
	nodeIds: string[],
	logger: Logger,
): Promise<Map<string, string>> {
	const names = new Map<string, string>();
	const parents = new Map<string, { name: string; children: string[] }>();
	const ids = [...new Set(nodeIds)];

	for (let start = 0; start < ids.length; start += BATCH_SIZE) {
		const batch = ids.slice(start, start + BATCH_SIZE);
		try {
			const results = await session.browse(batch.map(nodeId => ({
				nodeId, browseDirection: BrowseDirection.Inverse,
				referenceTypeId: 'HierarchicalReferences', includeSubtypes: true,
				nodeClassMask: NodeClass.Object, resultMask: 63,
			})));
			for (let i = 0; i < batch.length; i++) {
				const result = results[i];
				if (!result?.statusCode.isGood() || result.continuationPoint) {
					logger.warn('Unable to resolve an unambiguous OPC UA parent', { nodeId: batch[i], status: result?.statusCode.name });
					continue;
				}
				const refs = (result.references ?? []).filter(ref => ref.nodeId.namespace !== 0);
				if (refs.length !== 1) continue;
				const ref = refs[0];
				const name = (ref.displayName?.text || ref.browseName?.name || '').trim();
				if (!name) continue;
				const id = ref.nodeId.toString();
				const parent = parents.get(id) ?? { name, children: [] };
				parent.children.push(batch[i]);
				parents.set(id, parent);
			}
		} catch (error) {
			logger.warn('Failed to browse OPC UA point parents', { error: error instanceof Error ? error.message : String(error) });
		}
	}

	const parentEntries = [...parents.entries()];
	const candidates: Array<{ parentId: string; nodeId: string; priority: number }> = [];
	for (const [, parent] of parentEntries) {
		for (const child of parent.children) names.set(child, parent.name);
	}
	for (let start = 0; start < parentEntries.length; start += BATCH_SIZE) {
		const batch = parentEntries.slice(start, start + BATCH_SIZE);
		try {
			const results = await session.browse(batch.map(([nodeId]) => ({
				nodeId, browseDirection: BrowseDirection.Forward,
				referenceTypeId: 'HierarchicalReferences', includeSubtypes: true,
				nodeClassMask: NodeClass.Variable, resultMask: 63,
			})));
			for (let i = 0; i < batch.length; i++) {
				const result = results[i];
				const parentId = batch[i][0];
				if (!result?.statusCode.isGood() || result.continuationPoint) {
					logger.warn('Unable to inspect OPC UA device identifiers', { nodeId: parentId, status: result?.statusCode.name });
					continue;
				}
				for (const ref of result.references ?? []) {
					const priority = IDENTIFIER_PRIORITY.get((ref.browseName?.name || '').toLowerCase().replace(/[\s_-]/g, ''));
					if (priority !== undefined) candidates.push({ parentId, nodeId: ref.nodeId.toString(), priority });
				}
			}
		} catch (error) {
			logger.warn('Failed to inspect OPC UA device identifiers', { error: error instanceof Error ? error.message : String(error) });
		}
	}

	candidates.sort((a, b) => a.priority - b.priority);
	const resolvedParents = new Set<string>();
	for (let start = 0; start < candidates.length; start += BATCH_SIZE) {
		const batch = candidates.slice(start, start + BATCH_SIZE);
		try {
			const values = await session.read(batch.map(({ nodeId }) => ({ nodeId, attributeId: AttributeIds.Value })));
			for (let i = 0; i < batch.length; i++) {
				const { parentId } = batch[i];
				const value = values[i];
				if (!value?.statusCode.isGood() || resolvedParents.has(parentId)) continue;
				const raw = value.value?.value;
				const text = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : '';
				if (!text || UUID_RE.test(text)) continue;
				for (const child of parents.get(parentId)?.children ?? []) names.set(child, text);
				resolvedParents.add(parentId);
			}
		} catch (error) {
			logger.warn('Failed to read OPC UA device identifiers', { error: error instanceof Error ? error.message : String(error) });
		}
	}
	return names;
}
