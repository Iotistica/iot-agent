/**
 * Static seed dataset for the Unit Normalization Service catalog.
 * Follows the same convention as app-templates.ts: plain exported arrays,
 * no DB import here. src/normalization/catalog.ts's seedUnitCatalog() upserts
 * these into unit_definitions/unit_aliases on every startup (reference data,
 * immutable at runtime — see plan decision #3).
 *
 * Conversion uses a base-unit hub model (decision #6): each definition
 * carries its own base_unit/multiplier/offset describing its relationship to
 * its quantity's reference unit — `base_value = value * multiplier + offset`.
 * The base unit of a quantity is its own self-referential row
 * (base_unit === canonical_unit, multiplier=1, offset=0).
 *
 * "Differential Pressure" (an Initial Quantity in the spec) intentionally
 * shares the `pressure` quantity/unit set rather than getting its own —
 * differential-pressure sensors report in the same Pa/kPa/bar/psi units as
 * any other pressure point. Which semantic category a reading belongs to is
 * a Haystack-tagging concern, not a unit-normalization concern (see the
 * pipeline's "do not derive semantics from units" principle).
 */

export interface SeedUnitDefinition {
	canonical_unit: string;
	quantity: string;
	symbol?: string;
	description?: string;
	base_unit: string;
	multiplier: number;
	offset: number;
}

export interface SeedUnitAlias {
	/** null = protocol-independent/global alias — see decision #10: never a single character. */
	source_system: string | null;
	alias: string;
	canonical_unit: string;
}

