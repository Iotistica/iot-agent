import { CommandDeduplicator } from '../../../src/commands/command-deduplicator';
import type { CommandResult } from '../../../src/commands/types';

function makeResult(commandId: string): CommandResult {
	return {
		version: 1,
		commandId,
		type: 'device.write.result',
		status: 'succeeded',
		receivedAt: new Date().toISOString(),
		completedAt: new Date().toISOString(),
	};
}

describe('CommandDeduplicator', () => {
	it('returns undefined for a commandId never seen', () => {
		const dedup = new CommandDeduplicator(60_000);
		expect(dedup.get('unknown')).toBeUndefined();
	});

	it('reports an in-progress entry (no result yet) for a command marked but not completed', () => {
		const dedup = new CommandDeduplicator(60_000);
		dedup.markInProgress('cmd-1');
		const entry = dedup.get('cmd-1');
		expect(entry).toBeDefined();
		expect(entry?.result).toBeUndefined();
	});

	it('returns the stored terminal result for a completed command', () => {
		const dedup = new CommandDeduplicator(60_000);
		dedup.markInProgress('cmd-1');
		dedup.recordResult('cmd-1', makeResult('cmd-1'));

		const entry = dedup.get('cmd-1');
		expect(entry?.result?.commandId).toBe('cmd-1');
		expect(entry?.result?.status).toBe('succeeded');
	});

	it('expires entries after the TTL', () => {
		jest.useFakeTimers();
		try {
			const dedup = new CommandDeduplicator(1000);
			dedup.markInProgress('cmd-1');
			expect(dedup.get('cmd-1')).toBeDefined();

			jest.advanceTimersByTime(1001);
			expect(dedup.get('cmd-1')).toBeUndefined();
		} finally {
			jest.useRealTimers();
		}
	});

	it('evicts the oldest entry once the bounded size is exceeded', () => {
		const dedup = new CommandDeduplicator(60_000, 2);
		dedup.markInProgress('cmd-1');
		dedup.markInProgress('cmd-2');
		dedup.markInProgress('cmd-3'); // should evict cmd-1

		expect(dedup.get('cmd-1')).toBeUndefined();
		expect(dedup.get('cmd-2')).toBeDefined();
		expect(dedup.get('cmd-3')).toBeDefined();
	});
});
