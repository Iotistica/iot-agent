/**
 * Intelligent payload chunking calculator
 *
 * Determines optimal readings per chunk based on:
 * - Maximum payload size (bytes)
 * - Compression method (json | msgpack | msgpack+deflate)
 * - Average reading size
 *
 * This enables the agent to adapt chunk size to any destination's
 * payload limit without hardcoding values.
 */

export class PayloadChunkCalculator {
	/**
   * Calculate optimal readings per chunk
   *
   * @param maxPayloadBytes Maximum allowed payload size in bytes
   * @param compressionMethod Compression method: 'json' | 'msgpack' | 'msgpack+deflate'
   * @param avgReadingSizeBytes Average size of one reading after serialization (default 150)
   * @returns Optimal number of readings per chunk (minimum 1)
   */
	calculateOptimalChunkSize(
		maxPayloadBytes: number,
		compressionMethod: string = 'json',
		avgReadingSizeBytes: number = 150,
	): number {
		// Validate inputs
		if (maxPayloadBytes <= 0) return 1
		if (avgReadingSizeBytes <= 0) avgReadingSizeBytes = 150

		// Apply 80% safety margin (leave 20% buffer for overhead)
		const safeBytes = maxPayloadBytes * 0.8

		// Estimate compression ratio based on method
		const compressionRatio = this.estimateCompressionRatio(compressionMethod)

		// JSON structure overhead (opening [], closing ], metadata, etc.)
		const overhead = 500 // bytes

		// Calculate max readings that fit
		const bytesPerReading = avgReadingSizeBytes
		const compressedBytesPerReading = bytesPerReading * compressionRatio
		const availableBytes = safeBytes - overhead

		const maxReadings = Math.floor(availableBytes / compressedBytesPerReading)

		// Ensure at least 1 reading per chunk
		return Math.max(1, maxReadings)
	}

	/**
   * Estimate compression ratio for different methods
   *
   * @param method Compression method
   * @returns Ratio of compressed size to original size (0.0 to 1.0)
   */
	private estimateCompressionRatio(method: string): number {
		if (!method) return 1.0

		const normalized = method.toLowerCase().trim()

		switch (normalized) {
			case 'json':
				return 1.0 // No compression
			case 'msgpack':
				return 0.6 // ~40% size reduction typical for msgpack
			case 'msgpack+deflate':
			case 'deflate':
			case 'msgpack-deflate':
				return 0.25 // ~75% size reduction typical for msgpack+deflate
			default:
				return 1.0
		}
	}

	/**
   * Get provider-specific default max payload sizes
   *
   * @param destinationType Destination type (e.g., 'mqtt', 'mqtt-azure', 'influxdb')
   * @returns Default max payload size in bytes
   */
	static getDefaultMaxPayloadSize(destinationType: string): number {
		if (!destinationType) return 1024 * 1024

		const defaults: Record<string, number> = {
			// MQTT brokers with known limits
			'mqtt-azure': 256 * 1024, // Azure IoT Hub MQTT
			'mqtt-aws': 128 * 1024, // AWS IoT Core
			'mqtt-gcp': 128 * 1024, // GCP IoT Core
			'mqtt-hivemq': 10 * 1024 * 1024, // HiveMQ Cloud
			mqtt: 1024 * 1024, // Generic MQTT (1 MB)

			// HTTP APIs
			influxdb: 10 * 1024 * 1024, // InfluxDB HTTP API
			timescaledb: 10 * 1024 * 1024, // TimescaleDB bulk insert
			databricks: 10 * 1024 * 1024, // Databricks ZeroBus API

			// Cloud IoT platforms
			azure: 256 * 1024, // Azure IoT Hub
			aws: 128 * 1024, // AWS IoT Core
			gcp: 128 * 1024, // GCP IoT Core

			// No limit
			noop: Infinity, // Demo/no-op destination
			iotistica: 10 * 1024 * 1024, // Iotistica cloud
		}

		return defaults[destinationType] ?? (1024 * 1024)
	}

	/**
   * Validate a payload size
   *
   * @param bytes Payload size in bytes
   * @returns true if valid (> 1024 bytes and <= 100 MB)
   */
	static isValidPayloadSize(bytes: number): boolean {
		return bytes > 1024 && bytes <= 100 * 1024 * 1024
	}

	/**
   * Format bytes as human-readable string
   *
   * @param bytes Size in bytes
   * @returns Formatted string (e.g., "256 KB", "1.5 MB")
   */
	static formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
	}
}
