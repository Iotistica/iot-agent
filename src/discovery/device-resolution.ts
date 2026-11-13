import { randomUUID } from 'crypto';

/**
 * Protocol adapters describe candidate devices and source-scoped evidence.
 * Previews reconcile evidence without changing state; explicit confirmation
 * generates identities for new candidates.
 */
export interface DeviceResolutionKey {
	kind: string;
	value: string;
}

export interface DeviceResolutionCandidate {
	candidateId: string;
	name: string;
	keys: DeviceResolutionKey[];
	pointAddresses: string[];
	reasons: string[];
}

export interface ConfirmedDeviceIdentity {
	sourceUuid: string;
	deviceUuid: string;
	keys: DeviceResolutionKey[];
}

export interface DeviceResolutionPreview {
	candidate: DeviceResolutionCandidate;
	status: 'new' | 'matched' | 'conflict';
	deviceUuid?: string;
	conflicts: string[];
}

export interface ConfirmedDeviceResolution {
	identity: ConfirmedDeviceIdentity;
	candidateId: string;
	pointAddresses: string[];
}

export interface ResolvedDevicePoints {
	assignments: Map<string, string>;
	unassignedPointAddresses: string[];
}

function keyOf(key: DeviceResolutionKey): string {
	return JSON.stringify([key.kind, key.value]);
}

/**
 * A candidate is matched only when all known keys agree on one confirmed
 * device, and neither its keys nor its point assignments overlap another
 * candidate. Unmatched candidates remain suggestions until confirmed.
 */
export function previewDeviceResolution(
	sourceUuid: string,
	candidates: DeviceResolutionCandidate[],
	confirmed: ConfirmedDeviceIdentity[],
): DeviceResolutionPreview[] {
	const byKey = new Map<string, Set<string>>();
	const byDevice = new Map<string, ConfirmedDeviceIdentity>();
	for (const device of confirmed) {
		if (device.sourceUuid !== sourceUuid) continue;
		byDevice.set(device.deviceUuid, device);
		for (const key of device.keys) {
			const encoded = keyOf(key);
			const owners = byKey.get(encoded) ?? new Set<string>();
			owners.add(device.deviceUuid);
			byKey.set(encoded, owners);
		}
	}

	const candidateKeys = new Map<string, Set<number>>();
	const candidatePoints = new Map<string, Set<number>>();
	const candidatesById = new Map<string, Set<number>>();
	const matchedDevices = new Map<string, Set<number>>();
	candidates.forEach((candidate, index) => {
		for (const key of candidate.keys) addOwner(candidateKeys, keyOf(key), index);
		for (const point of candidate.pointAddresses) addOwner(candidatePoints, point, index);
		addOwner(candidatesById, candidate.candidateId, index);
	});

	const previews = candidates.map((candidate, index): DeviceResolutionPreview => {
		const conflicts: string[] = [];
		const matches = new Set<string>();
		if (!candidate.candidateId || !candidate.name.trim() || candidate.keys.length === 0) {
			conflicts.push('Candidate is missing a name or source-scoped identity evidence');
		}
		if ((candidatesById.get(candidate.candidateId)?.size ?? 0) > 1) {
			conflicts.push('Candidate identifier is not unique');
		}
		for (const key of candidate.keys) {
			if (!key.kind.trim() || !key.value.trim()) conflicts.push('Identity evidence is empty');
			const encoded = keyOf(key);
			for (const owner of byKey.get(encoded) ?? []) matches.add(owner);
			if ((candidateKeys.get(encoded)?.size ?? 0) > 1) conflicts.push('Identity evidence matches multiple candidates');
		}
		for (const point of candidate.pointAddresses) {
			if (!point.trim()) conflicts.push('Point address is empty');
			if ((candidatePoints.get(point)?.size ?? 0) > 1) conflicts.push('A point belongs to multiple candidates');
		}
		for (const match of matches) addOwner(matchedDevices, match, index);
		if (matches.size > 1) conflicts.push('Identity evidence matches different confirmed devices');
		const deviceUuid = matches.size === 1 ? [...matches][0] : undefined;
		if (deviceUuid) {
			const previous = byDevice.get(deviceUuid);
			for (const key of candidate.keys) {
				if (key.kind !== 'external-identifier' && !key.kind.startsWith('external-identifier:')) continue;
				const oldValues = previous?.keys.filter(item => item.kind === key.kind) ?? [];
				if (oldValues.length && !oldValues.some(item => item.value === key.value)) {
					conflicts.push('External identifier differs from the confirmed device');
				}
			}
		}
		return {
			candidate,
			status: conflicts.length ? 'conflict' : deviceUuid ? 'matched' : 'new',
			...(deviceUuid && !conflicts.length && { deviceUuid }),
			conflicts: [...new Set(conflicts)],
		};
	});

	for (const owners of matchedDevices.values()) {
		if (owners.size > 1) {
			for (const index of owners) {
				previews[index].status = 'conflict';
				delete previews[index].deviceUuid;
				previews[index].conflicts.push('Multiple candidates match the same confirmed device');
			}
		}
	}
	return previews;
}

