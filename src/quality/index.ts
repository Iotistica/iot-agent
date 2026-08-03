export { createDataQualityInterceptor, buildCompactIssueCodes } from './interceptor.js';
export { assessUnitConfidence } from './confidence-policy.js';
export { deriveOverallStatus } from './status-precedence.js';
export { RULE_IDS } from './rule-ids.js';
export { sourceCheck } from './checks/source-check.js';
export { unitCheck } from './checks/unit-check.js';
export { valueCheck } from './checks/value-check.js';
export type { CheckFn, CheckDefinition } from './checks/types.js';
export type {
	CheckStatus,
	QualityStatus,
	QualityDimension,
	QualityIssue,
	QualityCheck,
	DataQuality,
	Logger,
} from './types.js';
export { CURRENT_RULES_VERSION, CURRENT_ENGINE_VERSION } from './types.js';
