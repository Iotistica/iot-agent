import type { AgentLogger } from '../../logging/agent-logger.js';
import { LogComponents } from '../../logging/types.js';

/**
 * Represents a quarantined reading that exceeds packet size limits.
 */
export interface QuarantinedReading {
	/** Unique identifier for this quarantine record */
	id: string;
	/** The original reading that couldn't be published */
	reading: unknown;
	/** Estimated size in bytes that exceeded limit */
	estimatedBytes: number;
	/** Configured maximum in bytes */
	maxPacketSizeBytes: number;
	/** How much it exceeded the limit */
	exceedsBy: number;
	/** Destination that rejected it */
	destinationId?: number;
	/** Format it was being published as */
	format: string;
	/** When it was quarantined */
	quarantinedAt: Date;
	/** Manual notes or resolution attempt */
	notes?: string;
	/** How many times we've attempted to retry */
	retryCount: number;
	/** Last error when attempting to publish */
	lastError?: string;
}

/**
 * QuarantineStore: Persistent storage for readings that are permanently oversized.
 *
 * Purpose:
 * - Prevent data loss by preserving oversized readings instead of silently dropping them
 * - Track metrics on quarantine size and growth
 * - Allow manual recovery or reconfiguration
 * - Prevent infinite retry loops
 * - Provide observability into readings that don't fit
 *
 * Implementation: In-memory with optional async persistence layer.
 * Full persistence layer (SQLite/PostgreSQL) can be added separately.
 */
export class QuarantineStore {
	private readonly store = new Map<string, QuarantinedReading>();
	private readonly logger?: AgentLogger;
	private readonly maxStorageCount: number;
	private sequenceNumber = 0;

	constructor(maxStorageCount: number = 10000, logger?: AgentLogger) {
		this.maxStorageCount = maxStorageCount;
		this.logger = logger;
	}

	/**
	 * Add a reading to quarantine.
	 *
	 * @param reading The original reading object
	 * @param estimatedBytes Size that exceeded limit
	 * @param maxPacketSizeBytes Configured maximum
	 * @param destinationId Destination that rejected it
	 * @param format Payload format (ecp, ml, custom)
	 * @returns The quarantine ID for tracking
	 */
	public add(
		reading: unknown,
		estimatedBytes: number,
		maxPacketSizeBytes: number,
		destinationId: number | undefined,
		format: string,
	): string {
		// Check if storage is full
		if (this.store.size >= this.maxStorageCount) {
			this.logger?.warnSync('Quarantine store at capacity, oldest records will be removed', {
				component: LogComponents.agent,
				currentSize: this.store.size,
				maxCapacity: this.maxStorageCount,
			});
			// Remove oldest entries (simple FIFO)
			const entriesToRemove = Array.from(this.store.entries())
				.sort((a, b) => a[1].quarantinedAt.getTime() - b[1].quarantinedAt.getTime())
				.slice(0, Math.ceil(this.maxStorageCount * 0.1)); // Remove 10%

			for (const [id] of entriesToRemove) {
				this.store.delete(id);
			}
		}

		const id = this.generateQuarantineId();
		const record: QuarantinedReading = {
			id,
			reading,
			estimatedBytes,
			maxPacketSizeBytes,
			exceedsBy: estimatedBytes - maxPacketSizeBytes,
			destinationId,
			format,
			quarantinedAt: new Date(),
			retryCount: 0,
		};

		this.store.set(id, record);

		return id;
	}

	/**
	 * Get a quarantined reading by ID.
	 */
	public get(id: string): QuarantinedReading | undefined {
		return this.store.get(id);
	}

	/**
	 * List all quarantined readings (optionally filtered by destination).
	 */
	public list(destinationId?: number): QuarantinedReading[] {
		const all = Array.from(this.store.values());
		if (destinationId === undefined) {
			return all;
		}
		return all.filter(r => r.destinationId === destinationId);
	}

	/**
	 * Update a quarantine record (e.g., after retry attempt).
	 */
	public update(id: string, updates: Partial<QuarantinedReading>): void {
		const existing = this.store.get(id);
		if (existing) {
			this.store.set(id, { ...existing, ...updates });
		}
	}

	/**
	 * Remove a reading from quarantine (e.g., after manual fix or reconfiguration).
	 */
	public remove(id: string): QuarantinedReading | undefined {
		const record = this.store.get(id);
		if (record) {
			this.store.delete(id);
			this.logger?.debugSync('Reading removed from quarantine', {
				component: LogComponents.agent,
				quarantineId: id,
				destinationId: record.destinationId,
				wasQuarantinedFor: Math.round((Date.now() - record.quarantinedAt.getTime()) / 1000) + 's',
			});
		}
		return record;
	}

	/**
	 * Remove all quarantine records for a destination (e.g., when destination is deleted).
	 */
	public removeByDestination(destinationId: number): number {
		const records = this.list(destinationId);
		for (const record of records) {
			this.store.delete(record.id);
		}
		this.logger?.debugSync('Quarantine records removed for destination', {
			component: LogComponents.agent,
			destinationId,
			recordsRemoved: records.length,
		});
		return records.length;
	}

	/**
	 * Get statistics about quarantine store.
	 */
	public getStats(): {
		totalRecords: number;
		capacityUsed: number;
		capacityUsagePercent: number;
		recordsByDestination: Map<number | undefined, number>;
		oldestRecord?: Date;
		newestRecord?: Date;
		} {
		const recordsByDestination = new Map<number | undefined, number>();
		let oldestRecord: Date | undefined;
		let newestRecord: Date | undefined;

		for (const record of this.store.values()) {
			const count = recordsByDestination.get(record.destinationId) ?? 0;
			recordsByDestination.set(record.destinationId, count + 1);

			if (!oldestRecord || record.quarantinedAt < oldestRecord) {
				oldestRecord = record.quarantinedAt;
			}
			if (!newestRecord || record.quarantinedAt > newestRecord) {
				newestRecord = record.quarantinedAt;
			}
		}

		return {
			totalRecords: this.store.size,
			capacityUsed: this.store.size,
			capacityUsagePercent: (this.store.size / this.maxStorageCount) * 100,
			recordsByDestination,
			oldestRecord,
			newestRecord,
		};
	}

	/**
	 * Clear all quarantine records.
	 */
	public clear(): void {
		const count = this.store.size;
		this.store.clear();
		this.logger?.debugSync('Quarantine store cleared', {
			component: LogComponents.agent,
			recordsCleared: count,
		});
	}

	/**
	 * Generate a unique ID for a quarantine record.
	 */
	private generateQuarantineId(): string {
		return `q-${Date.now()}-${++this.sequenceNumber}`;
	}

	/**
	 * Check if a reading's retry count exceeds threshold.
	 * Prevents infinite retry loops.
	 */
	public hasExceededRetryThreshold(id: string, maxRetries: number = 3): boolean {
		const record = this.store.get(id);
		return record ? record.retryCount >= maxRetries : false;
	}
}
