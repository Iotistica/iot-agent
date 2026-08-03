export type CheckStatus = 'passed' | 'warning' | 'failed' | 'unknown';
export type QualityStatus = 'good' | 'degraded' | 'bad' | 'unknown';   // no 'uncertain' — no Phase 1 rule produces it
export type QualityDimension = 'source' | 'unit' | 'value';            // extended later: 'identity' | 'semantics' | 'freshness' | ...

export interface QualityIssue {
	/** Stable normalized problem category (SOURCE_BAD, UNIT_UNRESOLVED, ...) — never a raw protocol-specific string. */
	code: string;
	/** The validator that produced this finding (DQ-SOURCE-001, ...) — from rule-ids.ts. */
	ruleId: string;
	dimension: QualityDimension;
	severity: 'info' | 'warning' | 'error';
	/** Human-readable detail — full-payload ('custom' format) only, stripped from compact outbound projections. */
	message?: string;
	/** The original protocol-specific code (Modbus's "ILLEGAL_FUNCTION", etc.), preserved separately from `code`. */
	protocolCode?: string;
}

export interface QualityCheck {
	status: CheckStatus;
	/** 0..1, dimension-specific — only `unit` produces one in Phase 1. Never an overall/rolled-up confidence. */
	confidence?: number;
	issues?: QualityIssue[];
}

export interface DataQuality {
	checks: {
		source?: QualityCheck;
		unit?: QualityCheck;
		value?: QualityCheck;
		// identity?, semantics?, freshness?, ... — later phases add an optional key, nothing existing changes.
	};
	/** Worst-status-wins over whatever's present in `checks`; omitted if checks is empty. */
	status?: QualityStatus;
	evaluatedAt: string;
	/** Identifies the quality POLICY/rule set (confidence table, check logic) that produced this assessment. */
	rulesVersion: string;
	/** Identifies the quality EVALUATION ENGINE implementation itself — a distinct axis from rulesVersion. */
	engineVersion: string;
}

export const CURRENT_RULES_VERSION = 'dq-rules-v1';
export const CURRENT_ENGINE_VERSION = '1.0.0';

/** Minimal logger shape — matches src/normalization/types.ts's Logger, kept local so src/quality/ has no cross-module dependency for it. */
export interface Logger {
	debug(message: string, ...args: any[]): void;
	info(message: string, ...args: any[]): void;
	warn(message: string, ...args: any[]): void;
	error(message: string, ...args: any[]): void;
}
