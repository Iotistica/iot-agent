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
 *
 * This has no production callers from the live interceptor chain — numeric
 * conversion only ever runs when explicitly requested (normalizeUnit()'s
 * `targetUnit` option), and nothing in the live pipeline passes one yet;
 * there's no "preferred unit" config surface for most protocols. MQTT is
 * the one exception: its adapter (src/plugins/mqtt/adapter.ts,
 * convertUnitValue()) has its own per-metric "target unit" config and calls
 * this function directly (translating its own short unit codes to this
 * module's canonical names first) — that's a deliberate, narrow use of this
 * shared implementation, not evidence it should be wired into the generic
 * interceptor. Any *new* unit needed by MQTT (or anywhere else) should be
 * added to the shared catalog (src/data/unit-catalog-seed.ts), not a new
 * protocol-local conversion table.
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
