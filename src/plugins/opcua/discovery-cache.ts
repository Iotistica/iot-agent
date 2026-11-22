import { createHash } from 'crypto';
import { MetadataModel } from '../../db/models/metadata.model.js';

export interface DiscoveryCacheEntry {
	name: string;
	browseName: string;
	writable: boolean;
	unit?: string;
	device_uuid?: string;
	device_name?: string;
	parentNodeId?: string;
}

export interface FolderCacheEntry {
	browseName: string;
	parentNodeId: string | null;
	referenceType?: string;
	typeDefinition?: string;
}

export interface DiscoveryCache {
	structuralHash: string;
	nodeIndex: Record<string, DiscoveryCacheEntry>;
	folderIndex?: Record<string, FolderCacheEntry>;
	updatedAt: string;
}

function cacheKey(endpointUrl: string): string {
	const hash = createHash('sha256').update(endpointUrl).digest('hex').slice(0, 16);
	return `discovery.cache.${hash}`;
}

export function computeStructuralHash(nodeIds: string[]): string {
	const sorted = [...nodeIds].sort();
	return createHash('sha256').update(sorted.join('\0')).digest('hex');
}

export async function getDiscoveryCache(endpointUrl: string): Promise<DiscoveryCache | null> {
	return MetadataModel.getObject<DiscoveryCache>(cacheKey(endpointUrl));
}

export async function setDiscoveryCache(endpointUrl: string, cache: DiscoveryCache): Promise<void> {
	await MetadataModel.setObject(cacheKey(endpointUrl), cache);
}

export async function clearDiscoveryCache(endpointUrl: string): Promise<void> {
	await MetadataModel.delete(cacheKey(endpointUrl));
}
