import { PayloadChunker, type ReadingChunk, type ChunkingResult } from '../../../src/publish/core/payload-chunker';
import { QuarantineStore } from '../../../src/publish/core/quarantine-store';

describe('PayloadChunker', () => {
	let chunker: PayloadChunker;

	beforeEach(() => {
		chunker = new PayloadChunker({
			maxReadingsPerChunk: 100,
			estimatedAvgReadingBytes: 150,
			maxPacketSizeBytes: 1024 * 1024, // 1 MB
			providerName: 'MQTT',
			destinationId: 1,
		});
	});

	describe('small reading count with reasonable size', () => {
		it('should not chunk readings when count is below limit', () => {
			const readings = Array.from({ length: 50 }, (_, i) => ({
				id: i,
				value: `reading-${i}`,
				timestamp: Date.now(),
			}));

			const result = chunker.chunk(readings, 'ecp');

			expect(result.chunks).toHaveLength(1);
			expect(result.chunks[0]?.readings).toHaveLength(50);
			expect(result.quarantined).toHaveLength(0);
			expect(result.failed).toHaveLength(0);
			expect(result.stats.successfullyChunked).toBe(50);
		});

		it('should respect maxReadingsPerChunk limit', () => {
			const readings = Array.from({ length: 250 }, (_, i) => ({
				id: i,
				value: `reading-${i}`,
			}));

			const result = chunker.chunk(readings, 'ecp');

			expect(result.chunks.length).toBeGreaterThan(1);
			for (const chunk of result.chunks) {
				expect(chunk.readings.length).toBeLessThanOrEqual(100);
				expect(chunk.totalChunks).toBe(result.chunks.length);
			}
			expect(result.stats.totalChunksCreated).toBe(3);
		});
	});

	describe('large reading payloads', () => {
		it('should chunk JSON payload smaller than limit', () => {
			// Create readings with ~10KB each
			const readings = Array.from({ length: 150 }, (_, i) => ({
				id: i,
				data: 'x'.repeat(10000),
				nested: { complex: { structure: { value: i } } },
			}));

			const result = chunker.chunk(readings, 'ecp');

			expect(result.chunks.length).toBeGreaterThan(1);
			expect(result.quarantined).toHaveLength(0);
			expect(result.stats.estimatedTotalBytes).toBeGreaterThan(0);
		});

		it('should quarantine permanently oversized individual readings', () => {
			// 1 MB individual reading exceeds 1 MB max packet size
			const hugePayload = 'x'.repeat(1024 * 1024 + 1);
			const readings = [
				{ id: 1, data: 'small' },
				{ id: 2, data: hugePayload },
				{ id: 3, data: 'small' },
			];

			const result = chunker.chunk(readings, 'ecp');

			expect(result.quarantined).toHaveLength(1);
			expect(result.quarantined[0]?.reading).toEqual({ id: 2, data: hugePayload });
			expect(result.chunks[0]?.readings).toHaveLength(2);
			expect(result.stats.quarantinedCount).toBe(1);
			expect(result.stats.successfullyChunked).toBe(2);
		});

		it('should not silently drop oversized readings', () => {
			const oversized = { id: 1, data: 'x'.repeat(2 * 1024 * 1024) };
			const readings = [oversized];

			const result = chunker.chunk(readings, 'ecp');

			// Should be in quarantine, not silently dropped
			expect(result.quarantined).toHaveLength(1);
			expect(result.quarantined[0]?.reading).toEqual(oversized);
			expect(result.chunks).toHaveLength(0);
		});
	});

	describe('MessagePack format support', () => {
		it('should handle ml format', () => {
			const readings = Array.from({ length: 50 }, (_, i) => ({
				value: Math.random() * 100,
				timestamp: Date.now(),
			}));

			const result = chunker.chunk(readings, 'ml');

			expect(result.chunks).toHaveLength(1);
			expect(result.stats.successfullyChunked).toBe(50);
		});

		it('should handle custom format', () => {
			const readings = Array.from({ length: 100 }, (_, i) => ({
				custom: `field-${i}`,
				value: i,
			}));

			const result = chunker.chunk(readings, 'custom');

			expect(result.chunks[0]?.readings).toHaveLength(100);
		});
	});

	describe('error handling', () => {
		it('should handle null/undefined readings', () => {
			const readings = [
				{ id: 1, value: 'valid' },
				null,
				undefined,
				{ id: 2, value: 'also valid' },
			];

			const result = chunker.chunk(readings as unknown[], 'ecp');

			expect(result.stats.failedCount).toBe(0); // null/undefined are valid JSON
			expect(result.chunks[0]?.readings).toHaveLength(4);
		});

		it('should handle non-serializable objects gracefully', () => {
			const circularRef: any = { id: 1 };
			circularRef.self = circularRef;

			const readings = [
				{ id: 1, value: 'valid' },
				circularRef,
				{ id: 2, value: 'also valid' },
			];

			const result = chunker.chunk(readings, 'ecp');

			expect(result.stats.failedCount).toBe(1);
			expect(result.failed).toHaveLength(1);
			expect(result.stats.successfullyChunked).toBe(2);
		});
	});

	describe('chunk metadata', () => {
		it('should set chunkIndex and totalChunks correctly', () => {
			const readings = Array.from({ length: 250 }, (_, i) => ({ id: i }));

			const result = chunker.chunk(readings, 'ecp');

			expect(result.chunks).toHaveLength(3);
			for (let i = 0; i < result.chunks.length; i++) {
				expect(result.chunks[i]?.chunkIndex).toBe(i);
				expect(result.chunks[i]?.totalChunks).toBe(3);
			}
		});

		it('should calculate estimatedBytes per chunk', () => {
			const readings = Array.from({ length: 50 }, (_, i) => ({ id: i, data: 'x'.repeat(100) }));

			const result = chunker.chunk(readings, 'ecp');

			for (const chunk of result.chunks) {
				expect(chunk.estimatedBytes).toBeGreaterThan(0);
			}
		});
	});

	describe('configuration edge cases', () => {
		it('should reject invalid configuration', () => {
			expect(() => {
				new PayloadChunker({
					maxReadingsPerChunk: 0,
					providerName: 'MQTT',
				});
			}).toThrow('maxReadingsPerChunk must be > 0');
		});

		it('should use default maxPacketSizeBytes if not specified', () => {
			const noMaxChunker = new PayloadChunker({
				maxReadingsPerChunk: 100,
				providerName: 'MQTT',
			});

			const reading = { id: 1, data: 'x'.repeat(100) };
			const result = noMaxChunker.chunk([reading], 'ecp');

			expect(result.chunks).toHaveLength(1); // Should not quarantine small reading
		});

		it('should calculate optimal chunk size heuristically', () => {
			const optimalSize = chunker.calculateOptimalInitialChunkSize();

			expect(optimalSize).toBeGreaterThan(0);
			expect(optimalSize).toBeLessThanOrEqual(100); // maxReadingsPerChunk
		});
	});

	describe('empty input', () => {
		it('should handle empty readings array', () => {
			const result = chunker.chunk([], 'ecp');

			expect(result.chunks).toHaveLength(0);
			expect(result.quarantined).toHaveLength(0);
			expect(result.failed).toHaveLength(0);
			expect(result.stats.totalReadingsInput).toBe(0);
		});
	});
});

