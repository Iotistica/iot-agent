/**
 * Canonical device-identity normalization and display-name reconstruction.
 *
 * Every subsystem that tracks or shows a device's identity (schema drift,
 * anomaly detection) needs two things: a stable, case/format-insensitive key
 * to bucket state under, and a human-readable label to show it back. Before
 * this module existed, schema drift's bucketing (see detector.ts's
 * resolveDeviceId) and iot-agent's display-side reconstruction
 * (db/models/drift-labels.ts's prettifyDriftDeviceId) were independent,
 * unrelated reimplementations that could — and did — silently drift apart:
 * a device id shape one of them didn't anticipate (a single-instance source
 * with no uniqueness suffix, e.g. OPC-UA's "ahu_1") fell through
 * prettifyDriftDeviceId's suffix-stripping heuristic and got shown raw
 * instead of formatted, while multi-instance BACnet ids happened to work by
 * coincidence.
 *
 * This is the one place that logic lives now. Pro's own consumers
 * (schema-drift, anomaly) import it directly. iot-agent's
 * db/models/drift-labels.ts keeps its own copy in sync deliberately — it must
 * build and run independently. If you change the rules here, mirror the
 * change there too.
 */

const DEVICE_ID_SUFFIX_RE = /_\d+_[0-9a-f]{8}$/i;
const KNOWN_DEVICE_ACRONYMS = new Set(['ahu', 'vav', 'fcu', 'bms', 'hvac', 'rtu']);

function normalizeSlug(value: string): string {
    return value
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[\s-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/[^a-zA-Z0-9_.:]/g, '')
        .toLowerCase();
}

/**
 * Collapses a trailing suffix segment that's redundant with the rest of the
 * name — e.g. "ahu_1_ahu1" -> "ahu_1", "vav_f9_c_vavf9c" -> "vav_f9_c".
 * See detector.ts's resolveDeviceId for why this defense-in-depth exists.
 */
export function collapseRedundantSuffix(normalized: string): string {
    const segments = normalized.split('_');
    if (segments.length < 2) {
        return normalized;
    }

    const suffix = segments[segments.length - 1];
    // Require a few characters before treating a match as "redundant" — a
    // short segment (a single letter/digit room or unit label, e.g.
    // "conference_room_a") is far more likely a real distinguishing suffix
    // than a restated identifier, and single characters trivially collide
    // with unrelated prefixes (e.g. "data_1_a" contains "a").
    if (suffix.length < 3) {
        return normalized;
    }

    const prefix = segments.slice(0, -1).join('');
    return prefix.includes(suffix) ? segments.slice(0, -1).join('_') : normalized;
}

/** Canonical bucket-key normalization: raw device name -> stable, format-insensitive slug. */
export function normalizeDeviceId(raw: string): string {
    return collapseRedundantSuffix(normalizeSlug(raw));
}

/**
 * Reconstructs a human-readable label from a normalized device id slug.
 * Strips a "_{instance}_{8-hex-id}" uniqueness suffix if present (see
 * resolveDeviceId) — but, critically, still formats the remainder even when
 * there's no such suffix to strip, since a single-instance source's id (e.g.
 * OPC-UA's "ahu_1") is just as legitimate and deserves the same treatment.
 *
 * Joined with hyphens, not spaces: every real device display name in this
 * fleet (from device metadata.objectName, e.g. what DataFlowView.vue shows —
 * "AHU-1", "FCU-F9-A", "Chiller-Plant-2", "Meter-8") uses a hyphen between
 * every segment, matching the source simulators' own naming convention. A
 * normalized slug can't recover which separator (space, hyphen, underscore)
 * the original used, but hyphen is the one actually in use everywhere, so
 * that's what reconstruction should target — not an arbitrary default.
 */
/**
 * Reformats a normalized field-name slug ("cc_valve") for display as
 * "cc-valve" — matching the lowercase, hyphen-joined convention actually used
 * for metric/field names in Data View (e.g. "current-l1", "room-temp",
 * "cw-supply-temp"). Unlike device ids, field names don't get title-cased or
 * acronym-uppercased — Data View shows them lowercase as-is, so this only
 * swaps the separator, nothing else.
 */
export function prettifyFieldName(field: string): string {
    return field.replace(/_/g, '-');
}

export function prettifyDeviceId(id: string): string {
    const stripped = id.replace(DEVICE_ID_SUFFIX_RE, '');

    return stripped
        .split('_')
        .filter(Boolean)
        .map((p) => (KNOWN_DEVICE_ACRONYMS.has(p.toLowerCase()) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
        .join('-');
}
