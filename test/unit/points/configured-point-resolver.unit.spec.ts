import { resolveEndpoint, resolveEndpoints, type EndpointInput } from '../../../src/points/configured-point-resolver';
import type { OpcuaAddressInput } from '../../../src/points/canonical-address';

const namespaces: OpcuaAddressInput['namespaceArray'] = {
	verified: true, uris: ['http://opcfoundation.org/UA/', 'urn:test-server'],
};

function mqttEndpoint(overrides: Partial<EndpointInput> = {}): EndpointInput {
	return {
		uuid: 'ep-mqtt-001', name: 'mqtt-source', protocol: 'mqtt',
		connection: { baseTopic: 'factory/line1' },
		data_points: [
			{ name: 'temperature', subTopic: 'temp', fullTopic: 'factory/line1/temp', dataType: 'float32' },
			{ name: 'humidity', subTopic: 'hum', fullTopic: 'factory/line1/hum', dataType: 'float32' },
		],
		...overrides,
	};
}

function modbusEndpoint(overrides: Partial<EndpointInput> = {}): EndpointInput {
	return {
		uuid: 'ep-modbus-001', name: 'modbus-source', protocol: 'modbus',
		connection: { slaveId: 1, host: '192.168.1.10', port: 502, type: 'tcp' },
		data_points: [
			{ name: 'voltage', address: 100, type: 'holding', dataType: 'float32', count: 2 },
			{ name: 'current', address: 102, type: 'holding', dataType: 'float32', count: 2 },
		],
		...overrides,
	};
}

function bacnetEndpoint(overrides: Partial<EndpointInput> = {}): EndpointInput {
	return {
		uuid: 'ep-bacnet-001', name: 'bacnet-source', protocol: 'bacnet',
		connection: { ipAddress: '192.168.1.20', deviceInstance: 42 },
		data_points: [
			{ name: 'space_temp', objectType: 'analog-input', objectInstance: 1, propertyId: 85 },
			{ name: 'setpoint', objectType: 'analog-value', objectInstance: 2 },
		],
		...overrides,
	};
}

function opcuaEndpoint(overrides: Partial<EndpointInput> = {}): EndpointInput {
	return {
		uuid: 'ep-opcua-001', name: 'opcua-source', protocol: 'opcua',
		connection: { endpointUrl: 'opc.tcp://localhost:4840' },
		data_points: [
			{ name: 'temperature', nodeId: 'ns=1;s=Temperature' },
			{ name: 'pressure', nodeId: 'ns=1;s=Pressure' },
		],
		...overrides,
	};
}

