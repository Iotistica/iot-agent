import { canonicalizeAddress, type CanonicalAddressResult } from './canonical-address.js';

export const MAX_MQTT_FIELD_IDENTITIES = 1000;

export function resolveMqttConfiguredFields(connection: unknown):
	| { status: 'resolved'; fields: Array<Extract<CanonicalAddressResult, { status: 'resolved' }>> }
	| { status: 'invalid'; reason: string } {
	if (typeof connection !== 'object' || connection === null || Array.isArray(connection)) {
		return { status: 'invalid', reason: 'invalid connection' };
	}
	const configured = (connection as Record<string, unknown>).pointIdentityFields;
	if (configured === undefined) return { status: 'resolved', fields: [] };
	if (!Array.isArray(configured) || configured.length > MAX_MQTT_FIELD_IDENTITIES) {
		return { status: 'invalid', reason: `pointIdentityFields must contain at most ${MAX_MQTT_FIELD_IDENTITIES} entries` };
	}
	const fields: Array<Extract<CanonicalAddressResult, { status: 'resolved' }>> = [];
	const keys = new Set<string>();
	for (const entry of configured) {
		if (typeof entry !== 'object' || entry === null || Array.isArray(entry) ||
			Object.keys(entry).length !== 2) {
			return { status: 'invalid', reason: 'invalid field entry' };
		}
		const { topic, selector } = entry as Record<string, unknown>;
		const result = canonicalizeAddress({ protocol: 'mqtt', topic, selector, selectorSource: 'configured' });
		if (result.status !== 'resolved' || result.provenance.protocol !== 'mqtt' ||
			result.provenance.selector.kind !== 'path') {
			return { status: 'invalid', reason: 'invalid concrete topic or field selector' };
		}
		if (keys.has(result.addressKey)) return { status: 'invalid', reason: 'duplicate field selector' };
		keys.add(result.addressKey);
		fields.push(result);
	}
	return { status: 'resolved', fields };
}
