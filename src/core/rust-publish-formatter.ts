import * as path from 'path';
import * as zlib from 'zlib';

export interface SerializeResult {
  jsonString: string;
  jsonBytes: number;
  compressed?: Buffer;
  compressedBytes: number;
  compressionRatio: number;
  serializeMs: number;
  compressMs: number;
  totalMs: number;
}

export interface BatchConfig {
  payloadFormat: string;
  maxReadingsPerChunk: number;
  maxPacketSizeBytes?: number;
  filterBadQuality: boolean;
  compress: boolean;
  compressionLevel?: number;
  externalNodeName: string;
  externalGroupName: string;
  timestampMs: number;
  timestampIso?: string;
  protocol?: string;
  msgId?: string;
  mlSchema?: string;
  context?: Record<string, unknown>;
  dataset?: DatasetConfig;
}

export interface DatasetConfig {
  id: string;
  name: string;
  windowSecs?: number;
  missingValues?: string;
  normalization?: string;
  excludeBadQuality?: boolean;
  removeOutliers?: boolean;
  outlierMethod?: string;
  outputFormat?: string;
}

export interface ProcessedChunk {
  chunkIndex: number;
  totalChunks: number;
  readingsInChunk: number;
  jsonString?: string;
  compressed?: Buffer;
  jsonBytes: number;
  compressedBytes: number;
  compressionRatio: number;
}

export interface BatchTiming {
  flattenMs: number;
  chunkMs: number;
  enrichMs: number;
  serializeMs: number;
  compressMs: number;
  totalMs: number;
}

export interface BatchResult {
  chunks: ProcessedChunk[];
  quarantinedCount: number;
  failedCount: number;
  totalReadingsInput: number;
  successfullyChunked: number;
  timing: BatchTiming;
}

interface NativePublishFormatter {
  PublishFormatter: {
    serializePayload(
      payload: unknown,
      compress: boolean,
      compressionLevel: number,
    ): Promise<SerializeResult>;
    processBatch(
      messages: unknown,
      config: BatchConfig,
    ): Promise<BatchResult>;
    processBatchFromJson(
      jsonBuf: Buffer,
      config: BatchConfig,
    ): Promise<BatchResult>;
  };
}

let nativeBinding: NativePublishFormatter | null = null;

function loadNativeBinding(): NativePublishFormatter | null {
	if (nativeBinding) return nativeBinding;

	const candidates = [
		path.join(__dirname, '..', '..', 'modules', 'publish', 'publish.node'),
	];

	for (const candidate of candidates) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			nativeBinding = require(candidate) as NativePublishFormatter;
			console.info('[PublishFormatter] Loaded native Rust module');
			return nativeBinding;
		} catch {
			continue;
		}
	}

	console.info('[PublishFormatter] Native module not available, using Node.js fallback');
	return null;
}

export class PublishFormatter {
	private static nativeBinding = loadNativeBinding();

	static async processBatch(
		messages: unknown[],
		config: BatchConfig,
	): Promise<BatchResult | null> {
		if (this.nativeBinding?.PublishFormatter?.processBatch) {
			return this.nativeBinding.PublishFormatter.processBatch(messages, config);
		}
		return null;
	}

	static async processBatchFromJson(
		jsonBuf: Buffer,
		config: BatchConfig,
	): Promise<BatchResult | null> {
		if (this.nativeBinding?.PublishFormatter?.processBatchFromJson) {
			return this.nativeBinding.PublishFormatter.processBatchFromJson(jsonBuf, config);
		}
		return null;
	}

	static async serializePayload(
		payload: Record<string, unknown>,
		compress = false,
		compressionLevel = 3,
	): Promise<SerializeResult> {
		if (this.nativeBinding?.PublishFormatter?.serializePayload) {
			return this.nativeBinding.PublishFormatter.serializePayload(payload, compress, compressionLevel);
		}

		const start = performance.now();
		const jsonString = JSON.stringify(payload);
		const jsonBytes = Buffer.byteLength(jsonString, 'utf8');
		const serializeMs = performance.now() - start;

		let compressed: Buffer | undefined;
		let compressedBytes = jsonBytes;
		let compressionRatio = 1.0;
		let compressMs = 0;

		if (compress) {
			const compressStart = performance.now();
			try {
				compressed = zlib.deflateSync(Buffer.from(jsonString, 'utf8'), { level: compressionLevel });
				compressedBytes = compressed.length;
				compressionRatio = jsonBytes > 0 ? compressedBytes / jsonBytes : 1.0;
			} catch {
				// fallback: no compression
			}
			compressMs = performance.now() - compressStart;
		}

		return {
			jsonString,
			jsonBytes,
			compressed,
			compressedBytes,
			compressionRatio,
			serializeMs,
			compressMs,
			totalMs: performance.now() - start,
		};
	}
}

export default PublishFormatter;
