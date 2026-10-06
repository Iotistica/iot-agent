export { normalizeUnitName, deriveProvenance } from './normalize-unit-name.js';
export type { NormalizeUnitNameResult } from './normalize-unit-name.js';
export { convertUnit } from './convert-unit.js';
export type { ConvertUnitResult } from './convert-unit.js';
export { normalizeUnit } from './normalize-unit.js';
export { getUnitCatalog, seedUnitCatalog } from './catalog.js';
export { createUnitNormalizationInterceptor } from './interceptor.js';
export type {
	UnitValue,
	UnitProvenance,
	NormalizeUnitOptions,
	NormalizeUnitResult,
	MatchedAlias,
	ConversionRuleInfo,
	Logger,
} from './types.js';
