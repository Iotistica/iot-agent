import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DebounceTracker } from '../debounce.js';

describe('DebounceTracker', () => {
	test('fires immediately when requiredHits is 1', () => {
		const tracker = new DebounceTracker();
		assert.equal(tracker.recordAndShouldFire('rule-1', true, 1), true);
	});

	test('does not fire until requiredHits consecutive true ticks have accumulated', () => {
		const tracker = new DebounceTracker();
		assert.equal(tracker.recordAndShouldFire('rule-1', true, 3), false);
		assert.equal(tracker.recordAndShouldFire('rule-1', true, 3), false);
		assert.equal(tracker.recordAndShouldFire('rule-1', true, 3), true);
	});

	test('a false tick resets the streak', () => {
		const tracker = new DebounceTracker();
		assert.equal(tracker.recordAndShouldFire('rule-1', true, 3), false);
		assert.equal(tracker.recordAndShouldFire('rule-1', true, 3), false);
		assert.equal(tracker.recordAndShouldFire('rule-1', false, 3), false);
		assert.equal(tracker.recordAndShouldFire('rule-1', true, 3), false); // back to 1, not 3
		assert.equal(tracker.recordAndShouldFire('rule-1', true, 3), false);
		assert.equal(tracker.recordAndShouldFire('rule-1', true, 3), true);
	});

	test('tracks independent keys separately', () => {
		const tracker = new DebounceTracker();
		assert.equal(tracker.recordAndShouldFire('rule-a', true, 2), false);
		assert.equal(tracker.recordAndShouldFire('rule-b', true, 2), false);
		assert.equal(tracker.recordAndShouldFire('rule-a', true, 2), true);
		assert.equal(tracker.recordAndShouldFire('rule-b', true, 2), true);
	});

	test('clear() resets a key\'s streak', () => {
		const tracker = new DebounceTracker();
		tracker.recordAndShouldFire('rule-1', true, 3);
		tracker.recordAndShouldFire('rule-1', true, 3);
		tracker.clear('rule-1');
		assert.equal(tracker.recordAndShouldFire('rule-1', true, 3), false); // back to 1, not 3
	});
});
