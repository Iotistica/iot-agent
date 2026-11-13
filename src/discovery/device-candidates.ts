import { z } from 'zod';
import type { DeviceResolutionCandidate } from './device-resolution.js';

/**
 * Protocol adapters provide source-scoped addresses and browse paths. A
 * device model must be recognized by the protocol adapter, not inferred from
 * an arbitrary folder name.
 */
export interface DiscoveryObject {
	address: string;
	parentAddress: string | null;
	name: string;
	browsePath: string[];
	isDeviceModel?: boolean;
	identifiers?: Record<string, string>;
}

export interface DiscoveryPoint {
	address: string;
	parentAddress: string | null;
	name: string;
}

export interface DiscoverySnapshot {
	objects: DiscoveryObject[];
	points: DiscoveryPoint[];
}

export const DeviceCandidateStrategySchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('identifier'), identifierPath: z.string().trim().min(1) }).strict(),
	z.object({ type: z.literal('device-model') }).strict(),
	z.object({ type: z.literal('hierarchy'), scopeAddress: z.string().trim().min(1), deviceDepth: z.number().int().min(1).max(20) }).strict(),
	z.object({ type: z.literal('tag-pattern'), template: z.string().trim().min(1) }).strict(),
	z.object({
		type: z.literal('manual'),
		mappings: z.array(z.object({
			id: z.string().trim().min(1), name: z.string().trim().min(1),
			pointAddresses: z.array(z.string().trim().min(1)).min(1),
		}).strict()).max(10000),
	}).strict(),
]);
export type DeviceCandidateStrategy = z.infer<typeof DeviceCandidateStrategySchema>;

export interface DeviceCandidateResult {
	candidates: DeviceResolutionCandidate[];
	unproposedPointAddresses: string[];
}

function objectPathKey(object: DiscoveryObject): string {
	return JSON.stringify(object.browsePath);
}

function parseTemplate(template: string): { prefix: string; separator: string; suffix: string } {
	const match = /^(.*?)\{device\}(.+?)\{point\}(.*?)$/.exec(template);
	if (!match || /[{}]/.test(match[1] + match[2] + match[3])) {
		throw new Error('Tag template must contain {device}, a delimiter, and {point} exactly once in that order');
	}
	return { prefix: match[1], separator: match[2], suffix: match[3] };
}

function patternDevice(name: string, template: ReturnType<typeof parseTemplate>): string | undefined {
	if (!name.startsWith(template.prefix) || !name.endsWith(template.suffix)) return undefined;
	const content = name.slice(template.prefix.length, template.suffix ? -template.suffix.length : undefined);
	const separator = content.indexOf(template.separator);
	if (separator <= 0 || separator + template.separator.length >= content.length) return undefined;
	return content.slice(0, separator);
}

/** Generate suggestions only; this function never confirms or persists devices. */
export function generateDeviceCandidates(snapshot: DiscoverySnapshot, strategy: DeviceCandidateStrategy): DeviceCandidateResult {
	const objects = new Map<string, DiscoveryObject>();
	const pointAddresses = new Set<string>();
	for (const object of snapshot.objects) {
		if (!object.address.trim() || !object.name.trim() || object.browsePath.length === 0 ||
			object.browsePath.some(part => !part.trim()) || objects.has(object.address)) {
			throw new Error('Discovery snapshot contains an invalid or duplicate object');
		}
		objects.set(object.address, object);
	}
	for (const point of snapshot.points) {
		if (!point.address.trim() || !point.name.trim() || pointAddresses.has(point.address) || objects.has(point.address)) {
			throw new Error('Discovery snapshot contains an invalid or duplicate point');
		}
		pointAddresses.add(point.address);
	}

	const ancestorCache = new Map<string, string[]>();
	function ancestors(address: string | null): string[] {
		if (address === null) return [];
		const cached = ancestorCache.get(address);
		if (cached) return cached;
		const visited = new Set<string>();
		const result: string[] = [];
		let current: string | null = address;
		while (current !== null) {
			if (visited.has(current)) throw new Error('Discovery snapshot contains an object cycle');
			visited.add(current);
			const object = objects.get(current);
			if (!object) throw new Error(`Discovery snapshot is missing parent object "${current}"`);
			result.push(current);
			current = object.parentAddress;
		}
		ancestorCache.set(address, result);
		return result;
	}
	for (const object of objects.values()) ancestors(object.address);
	for (const point of snapshot.points) ancestors(point.parentAddress);

	const candidates: DeviceResolutionCandidate[] = [];
	if (strategy.type === 'manual') {
		for (const mapping of strategy.mappings) {
			if (!mapping.id.trim() || !mapping.name.trim() || mapping.pointAddresses.length === 0 ||
				mapping.pointAddresses.some(address => !pointAddresses.has(address))) {
				throw new Error('Manual mappings must identify a device and existing points');
			}
			candidates.push({
				candidateId: JSON.stringify(['manual', mapping.id]),
				name: mapping.name,
				keys: [{ kind: 'manual-mapping', value: mapping.id }],
				pointAddresses: [...mapping.pointAddresses],
				reasons: ['Explicit manual mapping'],
			});
		}
	} else if (strategy.type === 'tag-pattern') {
		const template = parseTemplate(strategy.template);
		const groups = new Map<string, string[]>();
		for (const point of snapshot.points) {
			const device = patternDevice(point.name, template);
			if (!device) continue;
			const points = groups.get(device) ?? [];
			points.push(point.address);
			groups.set(device, points);
		}
		for (const [device, points] of groups) {
			candidates.push({
				candidateId: JSON.stringify(['tag-pattern', strategy.template, device]),
				name: device,
				keys: [{ kind: `tag-pattern:${strategy.template}`, value: device }],
				pointAddresses: points,
				reasons: [`Tag names match ${strategy.template}`],
			});
		}
	} else {
		if (strategy.type === 'identifier' && !strategy.identifierPath.trim()) {
			throw new Error('An identifier path is required for the identifier strategy');
		}
		if (strategy.type === 'hierarchy' && (!objects.has(strategy.scopeAddress) ||
			!Number.isInteger(strategy.deviceDepth) || strategy.deviceDepth < 1)) {
			throw new Error('Hierarchy strategy requires an existing scope and positive device depth');
		}
		for (const object of objects.values()) {
			let reason: string;
			let identifier: string | undefined;
			if (strategy.type === 'identifier') {
				identifier = object.identifiers?.[strategy.identifierPath]?.trim();
				if (!identifier) continue;
				reason = `Identifier property ${strategy.identifierPath} is present`;
			} else if (strategy.type === 'device-model') {
				if (!object.isDeviceModel) continue;
				reason = 'Recognized protocol device model';
			} else {
				if (ancestors(object.address)[strategy.deviceDepth] !== strategy.scopeAddress) continue;
				reason = `Object is at configured device depth ${strategy.deviceDepth}`;
			}
			candidates.push({
				candidateId: JSON.stringify(['object', object.address]),
				name: object.name,
				keys: [
					{ kind: 'browse-path', value: objectPathKey(object) },
					...(identifier && strategy.type === 'identifier'
						? [{ kind: `external-identifier:${strategy.identifierPath}`, value: identifier }]
						: []),
				],
				pointAddresses: snapshot.points.filter(point => ancestors(point.parentAddress).includes(object.address)).map(point => point.address),
				reasons: [reason],
			});
		}
	}

	const assigned = new Set(candidates.flatMap(candidate => candidate.pointAddresses));
	return { candidates, unproposedPointAddresses: snapshot.points.filter(point => !assigned.has(point.address)).map(point => point.address) };
}
