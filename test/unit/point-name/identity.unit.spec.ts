jest.mock('../../../src/db/sqlite', () => ({
	getDatabase: jest.fn(() => {
		throw new Error('identity generation must never touch the database');
	}),
	transact: jest.fn(),
}));

import { getDatabase } from '../../../src/db/sqlite';
import { computeProvisionalPointId, computeShortHash, naturalKey } from '../../../src/point-name/identity';

describe('computeProvisionalPointId', () => {
	it('is deterministic for an identical natural key', () => {
		const a = computeProvisionalPointId('bacnet', 'endpoint-1', 'device-1', 'sat');
		const b = computeProvisionalPointId('bacnet', 'endpoint-1', 'device-1', 'sat');
		expect(a).toBe(b);
	});

	it('produces a UUID-shaped string', () => {
		const id = computeProvisionalPointId('bacnet', 'endpoint-1', 'device-1', 'sat');
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it('changing rawName alone changes provisionalPointId — documents the Option B rename-sensitivity limitation', () => {
		const before = computeProvisionalPointId('bacnet', 'endpoint-1', 'device-1', 'SAT');
		const after = computeProvisionalPointId('bacnet', 'endpoint-1', 'device-1', 'Supply-Air-Temp');
		expect(after).not.toBe(before);
	});

	it('changing sourceSystem alone changes provisionalPointId', () => {
		const bacnet = computeProvisionalPointId('bacnet', 'endpoint-1', 'device-1', 'sat');
		const modbus = computeProvisionalPointId('modbus', 'endpoint-1', 'device-1', 'sat');
		expect(bacnet).not.toBe(modbus);
	});

	it('changing endpointName or deviceKey alone changes provisionalPointId', () => {
		const base = computeProvisionalPointId('bacnet', 'endpoint-1', 'device-1', 'sat');
		expect(computeProvisionalPointId('bacnet', 'endpoint-2', 'device-1', 'sat')).not.toBe(base);
		expect(computeProvisionalPointId('bacnet', 'endpoint-1', 'device-2', 'sat')).not.toBe(base);
	});

	it('treats undefined and null sourceSystem identically', () => {
		expect(computeProvisionalPointId(undefined, 'endpoint-1', 'device-1', 'sat'))
			.toBe(computeProvisionalPointId(null, 'endpoint-1', 'device-1', 'sat'));
	});

	it('generation makes zero DB calls (spy-verified)', () => {
		computeProvisionalPointId('bacnet', 'endpoint-1', 'device-1', 'sat');
		computeShortHash('bacnet', 'endpoint-1', 'device-1', 'sat');
		naturalKey('bacnet', 'endpoint-1', 'device-1', 'sat');
		expect(getDatabase).not.toHaveBeenCalled();
	});
});

describe('computeShortHash', () => {
	it('is deterministic and 6 hex characters long', () => {
		const a = computeShortHash('bacnet', 'endpoint-1', 'device-1', 'sat');
		const b = computeShortHash('bacnet', 'endpoint-1', 'device-1', 'sat');
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{6}$/);
	});

	it('differs for different raw names on the same natural-key scope', () => {
		const a = computeShortHash('bacnet', 'endpoint-1', 'device-1', 'AHU-1 SAT');
		const b = computeShortHash('bacnet', 'endpoint-1', 'device-1', 'AHU 1 SAT');
		expect(a).not.toBe(b);
	});
});

describe('naturalKey', () => {
	it('coalesces undefined and null sourceSystem to the same key', () => {
		expect(naturalKey(undefined, 'e', 'd', 'r')).toBe(naturalKey(null, 'e', 'd', 'r'));
	});
});
