import { normalizePointName, stripDeviceNamePrefix } from '../../../src/point-name/normalize-point-name';

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

describe('stripDeviceNamePrefix', () => {
	it('strips a dot-separated device-name prefix (BACnet convention, e.g. bacnet-simulator\'s "{device}.{point}")', () => {
		expect(stripDeviceNamePrefix('AHU-1.RF-Run', 'AHU-1')).toBe('rf_run');
	});

	it('strips a hyphen/underscore/space-separated prefix too', () => {
		expect(stripDeviceNamePrefix('AHU-1-RF-Run', 'AHU-1')).toBe('rf_run');
		expect(stripDeviceNamePrefix('AHU-1_RF-Run', 'AHU-1')).toBe('rf_run');
		expect(stripDeviceNamePrefix('AHU-1 RF-Run', 'AHU-1')).toBe('rf_run');
	});

	it('is case-insensitive', () => {
		expect(stripDeviceNamePrefix('ahu-1.rf-run', 'AHU-1')).toBe('rf_run');
	});

	it('handles rawName already sanitized to lowercase/underscore by the adapter before this ever runs (BACnet\'s real shape, not raw mixed-case/dotted text)', () => {
		// object.name (what actually reaches normalizePointName's input) is
		// pre-sanitized by discovery.ts to lowercase+underscore — deviceName may
		// still be mixed-case/hyphenated. Both must canonicalize to the same
		// tokens for the match to succeed.
		expect(stripDeviceNamePrefix('ahu_1_rf_run', 'AHU-1')).toBe('rf_run');
	});

	it('matches only the leading tokens actually shared, ignoring a trailing UUID suffix on deviceName (the enriched device identity, not the bare config name)', () => {
		// AdapterManager.enrichWithEndpointUuid() appends a UUID-derived suffix to
		// deviceName before it ever reaches this pipeline (e.g. "vav_f7_a" becomes
		// "vav_f7_a_2041-d0f6e547") — the point's own raw name never had that
		// suffix, so matching must stop at the first diverging token, not require
		// the whole (longer, suffixed) deviceName to match.
		expect(stripDeviceNamePrefix('vav_f7_a_zone_temp', 'vav_f7_a_2041-d0f6e547')).toBe('zone_temp');
		expect(stripDeviceNamePrefix('vav_f7_a_damper_pos', 'vav_f7_a_2041-d0f6e547')).toBe('damper_pos');
	});

	it('is a no-op when rawName shares no leading token with deviceName (e.g. OPC-UA node names)', () => {
		expect(stripDeviceNamePrefix('cc-valve', 'AHU-1')).toBe('cc-valve');
	});

	it('is a no-op when deviceName is undefined', () => {
		expect(stripDeviceNamePrefix('AHU-1.RF-Run', undefined)).toBe('AHU-1.RF-Run');
	});

	it('strips only the genuinely shared leading token(s) — "AHU-10" and "AHU-1" share the "ahu" token, so that alone is stripped, not treated as a full mismatch', () => {
		expect(stripDeviceNamePrefix('AHU-10-RF-Run', 'AHU-1')).toBe('10_rf_run');
	});

	it('is a no-op when rawName equals deviceName exactly (nothing left to strip)', () => {
		expect(stripDeviceNamePrefix('AHU-1', 'AHU-1')).toBe('AHU-1');
	});
});
