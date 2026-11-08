import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { collapseRedundantSuffix, resolveDeviceId } from '../detector.js';

describe('collapseRedundantSuffix', () => {
	test('collapses a self-referential trailing suffix', () => {
		assert.equal(collapseRedundantSuffix('ahu_1_ahu1'), 'ahu_1');
	});

	test('collapses a multi-segment self-referential suffix', () => {
		assert.equal(collapseRedundantSuffix('vav_f9_c_vavf9c'), 'vav_f9_c');
	});

	test('leaves a genuinely distinguishing suffix untouched', () => {
		assert.equal(collapseRedundantSuffix('ahu_1_a1b2c3d4'), 'ahu_1_a1b2c3d4');
	});

	test('leaves a short single-character trailing segment untouched (e.g. a real unit label)', () => {
		assert.equal(collapseRedundantSuffix('conference_room_a'), 'conference_room_a');
	});

	test('leaves a short numeric trailing segment untouched even if it coincidentally substring-matches', () => {
		// "data1".includes("a") would be true if the length guard didn't exist -- must not collapse.
		assert.equal(collapseRedundantSuffix('data_1_a'), 'data_1_a');
	});

	test('is a no-op for a name with no underscore segments', () => {
		assert.equal(collapseRedundantSuffix('ahu1'), 'ahu1');
	});

	test('is a no-op for an already-clean two-segment name', () => {
		assert.equal(collapseRedundantSuffix('ahu_1'), 'ahu_1');
	});
});

describe('resolveDeviceId', () => {
	test('resolves a clean device name to its normalized form', () => {
		assert.equal(resolveDeviceId({ deviceName: 'AHU-1' }), 'ahu_1');
	});

	test('resolves a hyphen-suffixed self-referential device name to the same bucket as the clean name', () => {
		// This is the exact bug from issue #14: an inconsistently-suffixed
		// deviceName ("AHU-1-ahu1") must land in the SAME device bucket as the
		// clean one ("AHU-1"), not spawn a second permanent baseline entry.
		assert.equal(resolveDeviceId({ deviceName: 'AHU-1-ahu1' }), resolveDeviceId({ deviceName: 'AHU-1' }));
		assert.equal(resolveDeviceId({ deviceName: 'AHU-1-ahu1' }), 'ahu_1');
	});

	test('falls through the field preference order and still collapses the result', () => {
		assert.equal(resolveDeviceId({ device_name: 'Fcu-11a-fcu11a' }), 'fcu_11a');
	});

	test('returns undefined for a record with no device identity fields', () => {
		assert.equal(resolveDeviceId({ temperature: 72 }), undefined);
	});

	test('returns undefined for a blank device name', () => {
		assert.equal(resolveDeviceId({ deviceName: '   ' }), undefined);
	});
});
