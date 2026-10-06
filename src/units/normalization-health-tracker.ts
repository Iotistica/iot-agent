import { normalizeSourceSystem } from './source-system.js';

/**
 * V1, deliberately simple: pure in-memory, process-lifetime-only counters for
 * "normalization gave up on this" events (an unresolved unit name, or a
 * failed unit conversion) — the one thing neither src/units/catalog.ts's
 * logUnknownUnit() nor MQTT's conversion-failure catch block track today
 * (both only ever emit a logger.warn()). Powers the admin Dashboard's
 * "Normalization Health" section.
 *
 * No persistence, no flush timer, no restart restoration — counts reset on
 * every process restart, which is an accepted tradeoff for this version (a
 * cheap diagnostic widget, not an analytics subsystem). If durable history
 * turns out to matter, that's a deliberate, separate follow-up.
 *
 * recordUnknownUnit()/recordConversionFailure() are called directly from the
 * live reading/telemetry hot path — both must stay synchronous, allocation-
 * light, and never throw (callers additionally wrap these in their own
 * try/catch, but this module holds up its own end too).
 */

export interface TrackedIssue {
	label: string;
	protocol: string | null;
	count: number;
	firstSeen: string;
	lastSeen: string;
}

export interface NormalizationIssueSummary {
	count: number;
	items: TrackedIssue[];
}

export interface NormalizationHealthSummary {
	unknownUnits: NormalizationIssueSummary;
	conversionFailures: NormalizationIssueSummary;
}

// Distinct (label, protocol) combinations tracked per kind. Bounds memory on
// a long-running agent against a hot stream of ever-varying unit strings —
// frequency matters more than insertion order for "most common", so on
// overflow the single lowest-count entry is evicted, not the oldest.
const MAX_TRACKED_PER_KIND = 500;

function keyFor(label: string, protocol: string | null): string {
	return `${protocol ?? ''}\0${label}`;
}

class NormalizationHealthTracker {
	private unknownUnits = new Map<string, TrackedIssue>();
	private conversionFailures = new Map<string, TrackedIssue>();

	private bump(map: Map<string, TrackedIssue>, label: string, protocol: string | null): void {
		const key = keyFor(label, protocol);
		const now = new Date().toISOString();

		const existing = map.get(key);
		if (existing) {
			existing.count++;
			existing.lastSeen = now;
			return;
		}

		if (map.size >= MAX_TRACKED_PER_KIND) {
			let minKey: string | undefined;
			let minCount = Infinity;
			for (const [k, v] of map) {
				if (v.count < minCount) {
					minCount = v.count;
					minKey = k;
				}
			}
			if (minKey !== undefined) map.delete(minKey);
		}

		map.set(key, { label, protocol, count: 1, firstSeen: now, lastSeen: now });
	}

	recordUnknownUnit(rawUnit: string, sourceSystem?: string | null): void {
		this.bump(this.unknownUnits, rawUnit, normalizeSourceSystem(sourceSystem));
	}

	recordConversionFailure(fromUnit: string, toUnit: string, protocol?: string | null): void {
		this.bump(this.conversionFailures, `${fromUnit} → ${toUnit}`, normalizeSourceSystem(protocol));
	}

	/** Removes the matching unknown-unit entry (the dashboard "Resolve unit" action) — a safe no-op if it was never tracked. */
	clearUnknownUnit(rawUnit: string, sourceSystem?: string | null): void {
		this.unknownUnits.delete(keyFor(rawUnit, normalizeSourceSystem(sourceSystem)));
	}

	getSummary(): NormalizationHealthSummary {
		const toSummary = (map: Map<string, TrackedIssue>): NormalizationIssueSummary => ({
			count: map.size,
			items: [...map.values()].sort((a, b) => b.count - a.count),
		});

		return {
			unknownUnits: toSummary(this.unknownUnits),
			conversionFailures: toSummary(this.conversionFailures),
		};
	}
}

let singleton: NormalizationHealthTracker | undefined;

export function getNormalizationHealthTracker(): NormalizationHealthTracker {
	if (!singleton) singleton = new NormalizationHealthTracker();
	return singleton;
}

/** Test-only: force a fresh tracker instance so tests don't leak state into each other. */
export function resetNormalizationHealthTrackerForTests(): void {
	singleton = undefined;
}
