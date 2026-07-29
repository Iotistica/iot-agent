/**
 * Shared display-cleanup for schema drift's internal identifiers. Used by every
 * place that stores or serves schema-drift data for human consumption — the
 * alert/incident/event pipeline (publish/core/manager.ts), the Schema Drift
 * baseline grid API (api/v1.ts), and the anomaly Events/Incidents/Alerts API
 * (api/anomaly.ts) — so a field/device/protocol name reads the same way
 * everywhere instead of each call site re-implementing its own regex.
 *
 * Field keys carry an internal "reading:"/"key:" namespace tag (see
 * SchemaDriftDetector.extractSchema in the Pro package) and device identities
 * carry a "_{instance}_{8-hex-id}" uniqueness suffix (see resolveDeviceId) —
 * neither is meaningful to an operator.
 *
 * The device-id logic here (prettifyDriftDeviceId) is a deliberate, documented
 * duplicate of iot-agent-pro's src/device-identity/index.ts (prettifyDeviceId)
 * — not an independent reimplementation that's free to drift. This file has to
 * build and run without @iotistica/agent-pro installed (it's an optional,
 * dynamically-loaded dependency — see src/pro/loader.ts), so it can't take a
 * static import from that package. If the formatting rules change, change both.
 */

const DRIFT_FIELD_PREFIX_RE = /^(reading|key):/;
const DRIFT_DEVICE_SUFFIX_RE = /_\d+_[0-9a-f]{8}$/i;
const KNOWN_DEVICE_ACRONYMS = new Set(['ahu', 'vav', 'fcu', 'bms', 'hvac', 'rtu']);
const PROTOCOL_PIPE_SUFFIX_RE = /-pipe$/;

export function cleanDriftFieldName(field: string): string {
	return field.replace(DRIFT_FIELD_PREFIX_RE, '');
}

/**
 * Reformats a normalized field-name slug ("cc_valve") for display as
 * "cc-valve" — matching the lowercase, hyphen-joined convention actually used
 * for metric/field names in Data View (e.g. "current-l1", "room-temp",
 * "cw-supply-temp"). Unlike device ids, field names don't get title-cased or
 * acronym-uppercased — Data View shows them lowercase as-is, so this only
 * swaps the separator. Apply after cleanDriftFieldName()/stripFieldDevicePrefix()
 * (both still expect underscore-joined input), not before.
 *
 * Kept in sync with iot-agent-pro/src/device-identity/index.ts's
 * prettifyFieldName — see the module doc comment above for why this file
 * can't just import it.
 */
export function prettifyDriftFieldName(field: string): string {
	return field.replace(/_/g, '-');
}

export function prettifyDriftDeviceId(id: string): string {
	// Not every device id carries the "_{instance}_{8-hex-id}" uniqueness suffix
	// (see resolveDeviceId) — a single-instance source (OPC-UA, Modbus, a lone
	// BACnet device) normalizes straight to e.g. "ahu_1" with nothing to strip.
	// That's still a legitimate device id and deserves the same acronym/title
	// casing, so formatting must not be skipped just because there's no suffix.
	const stripped = id.replace(DRIFT_DEVICE_SUFFIX_RE, '');

	// Joined with hyphens, not spaces: every real device display name in this
	// fleet (metadata.objectName, e.g. what DataFlowView.vue shows — "AHU-1",
	// "FCU-F9-A", "Chiller-Plant-2", "Meter-8") uses a hyphen between every
	// segment. A normalized slug can't recover the original separator, but
	// hyphen is the one actually in use everywhere, so that's the target.
	//
	// Kept in sync by hand with iot-agent-pro/src/device-identity/index.ts's
	// prettifyDeviceId — this file can't take a static import from
	// @iotistica/agent-pro (see the module doc comment above), so this is a
	// deliberate, documented duplicate rather than an independent reimplementation.
	return stripped
		.split('_')
		.filter(Boolean)
		.map((p) => (KNOWN_DEVICE_ACRONYMS.has(p.toLowerCase()) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
		.join('-');
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
