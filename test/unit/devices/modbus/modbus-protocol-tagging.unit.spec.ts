/**
 * Regression coverage: ModbusClient's bad-quality data point constructors
 * (createBadDataPoint(), createBadQualityDataPoints()) used to omit the
 * `protocol` field entirely. Fixed by adding `protocol: 'modbus'` to both
 * (client.ts:~918-927, ~1030-1039).
 */

jest.mock('uuid', () => ({ v4: jest.fn(() => 'test-uuid-12345') }));

import { ModbusClient } from '../../../../src/plugins/modbus/client';
import { ModbusConnectionType } from '../../../../src/plugins/modbus/types';

function makeDevice() {
	return {
		name: 'test_device',
		enabled: true,
		slaveId: 1,
		pollInterval: 1000,
		registers: [
			{ name: 'reg1', address: 0, dataType: 'uint16', functionCode: 3, unit: 'degC' },
			{ name: 'reg2', address: 1, dataType: 'uint16', functionCode: 3, unit: 'degC' },
		],
		connection: {
			type: ModbusConnectionType.TCP,
			host: 'localhost',
			port: 502,
			baudRate: 9600,
			dataBits: 8,
			stopBits: 1,
			parity: 'none' as const,
			timeout: 5000,
			retryAttempts: 3,
			retryDelay: 1000,
		},
	} as any;
}

function silentLogger() {
	return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describe('ModbusClient bad-quality data points — protocol tagging', () => {
	it('createBadDataPoint() tags protocol: "modbus"', () => {
		const client = new ModbusClient(makeDevice(), silentLogger() as any) as any;
		const register = { name: 'reg1', unit: 'degC' };

		const point = client.createBadDataPoint(register, new Date().toISOString(), new Error('read failed'));

		expect(point.quality).toBe('BAD');
		expect(point.protocol).toBe('modbus');
	});

	it('createBadQualityDataPoints() tags protocol: "modbus" on every register', () => {
		const client = new ModbusClient(makeDevice(), silentLogger() as any) as any;

		const points = client.createBadQualityDataPoints('DEVICE_OFFLINE');

		expect(points).toHaveLength(2);
		for (const point of points) {
			expect(point.quality).toBe('BAD');
			expect(point.protocol).toBe('modbus');
		}
	});
});
