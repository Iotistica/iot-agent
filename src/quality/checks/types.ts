import type { QualityCheck, QualityDimension } from '../types.js';

/**
 * Purity contract: reading in -> QualityCheck | undefined out. A check
 * function must not mutate the reading, must not mutate any shared state,
 * must not log/touch a DB/network, and must not depend on other readings or
 * on execution order among checks. `undefined` means "not evaluable for this
 * reading" — the caller omits the dimension entirely, no placeholder object.
 */
export type CheckFn = (reading: Record<string, unknown>) => QualityCheck | undefined;

export interface CheckDefinition {
	dimension: QualityDimension;
	fn: CheckFn;
}