describe('configured-point-resolver', () => {
	describe('MQTT', () => {
		it('resolves all configured MQTT points', () => {
			const result = resolveEndpoint(mqttEndpoint());
			expect(result.endpointUuid).toBe('ep-mqtt-001');
			expect(result.protocol).toBe('mqtt');
			expect(result.points).toHaveLength(2);
			expect(result.points[0].result.status).toBe('resolved');
			expect(result.points[1].result.status).toBe('resolved');
		});

		it('produces stable addresses regardless of point name', () => {
			const original = resolveEndpoint(mqttEndpoint());
			const renamed = resolveEndpoint(mqttEndpoint({
				data_points: [
					{ name: 'renamed_temp', subTopic: 'temp', fullTopic: 'factory/line1/temp', dataType: 'float32' },
					{ name: 'renamed_hum', subTopic: 'hum', fullTopic: 'factory/line1/hum', dataType: 'float32' },
				],
			}));
			expect(original.points[0].result).toMatchObject({ status: 'resolved' });
			expect(renamed.points[0].result).toMatchObject({ status: 'resolved' });
			if (original.points[0].result.status === 'resolved' && renamed.points[0].result.status === 'resolved') {
				expect(renamed.points[0].result.addressKey).toBe(original.points[0].result.addressKey);
			}
		});

		it('rejects points without fullTopic', () => {
			const result = resolveEndpoint(mqttEndpoint({
				data_points: [{ name: 'bad', subTopic: 'x' }],
			}));
			expect(result.points[0].result.status).toBe('unresolved');
		});
	});

	describe('Modbus', () => {
		it('resolves all configured Modbus points', () => {
			const result = resolveEndpoint(modbusEndpoint());
			expect(result.points).toHaveLength(2);
			expect(result.points[0].result.status).toBe('resolved');
			expect(result.points[1].result.status).toBe('resolved');
		});

		it('uses slaveId from connection as unitId', () => {
			const result = resolveEndpoint(modbusEndpoint({ connection: { slaveId: 5, host: '10.0.0.1', port: 502, type: 'tcp' } }));
			expect(result.points[0].result.status).toBe('resolved');
			if (result.points[0].result.status === 'resolved') {
				expect(result.points[0].result.provenance).toMatchObject({ unitId: 5 });
			}
		});

		it('detects overlapping register ranges', () => {
			const result = resolveEndpoint(modbusEndpoint({
				data_points: [
					{ name: 'reg_a', address: 100, type: 'holding', dataType: 'float32', count: 2 },
					{ name: 'reg_b', address: 101, type: 'holding', dataType: 'float32', count: 2 },
				],
			}));
			expect(result.points[0].result.status).toBe('unresolved');
			expect(result.points[1].result.status).toBe('unresolved');
			if (result.points[0].result.status === 'unresolved') {
				expect(result.points[0].result.reason).toBe('ambiguous-projection');
			}
		});

		it('produces stable addresses when source is reconfigured', () => {
			const original = resolveEndpoint(modbusEndpoint());
			const reconfigured = resolveEndpoint(modbusEndpoint({
				connection: { slaveId: 1, host: '10.0.0.99', port: 502, type: 'tcp' },
			}));
			if (original.points[0].result.status === 'resolved' && reconfigured.points[0].result.status === 'resolved') {
				expect(reconfigured.points[0].result.addressKey).toBe(original.points[0].result.addressKey);
			}
		});
	});

	describe('BACnet', () => {
		it('resolves all configured BACnet points', () => {
			const result = resolveEndpoint(bacnetEndpoint());
			expect(result.points).toHaveLength(2);
			expect(result.points[0].result.status).toBe('resolved');
			expect(result.points[1].result.status).toBe('resolved');
		});

		it('defaults propertyId to 85 (present-value)', () => {
			const result = resolveEndpoint(bacnetEndpoint());
			if (result.points[1].result.status === 'resolved') {
				expect(result.points[1].result.provenance).toMatchObject({ propertyId: 85 });
			}
		});

		it('detects duplicate objectType+objectInstance within same endpoint', () => {
			const result = resolveEndpoint(bacnetEndpoint({
				data_points: [
					{ name: 'point_a', objectType: 'analog-input', objectInstance: 1 },
					{ name: 'point_b', objectType: 'analog-input', objectInstance: 1 },
				],
			}));
			// Both resolve to the same address key — duplicates are detected at catalog level, not resolver level
			// The resolver computes addresses independently per point
			expect(result.points[0].result.status).toBe('resolved');
			expect(result.points[1].result.status).toBe('resolved');
			if (result.points[0].result.status === 'resolved' && result.points[1].result.status === 'resolved') {
				expect(result.points[0].result.addressKey).toBe(result.points[1].result.addressKey);
			}
		});

		it('uses deviceId from connection when deviceInstance is absent', () => {
			const result = resolveEndpoint(bacnetEndpoint({
				connection: { ipAddress: '10.0.0.1', deviceId: 99 },
			}));
			if (result.points[0].result.status === 'resolved') {
				expect(result.points[0].result.provenance).toMatchObject({ deviceInstance: 99 });
			}
		});
	});

	describe('OPC UA', () => {
		it('defers all points when no namespace array is provided', () => {
			const result = resolveEndpoint(opcuaEndpoint());
			expect(result.points).toHaveLength(2);
			expect(result.points[0].result).toMatchObject({ status: 'unresolved', reason: 'namespace-evidence-required' });
			expect(result.points[1].result).toMatchObject({ status: 'unresolved', reason: 'namespace-evidence-required' });
		});

		it('resolves points when namespace array is provided', () => {
			const result = resolveEndpoint(opcuaEndpoint(), namespaces);
			expect(result.points[0].result.status).toBe('resolved');
			expect(result.points[1].result.status).toBe('resolved');
		});

		it('produces stable addresses after rename', () => {
			const original = resolveEndpoint(opcuaEndpoint(), namespaces);
			const renamed = resolveEndpoint(opcuaEndpoint({
				data_points: [
					{ name: 'renamed_temp', nodeId: 'ns=1;s=Temperature' },
					{ name: 'renamed_pressure', nodeId: 'ns=1;s=Pressure' },
				],
			}), namespaces);
			if (original.points[0].result.status === 'resolved' && renamed.points[0].result.status === 'resolved') {
				expect(renamed.points[0].result.addressKey).toBe(original.points[0].result.addressKey);
			}
		});
	});

	describe('unsupported protocol', () => {
		it('returns unresolved for SNMP/CAN endpoints', () => {
			const result = resolveEndpoint({
				uuid: 'ep-snmp-001', name: 'snmp-source', protocol: 'snmp',
				connection: {}, data_points: [{ name: 'point1' }],
			});
			expect(result.points[0].result).toMatchObject({ status: 'unresolved', reason: 'unsupported-protocol' });
		});
	});

	describe('resolveEndpoints (batch)', () => {
		it('resolves across multiple protocols and reports summary', () => {
			const endpoints = [mqttEndpoint(), modbusEndpoint(), bacnetEndpoint(), opcuaEndpoint()];
			const result = resolveEndpoints(endpoints);
			expect(result.summary.endpoints).toBe(4);
			// MQTT: 2 resolved, Modbus: 2 resolved, BACnet: 2 resolved, OPC UA: 2 deferred
			expect(result.summary.resolved).toBe(6);
			expect(result.summary.deferred).toBe(2);
			expect(result.summary.unresolved).toBe(0);
		});

		it('uses per-endpoint namespace arrays for OPC UA', () => {
			const nsMap = new Map<string, OpcuaAddressInput['namespaceArray']>();
			nsMap.set('ep-opcua-001', namespaces);
			const result = resolveEndpoints([opcuaEndpoint()], nsMap);
			expect(result.summary.resolved).toBe(2);
			expect(result.summary.deferred).toBe(0);
		});

		it('handles empty data_points gracefully', () => {
			const result = resolveEndpoints([mqttEndpoint({ data_points: [] })]);
			expect(result.summary.resolved).toBe(0);
			expect(result.summary.endpoints).toBe(1);
			expect(result.endpoints[0].points).toHaveLength(0);
		});

		it('handles null data_points gracefully', () => {
			const result = resolveEndpoints([mqttEndpoint({ data_points: null })]);
			expect(result.summary.resolved).toBe(0);
			expect(result.endpoints[0].points).toHaveLength(0);
		});
	});
});
