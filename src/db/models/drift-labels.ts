/**
 * Shared display-cleanup for schema drift's internal identifiers. Used by every
 * place that stores or serves schema-drift data for human consumption — the
 * alert/incident/event pipeline (publish/core/manager.ts) and the Schema Drift
 * baseline grid API (api/v1.ts) — so a field/device/protocol name reads the
 * same way everywhere instead of each call site re-implementing its own regex.
 *
 * Field keys carry an internal "reading:"/"key:" namespace tag (see
 * SchemaDriftDetector.extractSchema in the Pro package) and device identities
 * carry a "_{instance}_{8-hex-id}" uniqueness suffix (see resolveDeviceId) —
 * neither is meaningful to an operator.
 */

const DRIFT_FIELD_PREFIX_RE = /^(reading|key):/;
const DRIFT_DEVICE_SUFFIX_RE = /_\d+_[0-9a-f]{8}$/i;
const KNOWN_DEVICE_ACRONYMS = new Set(['ahu', 'vav', 'fcu', 'bms', 'hvac', 'rtu']);
const PROTOCOL_PIPE_SUFFIX_RE = /-pipe$/;

export function cleanDriftFieldName(field: string): string {
	return field.replace(DRIFT_FIELD_PREFIX_RE, '');
}

export function prettifyDriftDeviceId(id: string): string {
	const stripped = id.replace(DRIFT_DEVICE_SUFFIX_RE, '');
	if (stripped === id) return id; // no match — not a schema-drift-style device id

	return stripped
		.split('_')
		.filter(Boolean)
		.map((p) => (KNOWN_DEVICE_ACRONYMS.has(p.toLowerCase()) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
		.join(' ');
}

/** "bacnet-pipe" -> "bacnet" — pipes are always named "{protocol}-pipe" (see initDevicePublish() in init/features.ts). */
export function cleanProtocolPipeName(endpointName: string): string {
	return endpointName.replace(PROTOCOL_PIPE_SUFFIX_RE, '');
}

/**
 * Some protocols (BACnet) build each reading's field name as "{device}_{object}"
 * before schema drift ever sees it — the raw device identity is baked directly
 * into the field, not tracked separately the way a UUID-scoped anomaly metric
 * is. Since the device is already stored/shown in its own column, strip that
 * same prefix from the field so it isn't repeated. `field` should already be
 * cleanDriftFieldName()'d; `deviceId` is the raw (unprettified) device identity.
 */
export function stripFieldDevicePrefix(field: string, deviceId: string): string {
	const deviceBase = deviceId.replace(DRIFT_DEVICE_SUFFIX_RE, '');
	if (deviceBase.toLowerCase() === deviceId.toLowerCase()) return field; // not a per-device id — nothing to strip

	const prefix = `${deviceBase.toLowerCase()}_`;
	return field.toLowerCase().startsWith(prefix) ? field.slice(prefix.length) : field;
}
