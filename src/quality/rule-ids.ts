export const RULE_IDS = {
	SOURCE_BAD: 'DQ-SOURCE-001',
	SOURCE_UNCERTAIN: 'DQ-SOURCE-002',
	UNIT_UNRESOLVED: 'DQ-UNIT-001',
	VALUE_INVALID: 'DQ-VALUE-001',
	VALUE_UNCERTAIN: 'DQ-VALUE-002',
	/** Engine-level: a check itself threw, not a validation finding. */
	QUALITY_CHECK_ERROR: 'DQ-ENGINE-001',
} as const;
