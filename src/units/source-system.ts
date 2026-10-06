/**
 * Normalizes a protocol/source-system identifier before it's used as a
 * scoped-alias lookup key (e.g. unit-catalog or point-name natural keys).
 * `trim().toLowerCase()` — matching the normalization already applied to
 * alias text itself (UnitCatalog.reload()/resolveAlias(),
 * src/units/catalog.ts). Today every caller happens to pass an
 * already-lowercase literal ('mqtt', 'bacnet', etc.) by convention; this
 * makes that an enforced guarantee rather than an unenforced assumption —
 * e.g. "MQTT"/"mqtt"/" MQTT " must all resolve the same scoped aliases.
 *
 * Returns null (not '') for empty/whitespace-only/missing input, matching
 * the existing convention of treating "no source system" as null/undefined
 * rather than an empty string sentinel.
 */
export function normalizeSourceSystem(sourceSystem: string | null | undefined): string | null {
	const trimmed = sourceSystem?.trim().toLowerCase();
	return trimmed ? trimmed : null;
}