/** Only unambiguous matches to confirmed devices may own points. */
export function resolveConfirmedDevicePoints(
	pointAddresses: string[],
	previews: DeviceResolutionPreview[],
): ResolvedDevicePoints {
	const known = new Set(pointAddresses);
	if (known.size !== pointAddresses.length || pointAddresses.some(address => !address.trim())) {
		throw new Error('Point addresses must be non-empty and unique');
	}
	const assignments = new Map<string, string>();
	for (const item of previews) {
		if (item.status !== 'matched') continue;
		if (!item.deviceUuid) throw new Error('Matched candidate is missing its confirmed device UUID');
		for (const point of item.candidate.pointAddresses) {
			if (!known.has(point)) throw new Error(`Candidate references unknown point "${point}"`);
			if (assignments.has(point)) throw new Error(`Point "${point}" has multiple confirmed devices`);
			assignments.set(point, item.deviceUuid);
		}
	}
	return {
		assignments,
		unassignedPointAddresses: pointAddresses.filter(address => !assignments.has(address)),
	};
}

/**
 * Confirm a subset of a fresh preview. The caller must persist the returned
 * identities and point assignments atomically with the source configuration.
 */
export function confirmDeviceResolution(
	sourceUuid: string,
	candidates: DeviceResolutionCandidate[],
	confirmed: ConfirmedDeviceIdentity[],
	selectedCandidateIds: string[],
): ConfirmedDeviceResolution[] {
	if (!sourceUuid.trim()) throw new Error('A source UUID is required to confirm devices');
	const selected = new Set(selectedCandidateIds);
	if (selected.size !== selectedCandidateIds.length) throw new Error('A candidate was selected more than once');

	const existing = new Map<string, ConfirmedDeviceIdentity>();
	for (const identity of confirmed) {
		if (identity.sourceUuid !== sourceUuid) continue;
		if (!identity.deviceUuid.trim() || existing.has(identity.deviceUuid)) {
			throw new Error('Confirmed device identities are invalid or duplicated');
		}
		existing.set(identity.deviceUuid, identity);
	}

	const previews = previewDeviceResolution(sourceUuid, candidates, confirmed);
	const selectedPreviews = previews.filter(item => selected.has(item.candidate.candidateId));
	if (selectedPreviews.length !== selected.size) throw new Error('A selected candidate no longer exists or is ambiguous');
	if (selectedPreviews.some(item => item.status === 'conflict')) {
		throw new Error('Conflicting device candidates must be reviewed before confirmation');
	}

	return selectedPreviews.map(({ candidate, deviceUuid }) => {
		const keys = new Map<string, DeviceResolutionKey>();
		for (const key of deviceUuid ? existing.get(deviceUuid)!.keys : []) keys.set(keyOf(key), key);
		for (const key of candidate.keys) keys.set(keyOf(key), key);
		return {
			identity: { sourceUuid, deviceUuid: deviceUuid ?? randomUUID(), keys: [...keys.values()] },
			candidateId: candidate.candidateId,
			pointAddresses: [...candidate.pointAddresses],
		};
	});
}

function addOwner(map: Map<string, Set<number>>, key: string, owner: number): void {
	const owners = map.get(key) ?? new Set<number>();
	owners.add(owner);
	map.set(key, owners);
}
