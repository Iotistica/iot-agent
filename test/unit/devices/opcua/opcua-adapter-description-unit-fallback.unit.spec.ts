import { resolveUnitFromDescription } from '../../../../src/plugins/opcua/adapter';

/**
 * Regression coverage for adapter.ts's own Description-attribute fallback
 * (validateNodeIds(), used for the live polling/subscription path — separate
 * from discovery.ts's own fallback, covered by
 * opcua-engineering-unit-fallback.unit.spec.ts). Before this fix,
 * adapter.ts extracted a unit from Description text via a bare "in {unit}"
 * regex with no plausibility check at all, so it never reused
 * looksLikeEngineeringUnit() the way discovery.ts already did.
 *
 * Confirmed live against the OPC-UA simulator: points configured with no
 * unit at all ("Power-Factor", "CH-1-COP", "CH-2-COP", "Active-Alarms",
 * "write-test" — all `"unit": ""` in their profile/dynamic config) had their
 * Description attribute default to the node's own display name (a quirk of
 * the underlying OPC-UA server library, not something the simulator sets
 * explicitly — see iot-sims/opcua-simulator/lib/nodes.py's create_tag(),
 * which only writes Description/EngineeringUnits when a unit IS configured).
 * A pre-fix discovery run captured that defaulted text and persisted it as
 * the node's "unit"; this fallback must never (re-)produce the same result.
 */
describe('resolveUnitFromDescription', () => {
	it('rejects the exact live-observed bug case: description equals the node\'s own name, including hyphenated/compound names', () => {
		expect(resolveUnitFromDescription('Power-Factor', 'Power-Factor')).toBeUndefined();
		expect(resolveUnitFromDescription('CH-1-COP', 'CH-1-COP')).toBeUndefined();
		expect(resolveUnitFromDescription('CH-2-COP', 'CH-2-COP')).toBeUndefined();
		expect(resolveUnitFromDescription('Active-Alarms', 'Active-Alarms')).toBeUndefined();
		expect(resolveUnitFromDescription('write-test', 'write-test')).toBeUndefined();
	});

	it('rejects a self-referential description even when the node name itself contains " in " — the composite "in X" extraction must not rescue a fragment of the node\'s own name', () => {
		// "Flow in Pipe" has no built-in meaning — it stands in for any node
		// whose display name happens to contain " in " as a substring (e.g.
		// "Built-in Sensor", "Plug-in Status"). The naive old regex
		// (`/\bin\s+([^\s,]+...)/i`) would have extracted "Pipe" here, and
		// "Pipe" alone doesn't equal the full node name, so a check applied
		// only to the extracted fragment can't catch this — the self-
		// reference must be checked against the whole description first.
		expect(resolveUnitFromDescription('Flow in Pipe', 'Flow in Pipe')).toBeUndefined();
		expect(resolveUnitFromDescription('Built-in Sensor', 'Built-in Sensor')).toBeUndefined();
	});

	it('is case/separator-insensitive on the self-reference check, same as looksLikeEngineeringUnit', () => {
		expect(resolveUnitFromDescription('power-factor', 'Power-Factor')).toBeUndefined();
		expect(resolveUnitFromDescription('POWER_FACTOR', 'Power-Factor')).toBeUndefined();
	});

	it('accepts a bare, plausible unit string that is not the node\'s own name', () => {
		expect(resolveUnitFromDescription('kPa', 'Discharge-Pressure')).toBe('kPa');
		expect(resolveUnitFromDescription('°C', 'Space-Temp')).toBe('°C');
		expect(resolveUnitFromDescription('V', 'Voltage-L1')).toBe('V');
	});

	it('extracts a unit from a legitimate composite "X in {unit}" description', () => {
		expect(resolveUnitFromDescription('Temperature in °C', 'Space-Temp')).toBe('°C');
		expect(resolveUnitFromDescription('Flow in L/min', 'Supply-Flow')).toBe('L/min');
		expect(resolveUnitFromDescription('Vibration in mm/s', 'Motor-Vibration')).toBe('mm/s');
	});

	it('rejects an implausible extracted fragment (too long / still not unit-shaped) even when the "in X" pattern matches', () => {
		expect(resolveUnitFromDescription('Running in degraded-mode-indefinitely', 'Some-Node')).toBeUndefined();
	});

	it('returns undefined for empty or whitespace-only description, and when no "in X" pattern is present', () => {
		expect(resolveUnitFromDescription('', 'Some-Node')).toBeUndefined();
		expect(resolveUnitFromDescription('   ', 'Some-Node')).toBeUndefined();
		expect(resolveUnitFromDescription('Chiller 1 Status', 'CH-1-Status')).toBeUndefined();
	});
});