export const UNIT_DEFINITIONS: SeedUnitDefinition[] = [
	// ── Temperature (base: degreesCelsius) ──────────────────────────────────
	{ canonical_unit: 'degreesCelsius', quantity: 'temperature', symbol: '°C', description: 'Degrees Celsius', base_unit: 'degreesCelsius', multiplier: 1, offset: 0 },
	{ canonical_unit: 'degreesFahrenheit', quantity: 'temperature', symbol: '°F', description: 'Degrees Fahrenheit', base_unit: 'degreesCelsius', multiplier: 5 / 9, offset: -17.7777777778 },
	{ canonical_unit: 'kelvin', quantity: 'temperature', symbol: 'K', description: 'Kelvin', base_unit: 'degreesCelsius', multiplier: 1, offset: -273.15 },

	// ── Pressure (base: pascals; also covers Differential Pressure) ────────
	{ canonical_unit: 'pascals', quantity: 'pressure', symbol: 'Pa', description: 'Pascals', base_unit: 'pascals', multiplier: 1, offset: 0 },
	{ canonical_unit: 'kilopascals', quantity: 'pressure', symbol: 'kPa', description: 'Kilopascals', base_unit: 'pascals', multiplier: 1000, offset: 0 },
	{ canonical_unit: 'bars', quantity: 'pressure', symbol: 'bar', description: 'Bars', base_unit: 'pascals', multiplier: 100000, offset: 0 },
	{ canonical_unit: 'psi', quantity: 'pressure', symbol: 'psi', description: 'Pounds per square inch', base_unit: 'pascals', multiplier: 6894.76, offset: 0 },

	// ── Airflow (base: litersPerSecond) ─────────────────────────────────────
	{ canonical_unit: 'litersPerSecond', quantity: 'airflow', symbol: 'L/s', description: 'Liters per second', base_unit: 'litersPerSecond', multiplier: 1, offset: 0 },
	{ canonical_unit: 'cubicFeetPerMinute', quantity: 'airflow', symbol: 'CFM', description: 'Cubic feet per minute', base_unit: 'litersPerSecond', multiplier: 0.471947443, offset: 0 },

	// ── Liquid Flow (base: litersPerMinute) ─────────────────────────────────
	{ canonical_unit: 'litersPerMinute', quantity: 'liquidFlow', symbol: 'L/min', description: 'Liters per minute', base_unit: 'litersPerMinute', multiplier: 1, offset: 0 },
	{ canonical_unit: 'gallonsPerMinute', quantity: 'liquidFlow', symbol: 'GPM', description: 'US gallons per minute', base_unit: 'litersPerMinute', multiplier: 3.785411784, offset: 0 },

	// ── Velocity (base: metersPerSecond) ─────────────────────────────────────
	{ canonical_unit: 'metersPerSecond', quantity: 'velocity', symbol: 'm/s', description: 'Meters per second', base_unit: 'metersPerSecond', multiplier: 1, offset: 0 },
	{ canonical_unit: 'feetPerMinute', quantity: 'velocity', symbol: 'ft/min', description: 'Feet per minute', base_unit: 'metersPerSecond', multiplier: 0.00508, offset: 0 },

	// ── Power (base: watts) ──────────────────────────────────────────────────
	{ canonical_unit: 'watts', quantity: 'power', symbol: 'W', description: 'Watts', base_unit: 'watts', multiplier: 1, offset: 0 },
	{ canonical_unit: 'kilowatts', quantity: 'power', symbol: 'kW', description: 'Kilowatts', base_unit: 'watts', multiplier: 1000, offset: 0 },
	{ canonical_unit: 'megawatts', quantity: 'power', symbol: 'MW', description: 'Megawatts', base_unit: 'watts', multiplier: 1000000, offset: 0 },

	// ── Energy (base: wattHours) ─────────────────────────────────────────────
	{ canonical_unit: 'wattHours', quantity: 'energy', symbol: 'Wh', description: 'Watt-hours', base_unit: 'wattHours', multiplier: 1, offset: 0 },
	{ canonical_unit: 'kilowattHours', quantity: 'energy', symbol: 'kWh', description: 'Kilowatt-hours', base_unit: 'wattHours', multiplier: 1000, offset: 0 },

	// ── Voltage / Current / Frequency (single-unit quantities) ──────────────
	{ canonical_unit: 'volts', quantity: 'voltage', symbol: 'V', description: 'Volts', base_unit: 'volts', multiplier: 1, offset: 0 },
	{ canonical_unit: 'amperes', quantity: 'current', symbol: 'A', description: 'Amperes', base_unit: 'amperes', multiplier: 1, offset: 0 },
	{ canonical_unit: 'hertz', quantity: 'frequency', symbol: 'Hz', description: 'Hertz', base_unit: 'hertz', multiplier: 1, offset: 0 },

	// ── Time (base: seconds) ─────────────────────────────────────────────────
	{ canonical_unit: 'seconds', quantity: 'time', symbol: 's', description: 'Seconds', base_unit: 'seconds', multiplier: 1, offset: 0 },
	{ canonical_unit: 'minutes', quantity: 'time', symbol: 'min', description: 'Minutes', base_unit: 'seconds', multiplier: 60, offset: 0 },
	{ canonical_unit: 'hours', quantity: 'time', symbol: 'h', description: 'Hours', base_unit: 'seconds', multiplier: 3600, offset: 0 },

	// ── Percentage / Relative Humidity (kept distinct, matches BACnet's own split) ──
	{ canonical_unit: 'percent', quantity: 'percentage', symbol: '%', description: 'Percent', base_unit: 'percent', multiplier: 1, offset: 0 },
	{ canonical_unit: 'percentRelativeHumidity', quantity: 'relativeHumidity', symbol: '%RH', description: 'Percent relative humidity', base_unit: 'percentRelativeHumidity', multiplier: 1, offset: 0 },

	// ── Concentration (base: partsPerMillion) ────────────────────────────────
	{ canonical_unit: 'partsPerMillion', quantity: 'concentration', symbol: 'ppm', description: 'Parts per million', base_unit: 'partsPerMillion', multiplier: 1, offset: 0 },
	{ canonical_unit: 'partsPerBillion', quantity: 'concentration', symbol: 'ppb', description: 'Parts per billion', base_unit: 'partsPerMillion', multiplier: 0.001, offset: 0 },

	// ── Length (base: meters) ────────────────────────────────────────────────
	{ canonical_unit: 'meters', quantity: 'length', symbol: 'm', description: 'Meters', base_unit: 'meters', multiplier: 1, offset: 0 },
	{ canonical_unit: 'feet', quantity: 'length', symbol: 'ft', description: 'Feet', base_unit: 'meters', multiplier: 0.3048, offset: 0 },

	// ── Area (base: squareMeters) ────────────────────────────────────────────
	{ canonical_unit: 'squareMeters', quantity: 'area', symbol: 'm²', description: 'Square meters', base_unit: 'squareMeters', multiplier: 1, offset: 0 },
	{ canonical_unit: 'squareFeet', quantity: 'area', symbol: 'ft²', description: 'Square feet', base_unit: 'squareMeters', multiplier: 0.09290304, offset: 0 },

	// ── Volume (base: liters) ────────────────────────────────────────────────
	{ canonical_unit: 'liters', quantity: 'volume', symbol: 'L', description: 'Liters', base_unit: 'liters', multiplier: 1, offset: 0 },
	{ canonical_unit: 'cubicMeters', quantity: 'volume', symbol: 'm³', description: 'Cubic meters', base_unit: 'liters', multiplier: 1000, offset: 0 },
	{ canonical_unit: 'gallons', quantity: 'volume', symbol: 'gal', description: 'US gallons', base_unit: 'liters', multiplier: 3.785411784, offset: 0 },

	// ── Mass (base: kilograms) ───────────────────────────────────────────────
	{ canonical_unit: 'kilograms', quantity: 'mass', symbol: 'kg', description: 'Kilograms', base_unit: 'kilograms', multiplier: 1, offset: 0 },
	{ canonical_unit: 'pounds', quantity: 'mass', symbol: 'lb', description: 'Pounds', base_unit: 'kilograms', multiplier: 0.45359237, offset: 0 },
];

