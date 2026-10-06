import { normalizePointName, buildNormalizedPointName } from '../../../src/point-name/normalize-point-name';

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

	it('does not perform any semantic/abbreviation expansion — ambiguous abbreviations stay exactly as syntactically normalized', () => {
		// Design principle: normalize representation, not meaning. This agent
		// is general IoT/industrial infrastructure, not HVAC-specific — "PV"
		// must never become "process_value", "SAT" must never become
		// "supply_air_temp", etc. No scoped or fuzzy resolution exists
		// anywhere in this pipeline (confirmed 2026-10-03).
		const ambiguousAbbreviations = ['PV', 'SP', 'DP', 'SV', 'AI', 'AO', 'DI', 'DO', 'SAT', 'SA', 'RA', 'OA', 'CHW Valve', 'OA Damper'];
		for (const input of ambiguousAbbreviations) {
			const expected = input.toLowerCase().replace(/[\s\-./:()&+]/g, '_');
			expect(normalizePointName(input)).toBe(expected);
		}
	});

	it('is idempotent — normalizing an already-normalized string returns it unchanged', () => {
		const inputs = ['AHU-Test Filter DP Alarm', 'VAV-101 Zone Temp', 'Motor Speed', 'Line 1 Pressure', 'Pump 01 Status'];
		for (const input of inputs) {
			const once = normalizePointName(input);
			expect(normalizePointName(once)).toBe(once);
		}
	});
});

describe('domain-neutral formatting convergence', () => {
	// This agent is general IoT/industrial infrastructure (BACnet/MQTT/
	// OPC-UA/Modbus across HVAC, process, utility, and other domains), not
	// HVAC-specific — these cases deliberately avoid any domain vocabulary.
	const cases: Array<{ variants: string[]; expected: string }> = [
		{ variants: ['Motor Speed', 'motor-speed', 'MOTOR_SPEED', 'motor_speed'], expected: 'motor_speed' },
		{ variants: ['Line 1 Pressure', 'line-1-pressure', 'LINE_1_PRESSURE'], expected: 'line_1_pressure' },
		{ variants: ['Tank Level', 'tank-level', 'TANK_LEVEL'], expected: 'tank_level' },
		{ variants: ['Pump 01 Status', 'pump-01-status', 'PUMP_01_STATUS'], expected: 'pump_01_status' },
	];

	it.each(cases)('every variant of "$expected" converges to the same normalized name', ({ variants, expected }) => {
		for (const variant of variants) {
			expect(normalizePointName(variant)).toBe(expected);
		}
	});
});

describe('buildNormalizedPointName (device+point composition)', () => {
	it('combines device and point names with a single underscore join', () => {
		expect(buildNormalizedPointName('AHU-Test', 'Zone Temp')).toBe('ahu_test_zone_temp');
	});

	it('omits the device prefix only when it is already a complete, redundant leading token in the point name', () => {
		expect(buildNormalizedPointName('AHU-Test', 'AHU-Test Zone Temp')).toBe('ahu_test_zone_temp');
	});

	it('does not treat a partial/non-token-boundary match as redundant — combines in full', () => {
		expect(buildNormalizedPointName('AHU-Test', 'AHU Zone Temp')).toBe('ahu_test_ahu_zone_temp');
	});

	it('a domain-neutral composition example', () => {
		expect(buildNormalizedPointName('Pump 01', 'Status')).toBe('pump_01_status');
	});

	it('is a no-op combination when no device name is supplied', () => {
		expect(buildNormalizedPointName(undefined, 'Zone Temp')).toBe('zone_temp');
	});

	it('returns an empty string when both device and point normalize to empty', () => {
		expect(buildNormalizedPointName('---', '   ')).toBe('');
	});
});
