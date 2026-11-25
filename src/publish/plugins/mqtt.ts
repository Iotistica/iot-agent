import type { IClientOptions } from 'mqtt';
import type { AgentLogger } from '../../logging/agent-logger.js';
import { LogComponents } from '../../logging/types.js';
import { BasePublishPlugin } from '../core/base-plugin.js';
import type { IPublishClient as ICorePublishClient, PublishBatchItem, Logger } from '../core/types.js';
import { BaseMqttClient } from '../core/base-client.js';
import { MessageBufferSync } from '../core/buffer.js';
import type { IPublishClient as IBufferPublishClient } from '../core/buffer.js';
import { PayloadChunkCalculator } from '../core/chunk-calculator.js';

interface ExternalMqttConfig {
	provider: 'mqtt';
	host: string;
	port: number;
	protocol: 'mqtt' | 'mqtts' | 'ws' | 'wss';
	path?: string;
	clientId: string;
	username?: string;
	password?: string;
	topicTemplate: string;
	ca?: string;
	cert?: string;
	key?: string;
	rejectUnauthorized?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadExternalMqttConfigFromRecord(
	config: Record<string, unknown> | null | undefined,
	destinationName?: string,
	destinationId?: number,
): ExternalMqttConfig | null {
	if (!isRecord(config)) {
		return null;
	}

	let brokerUrl = typeof config.brokerUrl === 'string'
		? config.brokerUrl
		: typeof config.url === 'string'
			? config.url
			: '';

	// Support { host, port } form from the admin UI
	if (!brokerUrl && typeof config.host === 'string' && config.host) {
		const port = typeof config.port === 'number' ? config.port : 1883;
		brokerUrl = `mqtt://${config.host}:${port}`;
	}

	if (!brokerUrl) {
		return null;
	}

	// Prepend scheme if missing so URL parsing works
	if (!brokerUrl.includes('://')) {
		brokerUrl = `mqtt://${brokerUrl}`;
	}

	let parsedUrl: URL;
	try {
		parsedUrl = new URL(brokerUrl);
	} catch {
		throw new Error('Invalid mqtt publisher config brokerUrl. Expected absolute URL like mqtt://host:1883 or mqtts://host:8883');
	}

	const scheme = parsedUrl.protocol.replace(':', '').toLowerCase();
	if (scheme !== 'mqtt' && scheme !== 'mqtts' && scheme !== 'ws' && scheme !== 'wss') {
		throw new Error('mqtt publisher config brokerUrl must use mqtt, mqtts, ws, or wss scheme');
	}

	const protocol = scheme;
	const defaultPort = protocol === 'mqtts' ? 8883 : protocol === 'mqtt' ? 1883 : protocol === 'wss' ? 443 : 80;
	const rejectUnauthorized = typeof config.rejectUnauthorized === 'boolean' ? config.rejectUnauthorized : undefined;
	const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
	const namePart = destinationName?.trim() ? sanitize(destinationName) : '';
	const idSuffix = destinationId !== undefined ? `-${destinationId}` : '';
	const generatedClientId = `iotistica-${namePart || 'mqtt'}${idSuffix}`;

	return {
		provider: 'mqtt',
		host: parsedUrl.hostname,
		port: parsedUrl.port ? Number(parsedUrl.port) : defaultPort,
		protocol,
		path: typeof config.path === 'string'
			? config.path
			: parsedUrl.pathname && parsedUrl.pathname !== '/' ? parsedUrl.pathname : undefined,
		clientId:
			typeof config.clientId === 'string' && config.clientId.trim().length > 0
				? config.clientId
				: generatedClientId,
		username: typeof config.username === 'string' ? config.username : parsedUrl.username || undefined,
		password: typeof config.password === 'string' ? config.password : parsedUrl.password || undefined,
		topicTemplate:
			typeof config.topicTemplate === 'string' && config.topicTemplate.trim().length > 0
				? config.topicTemplate
				: typeof config.publishTopicTemplate === 'string' && config.publishTopicTemplate.trim().length > 0
					? config.publishTopicTemplate
					: '{topic}',
		ca: typeof config.ca === 'string' ? config.ca : undefined,
		cert: typeof config.cert === 'string' ? config.cert : undefined,
		key: typeof config.key === 'string' ? config.key : undefined,
		rejectUnauthorized,
	};
}

function parseSourceTopic(sourceTopic: string): { endpoint: string; originalTopic: string } {
	return {
		endpoint: sourceTopic.split('/').pop() || 'telemetry',
		originalTopic: sourceTopic,
	};
}

function applyTopicTemplate(
	template: string,
	params: { deviceId: string; endpoint: string; topic: string; assetPath?: string },
): string {
	return template
		.replaceAll('{deviceId}', encodeURIComponent(params.deviceId))
		.replaceAll('{endpoint}', encodeURIComponent(params.endpoint))
		.replaceAll('{topic}', params.topic)
		.replaceAll('{assetPath}', params.assetPath ?? '');
}

export class ExternalMqttClient extends BaseMqttClient {
	constructor(
		private readonly config: ExternalMqttConfig,
		logger?: AgentLogger,
		private readonly destinationName?: string,
	) {
		super(logger);
	}

