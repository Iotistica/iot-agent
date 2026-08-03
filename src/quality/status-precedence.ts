import type { QualityCheck, QualityStatus } from './types.js';

/**
 * Shared, single implementation of the status roll-up — not reimplemented
 * per caller. Precedence: any failed -> bad; else any warning -> degraded;
 * else any unknown -> unknown; else all evaluated checks passed -> good;
 * no checks evaluated -> status omitted entirely.
 */
export function deriveOverallStatus(checks: QualityCheck[]): QualityStatus | undefined {
	if (checks.length === 0) return undefined;
	const statuses = new Set(checks.map((c) => c.status));
	if (statuses.has('failed')) return 'bad';
	if (statuses.has('warning')) return 'degraded';
	if (statuses.has('unknown')) return 'unknown';
	return 'good';
}
