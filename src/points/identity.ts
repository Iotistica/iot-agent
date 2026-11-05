import { createHash } from 'crypto';

// Distinct from device.model.ts's DEVICE_UUID_NAMESPACE — a separate identity
// space so a device natural key and a point natural key can never collide by
// coincidence, even if their raw string inputs happened to match.
const POINT_NAME_UUID_NAMESPACE = '8a2e6f4c-1d3b-4e9a-9c7f-2b5d8e1a6f3c';

// RFC4122 v5: SHA-1 of namespace+name, with version/variant bits set —
// implemented inline for the same reason as device.model.ts's uuidv5(): the
// `uuid` package is ESM-only and this file compiles as CommonJS.
function uuidv5(name: string, namespace: string): string {
	const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
	const hash = createHash('sha1').update(nsBytes).update(name, 'utf8').digest();
	hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
	hash[8] = (hash[8] & 0x3f) | 0x80; // variant RFC4122
	const hex = hash.subarray(0, 16).toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The natural key both provisionalPointId and the collision suffix hash are
 * derived from — sourceSystem + endpointName + deviceKey + rawName (plan
 * §3). Renaming a point at the source changes rawName, which changes this
 * key, which changes both derived hashes — the direct, documented
 * consequence of Phase 1's provisional (not durable) identity model.
 */
export function naturalKey(sourceSystem: string | undefined | null, endpointName: string, deviceKey: string, rawName: string): string {
	return `${sourceSystem ?? ''}\0${endpointName}\0${deviceKey}\0${rawName}`;
}

/** Deterministic, zero-I/O, synchronous — see plan §3. Never call this with anything other than fields already present on the reading. */
export function computeProvisionalPointId(sourceSystem: string | undefined | null, endpointName: string, deviceKey: string, rawName: string): string {
	return uuidv5(naturalKey(sourceSystem, endpointName, deviceKey, rawName), POINT_NAME_UUID_NAMESPACE);
}

/**
 * Short deterministic hash used for both the collision suffix (plan §7) and
 * the unnamed-point sentinel (plan §13) — same natural key input as
 * provisionalPointId, so no second hash primitive is introduced. 6 hex chars
 * (24 bits, ~16.7M values): enough to keep accidental same-device suffix
 * collisions negligible at realistic point counts while staying readable.
 */
export function computeShortHash(sourceSystem: string | undefined | null, endpointName: string, deviceKey: string, rawName: string): string {
	return createHash('sha1').update(naturalKey(sourceSystem, endpointName, deviceKey, rawName), 'utf8').digest('hex').slice(0, 6);
}