	protected get providerName(): string {
		return this.destinationName || 'external mqtt';
	}

	protected getLogContext(): Record<string, unknown> {
		return {
			host: this.config.host,
			port: this.config.port,
			protocol: this.config.protocol,
			clientId: this.config.clientId,
		};
	}

	protected buildMqttOptions(): IClientOptions {
		const options: IClientOptions = {
			host: this.config.host,
			port: this.config.port,
			protocol: this.config.protocol,
			clientId: this.config.clientId,
			username: this.config.username,
			password: this.config.password,
			rejectUnauthorized: this.config.rejectUnauthorized ?? true,
			keepalive: 60,
			clean: true,
			reconnectPeriod: 5000,
			connectTimeout: 30000,
		};

		options.path = this.config.path;
		options.ca = this.config.ca?.replace(/\\n/g, '\n');
		options.cert = this.config.cert?.replace(/\\n/g, '\n');
		options.key = this.config.key?.replace(/\\n/g, '\n');

		return options;
	}

	protected buildPublishTopic(sourceTopic: string): string {
		const parsed = parseSourceTopic(sourceTopic);
		return applyTopicTemplate(this.config.topicTemplate || '{topic}', {
			deviceId: this.config.clientId,
			endpoint: parsed.endpoint,
			topic: parsed.originalTopic,
		});
	}
}

/**
 * Thin proxy wrapping ExternalMqttClient for use as the mqttManager inside MessageBufferSync.
 *
 * On flush, MessageBufferSync calls publish(record.topic, payload, {qos}).  Because
 * record.topic is already the fully-resolved destinationTopic, we pass it back as
 * destinationTopic so BaseMqttClient.publish() uses it directly without re-applying the
 * topic template a second time.
 */
class ExternalMqttFlushProxy implements IBufferPublishClient {
	constructor(private readonly target: ExternalMqttClient) {}

	on(event: 'connect', listener: () => void): this {
		this.target.on(event, listener);
		return this;
	}

	off(event: 'connect', listener: () => void): this {
		this.target.off(event, listener);
		return this;
	}

	isConnected(): boolean {
		return this.target.isConnected();
	}

	getPublishMode() {
		return this.target.getPublishMode?.();
	}

	getMessageIdGenerator() {
		return undefined;
	}

	async publish(topic: string, payload: string | Buffer, options?: { qos?: 0 | 1 | 2 }): Promise<void> {
		return this.target.publish(topic, payload, { ...options, destinationTopic: topic });
	}
}

const DEFAULT_MAX_READINGS_PER_MESSAGE = 100;

export class MqttPublishPlugin extends BasePublishPlugin {
	private destBufferSync?: MessageBufferSync;
	private readonly maxReadingsPerMessage: number;
	private readonly chunkCalculator: PayloadChunkCalculator;

	constructor(
		client: ICorePublishClient,
		logger?: Logger,
		private readonly destinationId?: number,
		private readonly agentLogger?: AgentLogger,
		maxReadingsPerMessage?: number,
		private readonly maxPayloadSizeBytes?: number,
		private readonly compressionMethod: string = 'json',
	) {
		super(client, logger);
		this.chunkCalculator = new PayloadChunkCalculator();
		
		// If maxPayloadSize is provided, calculate optimal chunk size
		if (maxReadingsPerMessage !== undefined && maxReadingsPerMessage > 0) {
			this.maxReadingsPerMessage = maxReadingsPerMessage;
		} else if (maxPayloadSizeBytes && maxPayloadSizeBytes > 0) {
			// Use calculator to determine optimal chunk size from max payload size
			this.maxReadingsPerMessage = this.chunkCalculator.calculateOptimalChunkSize(
				maxPayloadSizeBytes,
				this.compressionMethod,
				150, // Default avg reading size
			);
		} else {
			this.maxReadingsPerMessage = DEFAULT_MAX_READINGS_PER_MESSAGE;
		}
	}

	override async start(): Promise<void> {
		if (this.destinationId !== undefined && this.client instanceof ExternalMqttClient) {
			await this.enableDestinationBuffering();
		}
		await super.start();
	}

