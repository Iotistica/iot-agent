import { prettifyDriftDeviceId, cleanDriftFieldName, cleanProtocolPipeName, stripFieldDevicePrefix } from '../../../../src/db/models/drift-labels';

describe('prettifyDriftDeviceId', () => {
	it('formats a single-instance device id with no uniqueness suffix (OPC-UA, Modbus, lone BACnet device)', () => {
		// Regression: this used to return 'ahu_1' unchanged because the id has
		// no "_{instance}_{8-hex-id}" suffix to strip, so the Schema Drift admin
		// grid showed the raw slug instead of a device name matching the rest
		// of the UI (which resolves the true friendly name, e.g. "AHU-1").
		expect(prettifyDriftDeviceId('ahu_1')).toBe('AHU-1');
	});

	it('strips a genuine "_{instance}_{8-hex-id}" uniqueness suffix before formatting', () => {
		expect(prettifyDriftDeviceId('ahu_10_5017_323765db')).toBe('AHU-10');
	});

	it('uppercases known device-type acronyms and title-cases everything else, joined with hyphens', () => {
		// Matches the real device display names seen in Data View: "FCU-F9-A",
		// "Chiller-Plant-2", "Meter-8", "Boiler-Plant-2" — hyphen-separated.
		expect(prettifyDriftDeviceId('vav_f9_c')).toBe('VAV-F9-C');
		expect(prettifyDriftDeviceId('boiler_plant_1')).toBe('Boiler-Plant-1');
	});
});

describe('other drift-labels helpers (unaffected by the prettify fix)', () => {
	it('cleanDriftFieldName strips the reading:/key: namespace prefix', () => {
		expect(cleanDriftFieldName('reading:hc_valve')).toBe('hc_valve');
		expect(cleanDriftFieldName('key:foo')).toBe('foo');
	});

	it('cleanProtocolPipeName strips the -pipe suffix', () => {
		expect(cleanProtocolPipeName('opcua-pipe')).toBe('opcua');
	});

	it('stripFieldDevicePrefix removes a matching device prefix from a field name', () => {
		expect(stripFieldDevicePrefix('ahu_10_cc_valve', 'ahu_10_5017_323765db')).toBe('cc_valve');
	});
});
