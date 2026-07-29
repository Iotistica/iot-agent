import type { CommandResult } from './types.js';

interface DedupEntry {
	/** undefined while the write is still in flight; set once a terminal result exists. */
	result?: CommandResult;
	expiresAt: number;
}

/**
 * Process-local command-ID dedup store. Bounded and TTL'd so MQTT QoS 1
 * redelivery (or a retried producer) never causes a second write for the
 * same commandId. Persistent storage can replace this later without
 * changing the CommandService's usage of it.
 */
export class CommandDeduplicator {
	private entries = new Map<string, DedupEntry>();

	constructor(
		private readonly ttlMs: number,
		private readonly maxSize: number = 10_000,
	) {}

	/** Returns the stored entry (in-progress or completed) if this commandId has been seen and hasn't expired. */
	get(commandId: string): DedupEntry | undefined {
		this.sweep();
		const entry = this.entries.get(commandId);
		if (entry && entry.expiresAt < Date.now()) {
			this.entries.delete(commandId);
			return undefined;
		}
		return entry;
	}

	/** Marks a commandId as in-progress before the write begins, so concurrent duplicates are caught immediately. */
	markInProgress(commandId: string): void {
		this.sweep();
		if (this.entries.size >= this.maxSize && !this.entries.has(commandId)) {
			// Bounded: evict the oldest entry rather than growing unbounded.
			const oldestKey = this.entries.keys().next().value;
			if (oldestKey !== undefined) this.entries.delete(oldestKey);
		}
		this.entries.set(commandId, { expiresAt: Date.now() + this.ttlMs });
	}

	/** Records the terminal result once the write (or rejection) completes. */
	recordResult(commandId: string, result: CommandResult): void {
		this.entries.set(commandId, { result, expiresAt: Date.now() + this.ttlMs });
	}

	private sweep(): void {
		const now = Date.now();
		for (const [id, entry] of this.entries) {
			if (entry.expiresAt < now) {
				this.entries.delete(id);
			}
		}
	}
}