	override async stop(): Promise<void> {
		this.destBufferSync?.stop();
		this.destBufferSync = undefined;
		await super.stop();
	}

	override async publishBatch(batch: PublishBatchItem[]): Promise<void> {
		// Chunk all payloads first, regardless of connection state
		const chunkedBatch: PublishBatchItem[] = [];
		for (const item of batch) {
			const chunks = this.chunkPayload(item);
			chunkedBatch.push(...chunks);
		}

		if (this.destBufferSync && !this.isConnected()) {
			this.agentLogger?.debugSync('Destination offline, buffering batch', {
				component: LogComponents.agent,
				messages: chunkedBatch.length,
				destinationId: this.destinationId,
			});
			await this.bufferBatch(chunkedBatch);
			return;
		}

		const failedChunks: PublishBatchItem[] = [];
		for (const chunk of chunkedBatch) {
			// Recheck connection before each chunk (can drop between publishes)
			if (!this.isConnected()) {
				this.agentLogger?.debugSync('Destination offline during chunk publish', {
					component: LogComponents.agent,
					destinationId: this.destinationId,
					topic: chunk.topic,
				});
				failedChunks.push(chunk);
				continue;
			}
			try {
				// Log outgoing payload size
				const payloadBytes = Buffer.isBuffer(chunk.payload)
					? chunk.payload.length
					: Buffer.byteLength(chunk.payload, 'utf8');

				this.agentLogger?.debugSync('MQTT outgoing payload', {
					component: LogComponents.agent,
					destinationId: this.destinationId,
					topic: chunk.topic,
					payloadBytes,
					payloadKB: (payloadBytes / 1024).toFixed(2),
					payloadMB: (payloadBytes / 1048576).toFixed(4),
					isBuffer: Buffer.isBuffer(chunk.payload),
					maxReadingsPerMessage: this.maxReadingsPerMessage,
					maxPayloadSizeBytes: this.maxPayloadSizeBytes,
					compressionMethod: this.compressionMethod,
				});

				await this.client!.publish(chunk.topic, chunk.payload, chunk.options);
			} catch (error) {
				// Log the actual error before buffering
				const errorMessage = error instanceof Error ? error.message : String(error);
				const errorStack = error instanceof Error ? error.stack : undefined;

				this.agentLogger?.warnSync('MQTT publish failed for chunk', {
					component: LogComponents.agent,
					destinationId: this.destinationId,
					topic: chunk.topic,
					error: errorMessage,
					stack: errorStack,
					willBuffer: this.destBufferSync,
				});

				// Connection lost or publish failed, buffer this chunk if enabled
				failedChunks.push(chunk);
			}
		}

		// Buffer any failed chunks if offline mode is enabled
		if (failedChunks.length > 0) {
			if (this.destBufferSync) {
				await this.bufferBatch(failedChunks);
			} else {
				// Critical: buffering disabled and chunks failed — data loss situation
				const totalReadings = failedChunks.reduce((sum, c) => {
					const payload = typeof c.payload === 'string' ? c.payload : c.payload.toString();
					try {
						const parsed = JSON.parse(payload);
						const readingsKey = Array.isArray(parsed.tags) ? 'tags'
							: Array.isArray(parsed.features) ? 'features'
								: Array.isArray(parsed.messages) ? 'messages'
									: null;
						return sum + (readingsKey ? (parsed[readingsKey] as unknown[]).length : 0);
					} catch {
						return sum;
					}
				}, 0);

				this.agentLogger?.errorSync(
					'MQTT chunks failed and buffering disabled — data loss risk',
					new Error('Buffering disabled and publish failed'),
					{
						component: LogComponents.agent,
						destinationId: this.destinationId,
						failedChunkCount: failedChunks.length,
						totalReadings,
						recommendation: 'Enable buffering for this destination or verify MQTT broker connectivity',
					},
				);
			}
		}
	}

