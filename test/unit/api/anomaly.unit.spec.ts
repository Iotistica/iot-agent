import { stripMetricUuidPrefix } from '../../../src/api/anomaly';

describe('stripMetricUuidPrefix', () => {
	it('strips a single agent-uuid + "_system_" prefix from a self-monitoring metric', () => {
		// Regression: this used to render as the full raw string in the Events/
		// Incidents grids — "2c961ee4-42ca-4c73-a95f-6506a719a12d-system-memory-percent"
		// — pure noise since the Device column already identifies the agent.
		expect(stripMetricUuidPrefix('2c961ee4-42ca-4c73-a95f-6506a719a12d_system_memory_percent'))
			.toBe('memory_percent');
	});

	it('strips a two-uuid endpoint-scoped prefix', () => {
		expect(stripMetricUuidPrefix('2c961ee4-42ca-4c73-a95f-6506a719a12d_11111111-2222-3333-4444-555555555555_cpu_percent'))
			.toBe('cpu_percent');
	});

	it('leaves an ordinary device metric untouched', () => {
		expect(stripMetricUuidPrefix('cc_valve')).toBe('cc_valve');
	});

	it('leaves a device-prefixed (non-uuid) field untouched', () => {
		expect(stripMetricUuidPrefix('ahu_10_cc_valve')).toBe('ahu_10_cc_valve');
	});
});
