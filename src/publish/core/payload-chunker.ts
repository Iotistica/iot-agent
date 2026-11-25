import { EventEmitter } from 'events';
import type { AgentLogger } from '../../logging/agent-logger.js';
import { LogComponents } from '../../logging/types.js';

/**
 * Configuration for payload chunking strategy.
 */
export interface ChunkingConfig {
	/** Maximum readings per chunk (subscription/destination limit) */
	maxReadingsPerChunk: number;
	/** Estimated average reading size in bytes for initial calculation */
	estimatedAvgReadingBytes?: number;
	/** Maximum final packet size in bytes AFTER serialization and compression */
	maxPacketSizeBytes?: number;
	/** Provider name for logging context (e.g., 'MQTT', 'Azure IoT Hub') */
	providerName: string;
	/** Destination ID for logging and quarantine tracking */
	destinationId?: number;
}

/**
 * Represents a single chunked reading payload with metadata.
 */
export interface ReadingChunk {
	/** Chunk sequence number (0-indexed) */
	chunkIndex: number;
	/** Total number of chunks this reading was split into */
	totalChunks: number;
	/** The readings in this chunk */
	readings: unknown[];
	/** Estimated byte size of this chunk BEFORE serialization/compression */
	estimatedBytes: number;
}

/**
 * Result of chunking a set of readings.
 */
export interface ChunkingResult {
	/** Successfully chunked readings */
	chunks: ReadingChunk[];
	/** Readings that are individually larger than maxPacketSizeBytes (quarantined) */
	quarantined: Array<{
		reading: unknown;
		estimatedBytes: number;
		reason: 'exceeds-max-packet-size';
	}>;
	/** Readings that couldn't be measured or analyzed */
	failed: Array<{
		reading: unknown;
		error: string;
	}>;
	/** Statistics about the chunking operation */
	stats: {
		totalReadingsInput: number;
		successfullyChunked: number;
		quarantinedCount: number;
		failedCount: number;
		totalChunksCreated: number;
		estimatedTotalBytes: number;
		durationMs: number;
	};
}

/**
 * PayloadChunker: Strategically chunks readings before serialization/compression.
 *
 * This component operates at the reading level (not post-serialization):
 * 1. Accepts raw readings array
 * 2. Estimates byte size per reading (by JSON serialization, not by parsing existing JSON)
 * 3. Groups readings into chunks respecting:
 *    - maxReadingsPerChunk limit
 *    - Estimated maxPacketSizeBytes limit
 * 4. Identifies permanently oversized individual readings (quarantine)
 * 5. Returns ChunkingResult with chunks, quarantined, and failed readings
 *
 * The calling layer then:
 * - Serializes each chunk to JSON independently
 * - Compresses each JSON chunk
 * - Validates actual encoded size
 * - Adapts further if needed (but most chunking is done upfront)
 */
export class PayloadChunker extends EventEmitter {
	private readonly logger?: AgentLogger;
	private readonly config: ChunkingConfig;

	constructor(config: ChunkingConfig, logger?: AgentLogger) {
		super();
		this.config = config;
		this.logger = logger;

		if (config.maxReadingsPerChunk <= 0) {
			throw new Error('maxReadingsPerChunk must be > 0');
		}
	}

