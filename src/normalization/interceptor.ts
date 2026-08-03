import { normalizeUnitName, deriveProvenance } from './normalize-unit-name.js';
import type { Logger, UnitValue } from './types.js';
import { getUnitCatalog } from './catalog.js';

interface ProtocolMessage extends Record<string, unknown> {
	readings?: ProtocolMessage[];
}

/**
 * Creates the unit-normalization stage for PublishManager's liveDataInterceptor
 * hook. Only does name normalization (no conversion — see plan decision #2:
 * live traffic doesn't auto-convert, there's no "preferred unit" config
 * surface yet). Mirrors the exact dual-shape handling AnomalyEnricher.enrich()
 * already uses: a message with `.readings: [...]` (wrapper) vs. a flat
 * single-reading object, mutated in place.
 */
export function createUnitNormalizationInterceptor(opts: { logger?: Logger } = {}) {
	getUnitCatalog().init(opts.logger);

	return function unitNormalizationInterceptor(
		messages: ProtocolMessage[],
		_endpointName: string,
	): ProtocolMessage[] {
		for (const message of messages) {
			if (Array.isArray(message.readings)) {
				for (const reading of message.readings) {
					normalizeReadingInPlace(reading, message.protocol as string | undefined);
				}
				continue;
			}
			normalizeReadingInPlace(message, message.protocol as string | undefined);
		}
		return messages;
	};
}

function normalizeReadingInPlace(reading: ProtocolMessage, protocolHint?: string): void {
	const rawUnit = reading.unit as string | undefined;
	const rawValue = reading.value;
	if (!rawUnit || typeof rawUnit !== 'string' || typeof rawValue !== 'number') return;

	const sourceSystem = (reading.protocol as string | undefined) ?? protocolHint;
	const result = normalizeUnitName(rawUnit, sourceSystem);

	const unitValue: UnitValue = {
		rawValue,
		rawUnit,
		value: rawValue, // name normalization never touches the value
		unit: result.normalized ? result.unit : rawUnit,
		quantity: result.quantity,
		normalized: result.normalized,
		converted: false, // always false today — no live conversion, decision #2
		provenance: deriveProvenance(result),
	};

	reading.unit = unitValue.unit; // deliberate normalization, not a compat shim — see plan decision #8 / consumer audit
	reading.unitValue = unitValue;
}