describe('QuarantineStore', () => {
	let store: QuarantineStore;

	beforeEach(() => {
		store = new QuarantineStore(100);
	});

	afterEach(() => {
		store.clear();
	});

	describe('add and get', () => {
		it('should add reading to quarantine', () => {
			const reading = { id: 1, data: 'oversized' };
			const id = store.add(reading, 2048576, 1048576, 1, 'ecp');

			expect(id).toBeTruthy();
			const retrieved = store.get(id);
			expect(retrieved?.reading).toEqual(reading);
			expect(retrieved?.estimatedBytes).toBe(2048576);
			expect(retrieved?.maxPacketSizeBytes).toBe(1048576);
			expect(retrieved?.exceedsBy).toBe(1000000);
		});

		it('should track quarantine metadata', () => {
			const reading = { id: 1 };
			const id = store.add(reading, 2000000, 1000000, 2, 'ml');

			const record = store.get(id);
			expect(record?.id).toBe(id);
			expect(record?.destinationId).toBe(2);
			expect(record?.format).toBe('ml');
			expect(record?.quarantinedAt).toBeInstanceOf(Date);
			expect(record?.retryCount).toBe(0);
		});
	});

	describe('list', () => {
		it('should list all quarantined readings', () => {
			store.add({ id: 1 }, 2000000, 1000000, 1, 'ecp');
			store.add({ id: 2 }, 2000000, 1000000, 1, 'ecp');
			store.add({ id: 3 }, 2000000, 1000000, 2, 'ecp');

			const all = store.list();
			expect(all).toHaveLength(3);
		});

		it('should filter by destination', () => {
			store.add({ id: 1 }, 2000000, 1000000, 1, 'ecp');
			store.add({ id: 2 }, 2000000, 1000000, 1, 'ecp');
			store.add({ id: 3 }, 2000000, 1000000, 2, 'ecp');

			const dest1 = store.list(1);
			expect(dest1).toHaveLength(2);
			expect(dest1.every(r => r.destinationId === 1)).toBe(true);

			const dest2 = store.list(2);
			expect(dest2).toHaveLength(1);
			expect(dest2[0]?.destinationId).toBe(2);
		});
	});

	describe('update', () => {
		it('should update quarantine record', () => {
			const id = store.add({ id: 1 }, 2000000, 1000000, 1, 'ecp');

			store.update(id, { retryCount: 2, lastError: 'Network timeout' });

			const record = store.get(id);
			expect(record?.retryCount).toBe(2);
			expect(record?.lastError).toBe('Network timeout');
		});
	});

	describe('remove', () => {
		it('should remove reading from quarantine', () => {
			const id = store.add({ id: 1 }, 2000000, 1000000, 1, 'ecp');
			expect(store.list()).toHaveLength(1);

			const removed = store.remove(id);
			expect(removed?.id).toBe(id);
			expect(store.list()).toHaveLength(0);
		});

		it('should return undefined for non-existent ID', () => {
			const result = store.remove('nonexistent');
			expect(result).toBeUndefined();
		});

		it('should remove by destination', () => {
			store.add({ id: 1 }, 2000000, 1000000, 1, 'ecp');
			store.add({ id: 2 }, 2000000, 1000000, 1, 'ecp');
			store.add({ id: 3 }, 2000000, 1000000, 2, 'ecp');

			const count = store.removeByDestination(1);
			expect(count).toBe(2);
			expect(store.list(1)).toHaveLength(0);
			expect(store.list(2)).toHaveLength(1);
		});
	});

	describe('capacity management', () => {
		it('should enforce max storage count', () => {
			const smallStore = new QuarantineStore(5);

			for (let i = 0; i < 10; i++) {
				smallStore.add({ id: i }, 2000000, 1000000, 1, 'ecp');
			}

			// Should have removed oldest entries to stay at or under capacity
			expect(smallStore.list().length).toBeLessThanOrEqual(5);
		});

		it('should remove oldest records when full', () => {
			const smallStore = new QuarantineStore(3);

			const id1 = smallStore.add({ id: 1 }, 2000000, 1000000, 1, 'ecp');
			const id2 = smallStore.add({ id: 2 }, 2000000, 1000000, 1, 'ecp');
			const id3 = smallStore.add({ id: 3 }, 2000000, 1000000, 1, 'ecp');
			const id4 = smallStore.add({ id: 4 }, 2000000, 1000000, 1, 'ecp');

			const records = smallStore.list();
			expect(records.length).toBeLessThanOrEqual(3);

			// Newest should be present
			expect(records.some(r => r.id === id4)).toBe(true);
		});
	});

	describe('statistics', () => {
		it('should report stats', () => {
			store.add({ id: 1 }, 2000000, 1000000, 1, 'ecp');
			store.add({ id: 2 }, 2000000, 1000000, 1, 'ecp');
			store.add({ id: 3 }, 2000000, 1000000, 2, 'ecp');

			const stats = store.getStats();
			expect(stats.totalRecords).toBe(3);
			expect(stats.capacityUsed).toBe(3);
			expect(stats.capacityUsagePercent).toBe(3); // 3/100
			expect(stats.recordsByDestination.get(1)).toBe(2);
			expect(stats.recordsByDestination.get(2)).toBe(1);
			expect(stats.oldestRecord).toBeInstanceOf(Date);
			expect(stats.newestRecord).toBeInstanceOf(Date);
		});
	});

	describe('retry threshold', () => {
		it('should detect exceeded retry threshold', () => {
			const id = store.add({ id: 1 }, 2000000, 1000000, 1, 'ecp');

			expect(store.hasExceededRetryThreshold(id, 3)).toBe(false);

			store.update(id, { retryCount: 2 });
			expect(store.hasExceededRetryThreshold(id, 3)).toBe(false);

			store.update(id, { retryCount: 3 });
			expect(store.hasExceededRetryThreshold(id, 3)).toBe(true);
		});

		it('should return false for non-existent ID', () => {
			const result = store.hasExceededRetryThreshold('nonexistent', 3);
			expect(result).toBe(false);
		});
	});

	describe('clear', () => {
		it('should clear all records', () => {
			store.add({ id: 1 }, 2000000, 1000000, 1, 'ecp');
			store.add({ id: 2 }, 2000000, 1000000, 1, 'ecp');

			expect(store.list()).toHaveLength(2);
			store.clear();
			expect(store.list()).toHaveLength(0);
		});
	});
});
