import type { QualityCheck } from '../types.js';
import { RULE_IDS } from '../rule-ids.js';
import type { CheckFn } from './types.js';

/**
 * Reads only fields already present on the reading (reading.quality,
 * .qualityCode, .error) — never infers "healthy" merely because a reading
 * exists. Stateless, deterministic, pure per the CheckFn contract.
 */
export const sourceCheck: CheckFn = (reading): QualityCheck | undefined => {
	const quality = reading.quality;
	const qualityCode = reading.qualityCode;
	const error = reading.error;

	if (quality === undefined && qualityCode === undefined && error === undefined) {
		return undefined;
	}

	if (quality === 'GOOD') {
		return { status: 'passed' };
	}

	if (quality === 'UNCERTAIN') {
		return {
			status: 'warning',
			issues: [{ code: 'SOURCE_UNCERTAIN', ruleId: RULE_IDS.SOURCE_UNCERTAIN, dimension: 'source', severity: 'warning' }],
		};
	}

	if (quality === 'BAD') {
		return {
			status: 'failed',
			issues: [{
				code: 'SOURCE_BAD', ruleId: RULE_IDS.SOURCE_BAD, dimension: 'source', severity: 'error',
				protocolCode: typeof qualityCode === 'string' ? qualityCode : undefined,
				message: typeof error === 'string' ? error : undefined,
			}],
		};
	}

	// quality present but not one of GOOD/UNCERTAIN/BAD (unexpected shape) — nothing confident to say.
	return undefined;
};