	private chunkPayload(item: PublishBatchItem): PublishBatchItem[] {
		let payload = item.payload;

		// Convert Buffer to string if needed (happens when msgpack compression is applied by default)
		if (Buffer.isBuffer(payload)) {
			try {
				payload = payload.toString('utf-8');
				this.logger?.debug('Converted Buffer payload to string for chunking', {
					destinationId: this.destinationId,
					bufferSize: item.payload.length,
				});
			} catch (e) {
				this.logger?.debug('Skipping chunking: failed to convert Buffer to string', {
					destinationId: this.destinationId,
					error: e instanceof Error ? e.message : String(e),
				});
				return [item];
			}
		}

		if (typeof payload !== 'string') {
			this.logger?.debug('Skipping chunking: payload is not string', {
				destinationId: this.destinationId,
				payloadType: typeof payload,
				isBuffer: Buffer.isBuffer(payload),
			});
			return [item];
		}

		const subscriptionLimit = typeof item.options?.maxPointsPerMessage === 'number' && item.options.maxPointsPerMessage > 0
			? item.options.maxPointsPerMessage
			: Infinity;
		const limit = Math.min(this.maxReadingsPerMessage, subscriptionLimit);
		if (!Number.isFinite(limit) || limit <= 0) {
			this.logger?.debug('Skipping chunking: invalid limit', {
				destinationId: this.destinationId,
				subscriptionLimit,
				maxReadingsPerMessage: this.maxReadingsPerMessage,
				limit,
			});
			return [item];
		}

		let parsed: Record<string, unknown>;
		try { parsed = JSON.parse(payload); }
		catch (e) {
			this.logger?.debug('Skipping chunking: JSON parse failed', {
				destinationId: this.destinationId,
				error: e instanceof Error ? e.message : String(e),
				payloadLength: payload.length,
			});
			return [item];
		}

		const readingsKey = Array.isArray(parsed.tags) ? 'tags'
			: Array.isArray(parsed.features) ? 'features'
				: Array.isArray(parsed.messages) ? 'messages'
					: null;
		if (!readingsKey) {
			this.logger?.debug('Skipping chunking: no readings key found', {
				destinationId: this.destinationId,
				keys: Object.keys(parsed),
				hasTags: Array.isArray(parsed.tags),
				hasFeatures: Array.isArray(parsed.features),
				hasMessages: Array.isArray(parsed.messages),
			});
			return [item];
		}

		const readings = parsed[readingsKey] as unknown[];
		if (readings.length <= limit) {
			this.logger?.debug('Skipping chunking: readings below limit', {
				destinationId: this.destinationId,
				readingsCount: readings.length,
				limit,
			});
			return [item];
		}

		// Use adaptive chunking to validate actual payload sizes
		return this.adaptiveChunk(parsed, readingsKey, readings, item, limit);
	}

	/**
	 * Adaptively chunk payload by validating actual serialized byte sizes.
	 * Reduces chunk size if serialized payload exceeds maxPayloadSizeBytes.
	 *
	 * @param parsed Parsed payload object
	 * @param readingsKey Key containing readings array ('tags', 'features', 'messages')
	 * @param readings Array of reading objects
	 * @param item Original PublishBatchItem (for preserving metadata)
	 * @param initialChunkSize Initial chunk size from calculator
	 * @returns Array of PublishBatchItems, each with validated payload size
	 */
	private adaptiveChunk(
		parsed: Record<string, unknown>,
		readingsKey: string,
		readings: unknown[],
		item: PublishBatchItem,
		initialChunkSize: number,
	): PublishBatchItem[] {
		const chunks: PublishBatchItem[] = [];
		const maxBytes = this.maxPayloadSizeBytes || 1024 * 1024; // Fallback to 1 MB
		const safetyMargin = 0.9; // Allow up to 90% of max size

		let currentChunkSize = initialChunkSize;
		let totalChunksCreated = 0;
		const startTime = Date.now();

		for (let i = 0; i < readings.length; i += currentChunkSize) {
			let slice = readings.slice(i, i + currentChunkSize);
			let chunkPayload = JSON.stringify({ ...parsed, [readingsKey]: slice });
			let chunkBytes = Buffer.byteLength(chunkPayload, 'utf8');

			// Adaptive reduction: if chunk exceeds safe size, reduce and retry
			let reductionAttempts = 0;
			const maxReductionAttempts = 20; // Prevent infinite loops
			while (chunkBytes > maxBytes * safetyMargin && reductionAttempts < maxReductionAttempts) {
				currentChunkSize = Math.max(1, Math.floor(currentChunkSize * 0.8)); // Reduce by 20%
				slice = readings.slice(i, i + currentChunkSize);
				chunkPayload = JSON.stringify({ ...parsed, [readingsKey]: slice });
				chunkBytes = Buffer.byteLength(chunkPayload, 'utf8');
				reductionAttempts++;
			}

			// Edge case: single reading doesn't fit
			if (chunkBytes > maxBytes * safetyMargin) {
				this.logger?.warn('Chunk exceeds max payload size even with single reading', {
					destinationId: this.destinationId,
					singleReadingBytes: chunkBytes,
					maxPayloadBytes: maxBytes,
					exceedsBy: (chunkBytes / maxBytes).toFixed(2),
				});
				// Fall through and include anyway (better to try than silently drop)
			}

			chunks.push({ ...item, payload: chunkPayload });
			totalChunksCreated++;

			// Log if chunk size had to be reduced significantly
			if (currentChunkSize < initialChunkSize * 0.9) {
				this.logger?.debug('Chunk size reduced due to actual payload size', {
					destinationId: this.destinationId,
					initialChunkSize,
					adaptedChunkSize: currentChunkSize,
					actualBytesInChunk: chunkBytes,
					maxPayloadBytes: maxBytes,
					reductionAttempts,
					readingsInChunk: slice.length,
				});
			}
		}

		const durationMs = Date.now() - startTime;
		this.logger?.info('Adaptively chunked payload for MQTT publish', {
			destinationId: this.destinationId,
			totalReadings: readings.length,
			chunks: chunks.length,
			initialChunkSize,
			finalChunkSize: currentChunkSize,
			calculatedFrom: this.maxPayloadSizeBytes ? 'max-payload-size' : 'config-or-default',
			maxPayloadSizeBytes: this.maxPayloadSizeBytes,
			compressionMethod: this.compressionMethod,
			validationMs: durationMs,
			avgBytesPerChunk: chunks.length > 0
				? Math.round(chunks.reduce((sum, c) => sum + Buffer.byteLength(String(c.payload), 'utf8'), 0) / chunks.length)
				: 0,
		});

		return chunks;
	}

