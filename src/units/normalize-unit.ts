import { normalizeUnitName, deriveProvenance } from './normalize-unit-name.js';
import { convertUnit } from './convert-unit.js';
import type { NormalizeUnitOptions, NormalizeUnitResult, UnitValue } from './types.js';

/**
 * Composes normalizeUnitName() + convertUnit() into the originally-specified
 * API shape. Most call sites only need normalizeUnitName() directly (name
 * resolution never touches the value) — this wrapper exists for callers that
 * also want conversion in one call.
 */
export function normalizeUnit(value: number, rawUnit: string, options: NormalizeUnitOptions = {}): NormalizeUnitResult {
	const nameResult = normalizeUnitName(rawUnit, options.sourceSystem, options.quiet);

	const unitValue: UnitValue = {
		rawValue: value,
		rawUnit,
		value,
		unit: nameResult.unit,
		quantity: nameResult.quantity,
		normalized: nameResult.normalized,
		converted: false,
		provenance: deriveProvenance(nameResult),
	};

	if (!nameResult.normalized) {
		return { unitValue, warning: nameResult.warning };
	}

	if (options.alreadyConverted) {
		return { unitValue, matchedAlias: nameResult.matchedAlias, conversionStage: 'source-adapter' };
	}

	if (!options.targetUnit || options.targetUnit === nameResult.unit) {
		return { unitValue, matchedAlias: nameResult.matchedAlias };
	}

	const conversion = convertUnit(value, nameResult.unit, options.targetUnit);
	if (!conversion.converted) {
		return { unitValue, matchedAlias: nameResult.matchedAlias, warning: conversion.warning };
	}

	return {
		unitValue: {
			...unitValue,
			value: conversion.value,
			unit: options.targetUnit,
			converted: true,
		},
		matchedAlias: nameResult.matchedAlias,
		conversionRule: conversion.conversionRule,
	};
}
