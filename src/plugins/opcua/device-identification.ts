import { AttributeIds, BrowseDirection, NodeClass, type ClientSession, type ReferenceDescription } from 'node-opcua-client';
import { z } from 'zod';

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
			if (!visited.has(childId)) queue.push(childId);
			if (ref.typeDefinition?.toString() !== config.deviceTypeNodeId) continue;

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
				if (childId === config.rootNodeId) throw new Error(`Identifier path not found under selected device ${childId}`);
				continue;
			}
			if (identifierRef.nodeClass !== NodeClass.Variable) throw new Error(`Identifier path under ${childId} is not a variable`);
			const value = await session.read({ nodeId: current, attributeId: AttributeIds.Value });
			const raw = value.value?.value;
			const identifier = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : '';
			if (!value.statusCode.isGood() || !identifier) throw new Error(`Identifier under ${childId} is not a readable, non-empty scalar`);
			const previous = owners.get(identifier);
			if (previous && previous !== childId) throw new Error(`Duplicate device identifier "${identifier}" within the selected scope`);
			owners.set(identifier, childId);
			results.set(childId, { identifier, identifierNodeId: current, name: ref.displayName?.text || ref.browseName.name || childId });
			if (childId === config.rootNodeId) foundRoot = true;
		}
	}
	if (!foundRoot) throw new Error('The selected device root was not found in the configured scope with its original type');
	return results;
}
