import { looksLikeEngineeringUnit } from '../../../../src/plugins/opcua/discovery';

/**
 * Regression coverage for the bug this function fixes: discovery.ts's
 * Description-attribute fallback (used only when a node has no standard
 * EngineeringUnits property) used to accept the Description text verbatim
 * as the unit, with no sanity check. Confirmed live against the OPC-UA
 * simulator (iot-sims/opcua-simulator) — points configured with no unit at
 * all ("Power-Factor", "CH-1-COP", "CH-2-COP", unit: "" in every profile)
 * were showing up with their own name as their "unit", because the
 * underlying OPC-UA server library defaults an unset Description attribute
 * to the node's own display name.
 */
describe('looksLikeEngineeringUnit', () => {
	it('rejects the exact live-observed bug case: description equals the node\'s own name', () => {
		expect(looksLikeEngineeringUnit('Power-Factor', 'Power-Factor')).toBe(false);
		expect(looksLikeEngineeringUnit('CH-1-COP', 'CH-1-COP')).toBe(false);
		expect(looksLikeEngineeringUnit('CH-2-COP', 'CH-2-COP')).toBe(false);
	});

	it('rejects a name match regardless of case or separator differences', () => {
		expect(looksLikeEngineeringUnit('power-factor', 'Power-Factor')).toBe(false);
		expect(looksLikeEngineeringUnit('POWER_FACTOR', 'Power-Factor')).toBe(false);
		expect(looksLikeEngineeringUnit('ch-1-cop', 'CH_1_COP')).toBe(false);
	});

	it('accepts real, short unit-like symbols that are not the node\'s own name', () => {
		expect(looksLikeEngineeringUnit('°C', 'Space-Temp')).toBe(true);
		expect(looksLikeEngineeringUnit('kPa', 'Discharge-Pressure')).toBe(true);
		expect(looksLikeEngineeringUnit('V', 'Voltage-L1')).toBe(true);
		expect(looksLikeEngineeringUnit('A', 'Motor-Current')).toBe(true);
		expect(looksLikeEngineeringUnit('L/min', 'Flow')).toBe(true);
		expect(looksLikeEngineeringUnit('%', 'Humidity')).toBe(true);
	});

	it('rejects description text containing whitespace — real unit symbols never do', () => {
		expect(looksLikeEngineeringUnit('Chiller 1 Status', 'CH-1-Status')).toBe(false);
		expect(looksLikeEngineeringUnit('Not Available', 'Some-Node')).toBe(false);
	});

	it('rejects implausibly long description text', () => {
		expect(looksLikeEngineeringUnit('a'.repeat(13), 'Some-Node')).toBe(false);
		expect(looksLikeEngineeringUnit('a'.repeat(12), 'Some-Node')).toBe(true);
	});

	it('rejects empty or whitespace-only description', () => {
		expect(looksLikeEngineeringUnit('', 'Some-Node')).toBe(false);
		expect(looksLikeEngineeringUnit('   ', 'Some-Node')).toBe(false);
	});
});