export const UNIT_ALIASES: SeedUnitAlias[] = [
	// ── Global (multi-character, unambiguous — decision #10) ────────────────
	{ source_system: null, alias: '°C', canonical_unit: 'degreesCelsius' },
	{ source_system: null, alias: 'degC', canonical_unit: 'degreesCelsius' },
	{ source_system: null, alias: 'deg C', canonical_unit: 'degreesCelsius' },
	{ source_system: null, alias: 'celsius', canonical_unit: 'degreesCelsius' },
	{ source_system: null, alias: 'Celsius', canonical_unit: 'degreesCelsius' },
	{ source_system: null, alias: '°F', canonical_unit: 'degreesFahrenheit' },
	{ source_system: null, alias: 'degF', canonical_unit: 'degreesFahrenheit' },
	{ source_system: null, alias: 'deg F', canonical_unit: 'degreesFahrenheit' },
	{ source_system: null, alias: 'fahrenheit', canonical_unit: 'degreesFahrenheit' },
	{ source_system: null, alias: 'Fahrenheit', canonical_unit: 'degreesFahrenheit' },
	{ source_system: null, alias: 'kelvin', canonical_unit: 'kelvin' },
	{ source_system: null, alias: 'Kelvin', canonical_unit: 'kelvin' },

	{ source_system: null, alias: 'kPa', canonical_unit: 'kilopascals' },
	{ source_system: null, alias: 'KPA', canonical_unit: 'kilopascals' },
	{ source_system: null, alias: 'kilopascals', canonical_unit: 'kilopascals' },
	{ source_system: null, alias: 'Pa', canonical_unit: 'pascals' },
	{ source_system: null, alias: 'pascals', canonical_unit: 'pascals' },
	{ source_system: null, alias: 'bar', canonical_unit: 'bars' },
	{ source_system: null, alias: 'bars', canonical_unit: 'bars' },
	{ source_system: null, alias: 'psi', canonical_unit: 'psi' },
	{ source_system: null, alias: 'PSI', canonical_unit: 'psi' },

	{ source_system: null, alias: 'CFM', canonical_unit: 'cubicFeetPerMinute' },
	{ source_system: null, alias: 'cfm', canonical_unit: 'cubicFeetPerMinute' },
	{ source_system: null, alias: 'ft3/min', canonical_unit: 'cubicFeetPerMinute' },
	{ source_system: null, alias: 'L/s', canonical_unit: 'litersPerSecond' },
	{ source_system: null, alias: 'l/s', canonical_unit: 'litersPerSecond' },
	{ source_system: null, alias: 'GPM', canonical_unit: 'gallonsPerMinute' },
	{ source_system: null, alias: 'gpm', canonical_unit: 'gallonsPerMinute' },
	{ source_system: null, alias: 'L/min', canonical_unit: 'litersPerMinute' },
	{ source_system: null, alias: 'l/min', canonical_unit: 'litersPerMinute' },

	{ source_system: null, alias: 'm/s', canonical_unit: 'metersPerSecond' },
	{ source_system: null, alias: 'ft/min', canonical_unit: 'feetPerMinute' },
	{ source_system: null, alias: 'FPM', canonical_unit: 'feetPerMinute' },

	{ source_system: null, alias: 'kW', canonical_unit: 'kilowatts' },
	{ source_system: null, alias: 'kw', canonical_unit: 'kilowatts' },
	{ source_system: null, alias: 'kilowatts', canonical_unit: 'kilowatts' },
	{ source_system: null, alias: 'MW', canonical_unit: 'megawatts' },
	{ source_system: null, alias: 'watts', canonical_unit: 'watts' },
	{ source_system: null, alias: 'Wh', canonical_unit: 'wattHours' },
	{ source_system: null, alias: 'kWh', canonical_unit: 'kilowattHours' },
	{ source_system: null, alias: 'kwh', canonical_unit: 'kilowattHours' },

	{ source_system: null, alias: 'Hz', canonical_unit: 'hertz' },
	{ source_system: null, alias: 'hertz', canonical_unit: 'hertz' },

	{ source_system: null, alias: 'sec', canonical_unit: 'seconds' },
	{ source_system: null, alias: 'secs', canonical_unit: 'seconds' },
	{ source_system: null, alias: 'min', canonical_unit: 'minutes' },
	{ source_system: null, alias: 'mins', canonical_unit: 'minutes' },
	{ source_system: null, alias: 'hr', canonical_unit: 'hours' },
	{ source_system: null, alias: 'hrs', canonical_unit: 'hours' },

	{ source_system: null, alias: 'percent', canonical_unit: 'percent' },
	{ source_system: null, alias: 'percentage', canonical_unit: 'percent' },
	{ source_system: null, alias: '%RH', canonical_unit: 'percentRelativeHumidity' },
	{ source_system: null, alias: 'RH', canonical_unit: 'percentRelativeHumidity' },

	{ source_system: null, alias: 'ppm', canonical_unit: 'partsPerMillion' },
	{ source_system: null, alias: 'PPM', canonical_unit: 'partsPerMillion' },
	{ source_system: null, alias: 'ppb', canonical_unit: 'partsPerBillion' },

	{ source_system: null, alias: 'ft', canonical_unit: 'feet' },
	{ source_system: null, alias: 'feet', canonical_unit: 'feet' },
	{ source_system: null, alias: 'm²', canonical_unit: 'squareMeters' },
	{ source_system: null, alias: 'sqm', canonical_unit: 'squareMeters' },
	{ source_system: null, alias: 'ft²', canonical_unit: 'squareFeet' },
	{ source_system: null, alias: 'sqft', canonical_unit: 'squareFeet' },
	{ source_system: null, alias: 'gal', canonical_unit: 'gallons' },
	{ source_system: null, alias: 'gallons', canonical_unit: 'gallons' },
	{ source_system: null, alias: 'm³', canonical_unit: 'cubicMeters' },
	{ source_system: null, alias: 'liters', canonical_unit: 'liters' },
	{ source_system: null, alias: 'litres', canonical_unit: 'liters' },
	{ source_system: null, alias: 'kg', canonical_unit: 'kilograms' },
	{ source_system: null, alias: 'kilograms', canonical_unit: 'kilograms' },
	{ source_system: null, alias: 'lb', canonical_unit: 'pounds' },
	{ source_system: null, alias: 'lbs', canonical_unit: 'pounds' },
	{ source_system: null, alias: 'volts', canonical_unit: 'volts' },
	{ source_system: null, alias: 'amperes', canonical_unit: 'amperes' },
	{ source_system: null, alias: 'amps', canonical_unit: 'amperes' },

	// ── BACnet (source: BACNET_UNITS_SYMBOLS, src/plugins/bacnet/discovery.ts) ──
	// Scoped (not global) for consistency with how they're actually produced —
	// several are single characters ('K') which decision #10 requires scoping anyway.
	{ source_system: 'bacnet', alias: '°C', canonical_unit: 'degreesCelsius' },
	{ source_system: 'bacnet', alias: '°F', canonical_unit: 'degreesFahrenheit' },
	{ source_system: 'bacnet', alias: 'K', canonical_unit: 'kelvin' },
	{ source_system: 'bacnet', alias: '%', canonical_unit: 'percent' },
	{ source_system: 'bacnet', alias: '%RH', canonical_unit: 'percentRelativeHumidity' },
	{ source_system: 'bacnet', alias: 'ppm', canonical_unit: 'partsPerMillion' },
	{ source_system: 'bacnet', alias: 'W', canonical_unit: 'watts' },
	{ source_system: 'bacnet', alias: 'kW', canonical_unit: 'kilowatts' },
	{ source_system: 'bacnet', alias: 'MW', canonical_unit: 'megawatts' },
	{ source_system: 'bacnet', alias: 'Wh', canonical_unit: 'wattHours' },
	{ source_system: 'bacnet', alias: 'kWh', canonical_unit: 'kilowattHours' },
	{ source_system: 'bacnet', alias: 'V', canonical_unit: 'volts' },
	{ source_system: 'bacnet', alias: 'A', canonical_unit: 'amperes' },
	{ source_system: 'bacnet', alias: 'Hz', canonical_unit: 'hertz' },
	{ source_system: 'bacnet', alias: 'Pa', canonical_unit: 'pascals' },
	{ source_system: 'bacnet', alias: 'kPa', canonical_unit: 'kilopascals' },
	{ source_system: 'bacnet', alias: 'bar', canonical_unit: 'bars' },
	{ source_system: 'bacnet', alias: 'CFM', canonical_unit: 'cubicFeetPerMinute' },
	{ source_system: 'bacnet', alias: 'L/s', canonical_unit: 'litersPerSecond' },
	{ source_system: 'bacnet', alias: 'L/min', canonical_unit: 'litersPerMinute' },
	{ source_system: 'bacnet', alias: 's', canonical_unit: 'seconds' },
	{ source_system: 'bacnet', alias: 'min', canonical_unit: 'minutes' },
	{ source_system: 'bacnet', alias: 'h', canonical_unit: 'hours' },
	// Humanized fallback forms BACnet's discovery.ts falls back to for
	// uncurated codes (name.toLowerCase().replace(/_/g, ' ')).
	{ source_system: 'bacnet', alias: 'degrees celsius', canonical_unit: 'degreesCelsius' },
	{ source_system: 'bacnet', alias: 'degrees fahrenheit', canonical_unit: 'degreesFahrenheit' },
	{ source_system: 'bacnet', alias: 'square feet', canonical_unit: 'squareFeet' },
	{ source_system: 'bacnet', alias: 'square meters', canonical_unit: 'squareMeters' },

	// ── MQTT (source: canonicalizeUnit() output, src/plugins/mqtt/adapter.ts) ──
	// Single-letter codes MUST stay scoped here (decision #10) — never global.
	{ source_system: 'mqtt', alias: 'C', canonical_unit: 'degreesCelsius' },
	{ source_system: 'mqtt', alias: 'F', canonical_unit: 'degreesFahrenheit' },
	{ source_system: 'mqtt', alias: 'K', canonical_unit: 'kelvin' },
	{ source_system: 'mqtt', alias: 'Pa', canonical_unit: 'pascals' },
	{ source_system: 'mqtt', alias: 'kPa', canonical_unit: 'kilopascals' },
	{ source_system: 'mqtt', alias: 'bar', canonical_unit: 'bars' },
	{ source_system: 'mqtt', alias: 'psi', canonical_unit: 'psi' },
	{ source_system: 'mqtt', alias: '%', canonical_unit: 'percent' },
	{ source_system: 'mqtt', alias: 'ppm', canonical_unit: 'partsPerMillion' },
	{ source_system: 'mqtt', alias: 'ppb', canonical_unit: 'partsPerBillion' },
	{ source_system: 'mqtt', alias: 'W', canonical_unit: 'watts' },
	{ source_system: 'mqtt', alias: 'kW', canonical_unit: 'kilowatts' },
	{ source_system: 'mqtt', alias: 'kWh', canonical_unit: 'kilowattHours' },
	{ source_system: 'mqtt', alias: 'V', canonical_unit: 'volts' },
	{ source_system: 'mqtt', alias: 'A', canonical_unit: 'amperes' },

	// ── Modbus (source: user's own spec example — modbus -> "C" -> degreesCelsius) ──
	{ source_system: 'modbus', alias: 'C', canonical_unit: 'degreesCelsius' },
];

