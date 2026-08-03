import { getUnitCatalog } from './catalog.js';
import type { ConversionRuleInfo } from './types.js';

export interface ConvertUnitResult {
	value: number;
	converted: boolean;
	conversionRule?: ConversionRuleInfo;
	warning?: string;
}

/**
 * Converts a value between two already-canonical unit names (no alias
 * resolution here — that's normalizeUnitName()'s job). Uses the base-unit
 * hub model: source -> base -> target, via each definition's own
 * multiplier/offset (base_value = value * multiplier + offset).
 */
export function convertUnit(value: number, fromUnit: string, toUnit: string): ConvertUnitResult {
	if (fromUnit === toUnit) {
		return { value, converted: false };
	}

	const catalog = getUnitCatalog();
	const from = catalog.getDefinition(fromUnit);
	const to = catalog.getDefinition(toUnit);

	if (!from) return { value, converted: false, warning: `Unknown canonical unit "${fromUnit}"` };
	if (!to) return { value, converted: false, warning: `Unknown canonical unit "${toUnit}"` };

	if (from.base_unit !== to.base_unit) {
		return {
			value,
			converted: false,
			warning: `Cannot convert "${fromUnit}" (quantity "${from.quantity}") to "${toUnit}" (quantity "${to.quantity}") — incompatible quantities`,
		};
	}

	const baseValue = value * from.multiplier + from.offset;
	const converted = (baseValue - to.offset) / to.multiplier;

	return {
		value: converted,
		converted: true,
		conversionRule: { source_unit: fromUnit, target_unit: toUnit, base_unit: from.base_unit },
	};
}
