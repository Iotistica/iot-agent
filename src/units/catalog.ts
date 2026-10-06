import { UnitDefinitionsModel, UnitAliasesModel, CustomUnitAliasesModel, type UnitDefinitionRecord, type UnitAliasRecord, type CustomUnitAliasRecord } from '../db/models/index.js';
import { UNIT_DEFINITIONS, UNIT_ALIASES, validateUnitCatalogSeed } from '../data/unit-catalog-seed.js';
import { normalizeSourceSystem } from './source-system.js';
import { getNormalizationHealthTracker } from './normalization-health-tracker.js';
import type { Logger } from './types.js';

/**
 * Reseeds unit_definitions/unit_aliases from the static seed dataset. Reference
 * data (decision #3, no runtime mutation path beyond this) — safe/idempotent
 * to run on every startup. Validates the seed's structural integrity first
 * (throws on failure — a shipped-code bug, not a runtime data problem), then
 * inserts base-unit rows before dependent rows (base_unit has a FOREIGN KEY
 * reference to unit_definitions(canonical_unit) — though this repo's SQLite
 * connection doesn't enable PRAGMA foreign_keys, the ordering is still done
 * for correctness/clarity).
 */
export function seedUnitCatalog(): void {
	const errors = validateUnitCatalogSeed();
	if (errors.length > 0) {
		throw new Error(`Unit catalog seed data is invalid:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
	}

	const baseUnitRows = UNIT_DEFINITIONS.filter((d) => d.base_unit === d.canonical_unit);
	const dependentRows = UNIT_DEFINITIONS.filter((d) => d.base_unit !== d.canonical_unit);
	for (const def of baseUnitRows) UnitDefinitionsModel.upsert(def);
	for (const def of dependentRows) UnitDefinitionsModel.upsert(def);

	for (const alias of UNIT_ALIASES) UnitAliasesModel.upsert(alias);
}

class UnitCatalog {
	private definitionsByCanonical = new Map<string, UnitDefinitionRecord>();
	// Two-tier lookup: `${sourceSystem}\0${aliasLower}` scoped map checked first, then aliasLower-keyed global map.
	private aliasesScoped = new Map<string, UnitAliasRecord>();
	private aliasesGlobal = new Map<string, UnitAliasRecord>();
	// Admin-created mappings (the dashboard "Resolve unit" action) — kept in
	// separate maps, never merged with the built-in pair above, so
	// resolvesViaBuiltIn() can check "is this already resolvable without any
	// custom mapping" precisely. Checked *before* the built-in maps in
	// resolveAlias() (custom wins), but that's the only place the two tiers mix.
	private customAliasesScoped = new Map<string, CustomUnitAliasRecord>();
	private customAliasesGlobal = new Map<string, CustomUnitAliasRecord>();
	private loaded = false;
	private logger?: Logger;
	private loggedUnknown = new Set<string>();

	init(logger?: Logger): void {
		this.logger = logger;
		this.reload();
	}

	reload(): void {
		seedUnitCatalog();

		this.definitionsByCanonical = new Map(UnitDefinitionsModel.getAll().map((d) => [d.canonical_unit, d]));

		this.aliasesScoped = new Map();
		this.aliasesGlobal = new Map();
		for (const alias of UnitAliasesModel.getAll()) {
			const lower = alias.alias.trim().toLowerCase();
			const sourceSystem = normalizeSourceSystem(alias.source_system);
			if (sourceSystem) {
				this.aliasesScoped.set(`${sourceSystem}\0${lower}`, alias);
			} else {
				this.aliasesGlobal.set(lower, alias);
			}
		}

		this.customAliasesScoped = new Map();
		this.customAliasesGlobal = new Map();
		for (const alias of CustomUnitAliasesModel.getAll()) {
			const lower = alias.alias.trim().toLowerCase();
			const sourceSystem = normalizeSourceSystem(alias.source_system);
			if (sourceSystem) {
				this.customAliasesScoped.set(`${sourceSystem}\0${lower}`, alias);
			} else {
				this.customAliasesGlobal.set(lower, alias);
			}
		}

		this.loaded = true;
	}

	private ensureLoaded(): void {
		if (!this.loaded) this.reload();
	}

	resolveAlias(rawUnit: string, sourceSystem?: string | null): UnitAliasRecord | CustomUnitAliasRecord | undefined {
		this.ensureLoaded();
		const lower = rawUnit.trim().toLowerCase();
		const normalizedSourceSystem = normalizeSourceSystem(sourceSystem);
		if (normalizedSourceSystem) {
			const customScoped = this.customAliasesScoped.get(`${normalizedSourceSystem}\0${lower}`);
			if (customScoped) return customScoped;
			const scoped = this.aliasesScoped.get(`${normalizedSourceSystem}\0${lower}`);
			if (scoped) return scoped;
		}
		const customGlobal = this.customAliasesGlobal.get(lower);
		if (customGlobal) return customGlobal;
		return this.aliasesGlobal.get(lower);
	}

	/**
	 * True only if rawUnit resolves via the built-in catalog alone (ignoring
	 * any custom/admin mapping). Used server-side by the "Resolve unit" route
	 * to enforce that a custom mapping may only ever fill in a currently
	 * unknown alias — never silently override a built-in one for the same
	 * scope.
	 */
	resolvesViaBuiltIn(rawUnit: string, sourceSystem?: string | null): boolean {
		this.ensureLoaded();
		const lower = rawUnit.trim().toLowerCase();
		const normalizedSourceSystem = normalizeSourceSystem(sourceSystem);
		if (normalizedSourceSystem && this.aliasesScoped.has(`${normalizedSourceSystem}\0${lower}`)) return true;
		return this.aliasesGlobal.has(lower);
	}

	getDefinition(canonicalUnit: string): UnitDefinitionRecord | undefined {
		this.ensureLoaded();
		return this.definitionsByCanonical.get(canonicalUnit);
	}

	logUnknownUnit(rawUnit: string, sourceSystem?: string): void {
		// Record every occurrence (before the log-spam dedup below, which only
		// ever fires once per key) — best-effort, never allowed to affect the
		// caller (normalizeUnitName(), on the live reading hot path).
		try {
			getNormalizationHealthTracker().recordUnknownUnit(rawUnit, sourceSystem);
		} catch {
			/* best-effort */
		}

		const key = `${normalizeSourceSystem(sourceSystem) ?? ''}\0${rawUnit}`;
		if (this.loggedUnknown.has(key)) return;
		this.loggedUnknown.add(key);
		this.logger?.warn('Unknown engineering unit encountered', { rawUnit, sourceSystem });
	}
}

let singleton: UnitCatalog | undefined;

export function getUnitCatalog(): UnitCatalog {
	if (!singleton) singleton = new UnitCatalog();
	return singleton;
}
