import { AttributeIds, BrowseDirection, NodeClass, type BrowseResult, type ClientSession } from 'node-opcua-client';
import type { DiscoveryObject, DiscoveryPoint, DiscoverySnapshot } from '../../discovery/device-candidates.js';
import { browseHierarchicalReferences } from './device-identification.js';

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
