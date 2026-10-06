/** Minimal logger shape — keeps this module self-contained, matches the pattern used by other standalone services in this repo (e.g. publish plugins). */
export interface Logger {
	debug(message: string, ...args: any[]): void;
	info(message: string, ...args: any[]): void;
	warn(message: string, ...args: any[]): void;
	error(message: string, ...args: any[]): void;
}

/**
 * Facts about how a unit name was resolved — normalization emits facts only,
 * never a confidence/trust judgement. The quality layer (src/quality/) owns
 * translating these facts into a confidence number via policy, independently
 * versionable from normalization itself.
 */
export interface UnitProvenance {
	method: 'exact-canonical' | 'scoped-alias' | 'global-alias' | 'unresolved';
	/** The source_system an alias was scoped to, if any. */
	sourceSystem?: string | null;
}

export interface UnitValue {
	rawValue: number;
	rawUnit: string;
	value: number;
	unit: string;
	/** undefined (not '') when the unit didn't resolve — normalized:false means "we don't know", not "we know it's empty". */
	quantity?: string;
	normalized: boolean;
	converted: boolean;
	provenance: UnitProvenance;
}

export interface NormalizeUnitOptions {
	/** Protocol/source scoping for alias lookup, e.g. 'bacnet' | 'mqtt' | 'opcua' | 'modbus'. */
	sourceSystem?: string;
	/** If provided (and !alreadyConverted), triggers convertUnit() to this canonical unit. */
	targetUnit?: string;
	/** True for readings whose value was already converted upstream (e.g. MQTT's own engine) — resolve the name, never re-convert the value. */
	alreadyConverted?: boolean;
	/** Suppress the unknown-unit admin log line (e.g. bulk backfills). */
	quiet?: boolean;
}

export interface MatchedAlias {
	source_system: string | null;
	alias: string;
}

export interface ConversionRuleInfo {
	source_unit: string;
	target_unit: string;
	base_unit: string;
}

export interface NormalizeUnitResult {
	unitValue: UnitValue;
	matchedAlias?: MatchedAlias;
	conversionRule?: ConversionRuleInfo;
	conversionStage?: 'source-adapter';
	warning?: string;
}
