// Pre-suffix cap — leaves room for a `_` + 6-hex-char collision suffix (7
// chars, plan §7) within the overall 128-char normalizedName ceiling (plan §13).
const MAX_BASE_LENGTH = 120;

// Unicode combining diacritical marks (U+0300-U+036F) — stripped after NFKD
// decomposition so e.g. "Café" -> "cafe" rather than retaining a combining accent.
const COMBINING_MARKS = new RegExp('[̀-ͯ]', 'g');
const SEPARATOR_CHARS = /[\s\-./:()&+]/g;
const UNSAFE_CHARS = /[^a-z0-9_]/g;
const REPEATED_UNDERSCORES = /_+/g;
const TRIM_UNDERSCORES = /^_+|_+$/g;

/**
 * Pure, deterministic point-name slug pipeline (plan §5) — never throws,
 * empty/invalid input is a normal outcome (returns ''), not an error, mirroring
 * normalizeUnitName()'s style. Token-mapping/abbreviation expansion is an
 * intentional no-op in Phase 1 (plan §6 — no abbreviation_rules catalog ships
 * yet): every token that survives steps 1-9 passes through unchanged.
 *
 * Worked examples (plan §5):
 *   "AHU-Test Filter DP Alarm" -> "ahu_test_filter_dp_alarm"
 *   "VAV-101 Zone Temp"        -> "vav_101_zone_temp"
 */
export function normalizePointName(rawName: string): string {
	if (typeof rawName !== 'string') return '';

	let s = rawName.normalize('NFKD').replace(COMBINING_MARKS, '');
	s = s.trim().toLowerCase();
	s = s.replace(SEPARATOR_CHARS, '_');
	s = s.replace(UNSAFE_CHARS, '_');
	s = s.replace(REPEATED_UNDERSCORES, '_');
	s = s.replace(TRIM_UNDERSCORES, '');

	// Step 9 (numeric-ID preservation) is a no-op here — separators already
	// isolated digit runs as their own '_'-delimited token above.
	// Step 10 (token mapping) is a no-op in Phase 1 — see plan §6.

	if (s.length > MAX_BASE_LENGTH) {
		s = s.slice(0, MAX_BASE_LENGTH).replace(TRIM_UNDERSCORES, '');
	}

	return s;
}
