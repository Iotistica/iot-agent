import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isWithinSchedule } from '../schedule.js';

describe('isWithinSchedule', () => {
	const weekdaySchedule = { start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5] }; // Mon-Fri

	test('within hours on a scheduled day', () => {
		const monday = new Date(2024, 0, 1, 12, 0, 0).getTime(); // Monday noon
		assert.equal(isWithinSchedule(weekdaySchedule, monday), true);
	});

	test('outside hours on a scheduled day', () => {
		const mondayNight = new Date(2024, 0, 1, 22, 0, 0).getTime();
		assert.equal(isWithinSchedule(weekdaySchedule, mondayNight), false);
	});

	test('not a scheduled day at all', () => {
		const saturday = new Date(2024, 0, 6, 12, 0, 0).getTime(); // Saturday noon
		assert.equal(isWithinSchedule(weekdaySchedule, saturday), false);
	});

	test('tolerance extends both boundaries', () => {
		const justBeforeOpen = new Date(2024, 0, 1, 7, 50, 0).getTime(); // 08:00 - 10min
		assert.equal(isWithinSchedule(weekdaySchedule, justBeforeOpen, 0), false);
		assert.equal(isWithinSchedule(weekdaySchedule, justBeforeOpen, 15), true);
	});

	test('overnight schedule wraps past midnight', () => {
		const overnight = { start: '22:00', end: '06:00', days: [1] }; // Monday 22:00-06:00
		const lateMonday = new Date(2024, 0, 1, 23, 0, 0).getTime();
		const earlyMonday = new Date(2024, 0, 1, 2, 0, 0).getTime();
		const middayMonday = new Date(2024, 0, 1, 12, 0, 0).getTime();

		assert.equal(isWithinSchedule(overnight, lateMonday), true);
		assert.equal(isWithinSchedule(overnight, earlyMonday), true);
		assert.equal(isWithinSchedule(overnight, middayMonday), false);
	});
});
