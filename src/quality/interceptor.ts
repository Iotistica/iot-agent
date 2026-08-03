import { RULE_IDS } from './rule-ids.js';
import { deriveOverallStatus } from './status-precedence.js';
import { sourceCheck } from './checks/source-check.js';
import { unitCheck } from './checks/unit-check.js';
import { valueCheck } from './checks/value-check.js';
import type { CheckDefinition } from './checks/types.js';
import { CURRENT_ENGINE_VERSION, CURRENT_RULES_VERSION, type DataQuality, type Logger } from './types.js';

interface ProtocolMessage extends Record<string, unknown> {
	readings?: ProtocolMessage[];
}

const CHECK_DEFINITIONS: CheckDefinition[] = [
	{ dimension: 'source', fn: sourceCheck },
	{ dimension: 'unit', fn: unitCheck },
	{ dimension: 'value', fn: valueCheck },
];

/**
 * Pure evaluation — never touches `reading`, only reads fields off it and
 * returns a new DataQuality object. The caller is the only place that ever
 * assigns `reading.dataQuality`. Per-check try/catch: one failing check
 * produces a visible 'unknown' result for only its own dimension
 * (QUALITY_CHECK_ERROR / DQ-ENGINE-001) — sibling checks are unaffected.
 */
function evaluateReading(reading: Record<string, unknown>): DataQuality {
	const checks: DataQuality['checks'] = {};

	for (const { dimension, fn } of CHECK_DEFINITIONS) {
		try {
			const result = fn(reading);
			if (result) checks[dimension] = result;
		} catch (err) {
			checks[dimension] = {
				status: 'unknown',
				issues: [{
					code: 'QUALITY_CHECK_ERROR', ruleId: RULE_IDS.QUALITY_CHECK_ERROR, dimension, severity: 'error',
					message: err instanceof Error ? err.message : String(err),
				}],
			};
		}
	}

	return {
		checks,
		status: deriveOverallStatus(Object.values(checks)),
		evaluatedAt: new Date().toISOString(),
		rulesVersion: CURRENT_RULES_VERSION,
		engineVersion: CURRENT_ENGINE_VERSION,
	};
}

/**
 * Creates the data-quality stage for PublishManager's liveDataInterceptor
 * hook — registered after the unit-normalization stage via composeInterceptors().
 * Mirrors the exact dual-shape handling AnomalyEnricher.enrich() and the unit
 * interceptor already use. Three fault-isolation layers: per-check (above),
 * per-reading (below — one malformed reading is skipped, no dataQuality
 * attached, reading otherwise untouched and still published), and the
 * existing manager-level try/catch around the whole interceptor chain as the
 * final backstop.
 */
export function createDataQualityInterceptor(opts: { logger?: Logger } = {}) {
	return function dataQualityInterceptor(
		messages: ProtocolMessage[],
		_endpointName: string,
	): ProtocolMessage[] {
		for (const message of messages) {
			try {
				if (Array.isArray(message.readings)) {
					for (const reading of message.readings) {
						try {
							reading.dataQuality = evaluateReading(reading);
						} catch (err) {
							opts.logger?.warn('Quality evaluation failed for a reading, skipping', err);
						}
					}
					continue;
				}
				message.dataQuality = evaluateReading(message);
			} catch (err) {
				opts.logger?.warn('Quality evaluation failed for a message, skipping', err);
			}
		}
		return messages;
	};
}

/**
 * Flattens issue codes across evaluated checks in the canonical
 * source -> unit -> value order, deduplicated while preserving
 * first-occurrence order. Used for the compact tags/ecp/ml payload
 * projection (never ruleId/protocolCode/message — codes only).
 */
export function buildCompactIssueCodes(checks: DataQuality['checks']): string[] | undefined {
	const codes: string[] = [];
	const seen = new Set<string>();
	for (const dimension of ['source', 'unit', 'value'] as const) {
		for (const issue of checks[dimension]?.issues ?? []) {
			if (!seen.has(issue.code)) {
				seen.add(issue.code);
				codes.push(issue.code);
			}
		}
	}
	return codes.length > 0 ? codes : undefined;
}