	private async bufferBatch(batch: PublishBatchItem[]): Promise<void> {
		for (const item of batch) {
			const destTopic = typeof item.options?.destinationTopic === 'string' && item.options.destinationTopic.trim().length > 0
				? item.options.destinationTopic.trim()
				: item.topic;
			const payload = Buffer.isBuffer(item.payload) ? item.payload : Buffer.from(String(item.payload));
			await this.destBufferSync!.handlePublish(destTopic, payload, { qos: item.options?.qos ?? 1 });
		}
	}

	private async enableDestinationBuffering(): Promise<void> {
		if (this.destBufferSync) return;
		this.agentLogger?.infoSync('Enabling destination message buffering', {
			component: LogComponents.agent,
			destinationId: this.destinationId,
		});
		const proxy = new ExternalMqttFlushProxy(this.client as ExternalMqttClient);
		this.destBufferSync = new MessageBufferSync(proxy, this.agentLogger, {
			scopeEndpointName: `ext-dest-${this.destinationId}`,
			flushBatchSize: 100,
			flushIntervalMs: 30000,
			maxRetries: 3,
			cleanupIntervalMs: 3600000,
			maxBufferRecords: 5000,
			dropPolicy: 'oldest',
			flushTriggerThreshold: 500,
			maxFlushPerCycle: 500,
			bufferEvenWhenOnline: false,
			enabled: true,
		});
		await this.destBufferSync.start();
	}

	public static fromConfig(
		config: Record<string, unknown> | null | undefined,
		agentLogger?: AgentLogger,
		logger?: Logger,
		destinationId?: number,
		destinationName?: string,
	): MqttPublishPlugin {
		const resolved = loadExternalMqttConfigFromRecord(config, destinationName, destinationId);
		if (!resolved) {
			throw new Error('mqtt publisher requires config_json with a brokerUrl');
		}

		// Extract configuration values
		const maxReadings = typeof config?.maxReadingsPerMessage === 'number' && config.maxReadingsPerMessage > 0
			? config.maxReadingsPerMessage
			: undefined;

		const maxPayloadSize = typeof config?.maxPayloadSize === 'number' && config.maxPayloadSize > 0
			? config.maxPayloadSize
			: PayloadChunkCalculator.getDefaultMaxPayloadSize('mqtt');

		const compressionMethod = typeof config?.compressionMethod === 'string' && config.compressionMethod.trim().length > 0
			? config.compressionMethod
			: 'json';

		return new MqttPublishPlugin(
			new ExternalMqttClient(resolved, agentLogger, destinationName),
			logger,
			destinationId,
			agentLogger,
			maxReadings,
			maxPayloadSize,
			compressionMethod,
		);
	}
}

/**
 * Build an ExternalMqttClient directly from a destination's config_json record.
 * Returns null if the config is missing or invalid.
 * Used by the anomaly alert publisher to connect to a user-defined MQTT broker.
 */
export function createExternalMqttClientFromDestination(
	config: Record<string, unknown> | null | undefined,
	fallbackName?: string,
	logger?: AgentLogger,
): ExternalMqttClient | null {
	const resolved = loadExternalMqttConfigFromRecord(config, fallbackName);
	if (!resolved) return null;
	return new ExternalMqttClient(resolved, logger);
}