// ─────────────────────────────────────────────────────────────────────────
// Seed-data self-consistency validation — pure, static, no DB. Run both as a
// unit test (test/unit/normalization/unit-catalog-seed.unit.spec.ts) and as
// a startup assertion in seedUnitCatalog() (src/normalization/catalog.ts):
// a failure here is a shipped-code bug, not a runtime data problem.
// ─────────────────────────────────────────────────────────────────────────

export function validateUnitCatalogSeed(
	definitions: SeedUnitDefinition[] = UNIT_DEFINITIONS,
	aliases: SeedUnitAlias[] = UNIT_ALIASES,
): string[] {
	const errors: string[] = [];
	const byCanonical = new Map(definitions.map((d) => [d.canonical_unit, d]));

	// Every definition's base_unit references a row that exists.
	for (const def of definitions) {
		if (!byCanonical.has(def.base_unit)) {
			errors.push(`Definition "${def.canonical_unit}" references unknown base_unit "${def.base_unit}"`);
		}
	}

	// Every quantity has exactly one base unit (a row where base_unit === canonical_unit).
	const baseUnitsByQuantity = new Map<string, string[]>();
	for (const def of definitions) {
		if (def.base_unit === def.canonical_unit) {
			const list = baseUnitsByQuantity.get(def.quantity) ?? [];
			list.push(def.canonical_unit);
			baseUnitsByQuantity.set(def.quantity, list);
		}
	}
	const quantities = new Set(definitions.map((d) => d.quantity));
	for (const quantity of quantities) {
		const bases = baseUnitsByQuantity.get(quantity) ?? [];
		if (bases.length === 0) errors.push(`Quantity "${quantity}" has no base unit (no row with base_unit === canonical_unit)`);
		if (bases.length > 1) errors.push(`Quantity "${quantity}" has more than one base unit: ${bases.join(', ')}`);
	}

	// Each definition has the same quantity as its base unit.
	for (const def of definitions) {
		const baseDef = byCanonical.get(def.base_unit);
		if (baseDef && baseDef.quantity !== def.quantity) {
			errors.push(`Definition "${def.canonical_unit}" (quantity "${def.quantity}") has base_unit "${def.base_unit}" whose quantity is "${baseDef.quantity}"`);
		}
	}

	// Multipliers finite and nonzero; offsets finite.
	for (const def of definitions) {
		if (!Number.isFinite(def.multiplier) || def.multiplier === 0) {
			errors.push(`Definition "${def.canonical_unit}" has an invalid multiplier: ${def.multiplier}`);
		}
		if (!Number.isFinite(def.offset)) {
			errors.push(`Definition "${def.canonical_unit}" has a non-finite offset: ${def.offset}`);
		}
	}

	// Every alias's canonical_unit references a row that exists.
	for (const alias of aliases) {
		if (!byCanonical.has(alias.canonical_unit)) {
			errors.push(`Alias "${alias.alias}" (source_system=${alias.source_system ?? 'null'}) references unknown canonical_unit "${alias.canonical_unit}"`);
		}
	}

	// No single-character alias is global (decision #10).
	for (const alias of aliases) {
		if (alias.source_system === null && alias.alias.trim().length === 1) {
			errors.push(`Alias "${alias.alias}" is a single character and must not be global — scope it to a source_system`);
		}
	}

	// No duplicate (source_system, alias) pairs (redundant with the DB UNIQUE
	// constraint, asserted here too so a broken seed fails fast in CI).
	const seenPairs = new Set<string>();
	for (const alias of aliases) {
		const key = `${alias.source_system ?? ' '}${alias.alias}`;
		if (seenPairs.has(key)) {
			errors.push(`Duplicate alias pair: source_system=${alias.source_system ?? 'null'}, alias="${alias.alias}"`);
		}
		seenPairs.add(key);
	}

	// No two global aliases share the same alias string with different canonical units (ambiguity).
	const globalAliasTargets = new Map<string, Set<string>>();
	for (const alias of aliases) {
		if (alias.source_system !== null) continue;
		const targets = globalAliasTargets.get(alias.alias) ?? new Set<string>();
		targets.add(alias.canonical_unit);
		globalAliasTargets.set(alias.alias, targets);
	}
	for (const [aliasStr, targets] of globalAliasTargets) {
		if (targets.size > 1) {
			errors.push(`Ambiguous global alias "${aliasStr}" maps to multiple canonical units: ${[...targets].join(', ')}`);
		}
	}

	return errors;
}
