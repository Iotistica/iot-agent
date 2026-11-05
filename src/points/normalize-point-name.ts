// Pre-suffix cap — leaves room for "_" + a 6-character collision suffix
// within the overall 128-character normalized-name ceiling.
const MAX_BASE_LENGTH = 120;
const MAX_NORMALIZED_NAME_LENGTH = 128;

// Unicode combining diacritical marks (U+0300-U+036F).
const COMBINING_MARKS = new RegExp('[̀-ͯ]', 'g');
const SEPARATOR_CHARS = /[\s\-./:()&+]/g;
const UNSAFE_CHARS = /[^a-z0-9_]/g;
const REPEATED_UNDERSCORES = /_+/g;
const TRIM_UNDERSCORES = /^_+|_+$/g;

/**
 * Pure, deterministic slug normalization.
 *
 * Examples:
 *   "AHU-Test Filter DP Alarm" -> "ahu_test_filter_dp_alarm"
 *   "VAV-101 Zone Temp"        -> "vav_101_zone_temp"
 */
export function normalizePointName(rawName: string): string {
	if (typeof rawName !== 'string') return '';

	let normalized = rawName
		.normalize('NFKD')
		.replace(COMBINING_MARKS, '')
		.trim()
		.toLowerCase()
		.replace(SEPARATOR_CHARS, '_')
		.replace(UNSAFE_CHARS, '_')
		.replace(REPEATED_UNDERSCORES, '_')
		.replace(TRIM_UNDERSCORES, '');

	if (normalized.length > MAX_BASE_LENGTH) {
		normalized = normalized
			.slice(0, MAX_BASE_LENGTH)
			.replace(TRIM_UNDERSCORES, '');
	}

	return normalized;
}

/**
 * Builds the canonical point name using:
 *
 *   <normalized_device_name>_<normalized_point_name>
 *
 * The device prefix is omitted only when the COMPLETE normalized device name
 * is already present at the beginning of the normalized point name.
 *
 * Partial shared-token matching is intentionally not used.
 *
 * Examples:
 *
 * device = "AHU-Test"
 * point  = "Zone Temp"
 * result = "ahu_test_zone_temp"
 *
 * device = "AHU-Test"
 * point  = "AHU-Test Zone Temp"
 * result = "ahu_test_zone_temp"
 *
 * device = "AHU-Test"
 * point  = "AHU Zone Temp"
 * result = "ahu_test_ahu_zone_temp"
 */
export function buildNormalizedPointName(
	rawDeviceName: string | undefined,
	rawPointName: string,
): string {
	const devicePart = rawDeviceName
		? normalizePointName(rawDeviceName)
		: '';

	const pointPart = normalizePointName(rawPointName);

	if (!devicePart && !pointPart) {
		return '';
	}

	if (!devicePart) {
		return pointPart.slice(0, MAX_NORMALIZED_NAME_LENGTH);
	}

	if (!pointPart) {
		return devicePart.slice(0, MAX_NORMALIZED_NAME_LENGTH);
	}

	// Avoid duplicating the device name only when the full normalized
	// device name is already present as a token-delimited prefix.
	if (
		pointPart === devicePart ||
		pointPart.startsWith(`${devicePart}_`)
	) {
		return pointPart.slice(0, MAX_NORMALIZED_NAME_LENGTH);
	}

	const combined = `${devicePart}_${pointPart}`;

	return combined
		.slice(0, MAX_NORMALIZED_NAME_LENGTH)
		.replace(TRIM_UNDERSCORES, '');
}