	/**
	 * Chunk a set of readings respecting limits.
	 *
	 * @param readings Array of reading objects
	 * @param format Payload format ('ecp', 'ml', 'custom') for size estimation context
	 * @returns ChunkingResult with chunks, quarantined, and stats
	 */
	public chunk(readings: unknown[], format: 'ecp' | 'ml' | 'custom' = 'ecp'): ChunkingResult {
		const startTime = Date.now();
		const result: ChunkingResult = {
			chunks: [],
			quarantined: [],
			failed: [],
			stats: {
				totalReadingsInput: readings.length,
				successfullyChunked: 0,
				quarantinedCount: 0,
				failedCount: 0,
				totalChunksCreated: 0,
				estimatedTotalBytes: 0,
				durationMs: 0,
			},
		};

		if (readings.length === 0) {
			result.stats.durationMs = Date.now() - startTime;
			return result;
		}

		// Estimate size for each reading
		const readingEstimates: Array<{ reading: unknown; bytes: number; error?: string }> = [];
		for (const reading of readings) {
			const estimate = this.estimateReadingSize(reading);
			if (estimate.error) {
				result.failed.push({ reading, error: estimate.error });
				result.stats.failedCount++;
			} else {
				readingEstimates.push({ reading, bytes: estimate.bytes! });
			}
		}

		// Identify permanently oversized readings
		const maxPacketBytes = this.config.maxPacketSizeBytes || 1024 * 1024; // 1 MB default
		const safetyMargin = 0.9; // Allow 90% of max (10% headroom for overhead)
		const maxSafeBytes = maxPacketBytes * safetyMargin;

		for (const estimate of readingEstimates) {
			if (estimate.bytes > maxSafeBytes) {
				result.quarantined.push({
					reading: estimate.reading,
					estimatedBytes: estimate.bytes,
					reason: 'exceeds-max-packet-size',
				});
				result.stats.quarantinedCount++;
			}
		}

		// Chunk the remaining (non-oversized, non-failed) readings
		const validReadings = readingEstimates
			.filter(e => e.bytes <= maxSafeBytes)
			.map(e => ({ reading: e.reading, bytes: e.bytes }));

		result.stats.successfullyChunked = validReadings.length;

		// Use simple greedy chunking: pack readings until we hit limit or byte size
		let currentChunk: Array<{ reading: unknown; bytes: number }> = [];
		let currentChunkBytes = 0;
		const maxBytesPerChunk = Math.floor(maxSafeBytes / 2); // Conservative: allow 2 chunks per max packet
		let chunkIndex = 0;

		for (const estimate of validReadings) {
			// Check if adding this reading would exceed limits
			const wouldExceedReadingCount = currentChunk.length >= this.config.maxReadingsPerChunk;
			const wouldExceedBytes = (currentChunkBytes + estimate.bytes) > maxBytesPerChunk;

			if (wouldExceedReadingCount || (wouldExceedBytes && currentChunk.length > 0)) {
				// Flush current chunk
				const chunk: ReadingChunk = {
					chunkIndex,
					totalChunks: 0, // Will be set after all chunks are created
					readings: currentChunk.map(e => e.reading),
					estimatedBytes: currentChunkBytes,
				};
				result.chunks.push(chunk);
				result.stats.estimatedTotalBytes += currentChunkBytes;

				currentChunk = [];
				currentChunkBytes = 0;
				chunkIndex++;
			}

			// Add reading to current chunk
			currentChunk.push(estimate);
			currentChunkBytes += estimate.bytes;
		}

		// Flush remaining chunk
		if (currentChunk.length > 0) {
			const chunk: ReadingChunk = {
				chunkIndex,
				totalChunks: 0,
				readings: currentChunk.map(e => e.reading),
				estimatedBytes: currentChunkBytes,
			};
			result.chunks.push(chunk);
			result.stats.estimatedTotalBytes += currentChunkBytes;
		}

		// Update totalChunks for all chunks
		const totalChunks = result.chunks.length;
		for (const chunk of result.chunks) {
			chunk.totalChunks = totalChunks;
		}

		result.stats.totalChunksCreated = result.chunks.length;
		result.stats.durationMs = Date.now() - startTime;

		// Log chunking result
		this.logger?.debugSync('Payload chunking completed', {
			component: LogComponents.agent,
			provider: this.config.providerName,
			destinationId: this.config.destinationId,
			format,
			inputReadings: result.stats.totalReadingsInput,
			outputChunks: result.stats.totalChunksCreated,
			successfullyChunked: result.stats.successfullyChunked,
			quarantined: result.stats.quarantinedCount,
			failed: result.stats.failedCount,
			estimatedTotalBytes: result.stats.estimatedTotalBytes,
			maxReadingsPerChunk: this.config.maxReadingsPerChunk,
			maxPacketSizeBytes: this.config.maxPacketSizeBytes,
			durationMs: result.stats.durationMs,
		});

		if (result.stats.quarantinedCount > 0) {
			this.logger?.warnSync('Payload chunking: oversized readings quarantined', {
				component: LogComponents.agent,
				provider: this.config.providerName,
				destinationId: this.config.destinationId,
				quarantinedCount: result.stats.quarantinedCount,
				recommendation: 'Review oversized readings in quarantine store; may require destination reconfiguration',
			});
		}

		return result;
	}

	/**
	 * Estimate the JSON-serialized byte size of a single reading.
	 * This is used for pre-serialization chunking decisions.
	 *
	 * @param reading The reading object
	 * @returns Estimated bytes and any error
	 */
	private estimateReadingSize(reading: unknown): { bytes?: number; error?: string } {
		if (reading === undefined || reading === null) {
			return { bytes: 4 }; // "null" in JSON
		}

		try {
			const json = JSON.stringify(reading);
			const bytes = Buffer.byteLength(json, 'utf8');
			return { bytes };
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			return { error: `Failed to serialize reading: ${errorMsg}` };
		}
	}

	/**
	 * Calculate optimal initial chunk size based on configuration.
	 * This is a heuristic for performance; actual chunking respects limits.
	 */
	public calculateOptimalInitialChunkSize(): number {
		const avgReadingBytes = this.config.estimatedAvgReadingBytes ?? 150;
		const maxPacketBytes = this.config.maxPacketSizeBytes ?? 1024 * 1024;
		const safetyMargin = 0.9;

		// Allow roughly 2 chunks per max packet
		const bytesPerChunk = (maxPacketBytes * safetyMargin) / 2;
		const optimalByReadingSize = Math.floor(bytesPerChunk / avgReadingBytes);

		// Respect hard reading count limit
		return Math.min(optimalByReadingSize, this.config.maxReadingsPerChunk);
	}
}
