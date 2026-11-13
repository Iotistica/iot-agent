import { AttributeIds, BrowseDirection, NodeClass, type ClientSession } from 'node-opcua-client';
import type { Logger } from '../types.js';

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
