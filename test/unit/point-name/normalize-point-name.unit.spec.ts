import { normalizePointName } from '../../../src/point-name/normalize-point-name';

describe('normalizePointName', () => {
	it('produces the two worked examples from the plan exactly', () => {
		expect(normalizePointName('AHU-Test Filter DP Alarm')).toBe('ahu_test_filter_dp_alarm');
		expect(normalizePointName('VAV-101 Zone Temp')).toBe('vav_101_zone_temp');
	});

	it('strips diacritics after unicode normalization', () => {
		expect(normalizePointName('Café Temp')).toBe('cafe_temp');
		expect(normalizePointName('Zöne Sensör')).toBe('zone_sensor');
	});

	it('replaces punctuation variety with underscores', () => {
		expect(normalizePointName('AHU.1/SAT:Alarm')).toBe('ahu_1_sat_alarm');
		expect(normalizePointName('Chiller(1) Status & Command')).toBe('chiller_1_status_command');
		expect(normalizePointName('Zone+Temp')).toBe('zone_temp');
	});

	it('collapses repeated/mixed separators into a single underscore', () => {
		expect(normalizePointName('AHU--1   SAT')).toBe('ahu_1_sat');
		expect(normalizePointName('AHU - - 1')).toBe('ahu_1');
	});

	it('preserves numeric identifiers as their own token', () => {
		expect(normalizePointName('VAV-101')).toBe('vav_101');
		expect(normalizePointName('Room 204B Temp')).toBe('room_204b_temp');
	});

	it('trims leading/trailing separators', () => {
		expect(normalizePointName('-AHU Temp-')).toBe('ahu_temp');
		expect(normalizePointName('  Zone Temp  ')).toBe('zone_temp');
	});

	it('returns an empty string for empty or fully-invalid input', () => {
		expect(normalizePointName('')).toBe('');
		expect(normalizePointName('   ')).toBe('');
		expect(normalizePointName('---')).toBe('');
	});

	it('returns an empty string for non-string input rather than throwing', () => {
		expect(normalizePointName(undefined as unknown as string)).toBe('');
		expect(normalizePointName(null as unknown as string)).toBe('');
	});

	it('truncates over-length input to the 120-char base budget and re-trims a trailing underscore left by truncation', () => {
		const longName = `${'a'.repeat(119)}_b_c`; // truncating at 120 chars lands mid-token, leaving a trailing '_'
		const result = normalizePointName(longName);
		expect(result.length).toBeLessThanOrEqual(120);
		expect(result.endsWith('_')).toBe(false);
	});

	it('is deterministic — identical input always produces identical output', () => {
		const input = 'AHU-Test Filter DP Alarm';
		const first = normalizePointName(input);
		for (let i = 0; i < 5; i++) {
			expect(normalizePointName(input)).toBe(first);
		}
	});

	it('does not perform any token/abbreviation expansion in Phase 1 (step 10 is an unconditional no-op)', () => {
		// Ambiguous/ common HVAC abbreviations pass through unchanged — no scoped
		// or fuzzy resolution, per plan §6.
		expect(normalizePointName('SAT')).toBe('sat');
		expect(normalizePointName('CHW Valve')).toBe('chw_valve');
		expect(normalizePointName('OA Damper')).toBe('oa_damper');
	});
});
