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
		const startTime = Date.now();
		this.agentLogger?.debugSync('MqttPublishPlugin.start()', {
			component: LogComponents.agent,
			destinationId: this.destinationId,
			timestamp: new Date().toISOString(),
		});

		try {
			if (this.destinationId !== undefined && this.client instanceof ExternalMqttClient) {
				this.agentLogger?.debugSync('Enabling buffering for external MQTT client', {
					component: LogComponents.agent,
					destinationId: this.destinationId,
					clientType: 'ExternalMqttClient',
				});
				await this.enableDestinationBuffering();
			} else {
				this.agentLogger?.debugSync('Buffering not enabled - conditions not met', {
					component: LogComponents.agent,
					destinationId: this.destinationId,
					hasDestinationId: this.destinationId !== undefined,
					isExternalMqtt: this.client instanceof ExternalMqttClient,
					clientType: this.client?.constructor.name,
				});
			}

			await super.start();

		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			const elapsedMs = Date.now() - startTime;

			this.agentLogger?.errorSync(
				'MqttPublishPlugin.start() failed',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.agent,
					destinationId: this.destinationId,
					error: errorMsg,
					elapsedMs,
				},
			);

			throw error;
		}
	}

	override async stop(): Promise<void> {
		const startTime = Date.now();
		this.agentLogger?.debugSync('MqttPublishPlugin.stop() - entry', {
			component: LogComponents.agent,
			destinationId: this.destinationId,
			hasBuffer: !!this.destBufferSync,
			timestamp: new Date().toISOString(),
		});

		try {
			if (this.destBufferSync) {
				const bufferStopStart = Date.now();
				this.agentLogger?.debugSync('Stopping destination buffer', {
					component: LogComponents.agent,
					destinationId: this.destinationId,
				});
				this.destBufferSync.stop();
				const bufferStopMs = Date.now() - bufferStopStart;
				this.agentLogger?.debugSync('Destination buffer stopped', {
					component: LogComponents.agent,
					destinationId: this.destinationId,
					bufferStopMs,
				});
			}

			this.destBufferSync = undefined;
			await super.stop();

			const elapsedMs = Date.now() - startTime;
			this.agentLogger?.debugSync('MqttPublishPlugin.stop() - exit success', {
				component: LogComponents.agent,
				destinationId: this.destinationId,
				totalMs: elapsedMs,
				timestamp: new Date().toISOString(),
			});
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			const elapsedMs = Date.now() - startTime;

			this.agentLogger?.errorSync(
				'MqttPublishPlugin.stop() failed',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.agent,
					destinationId: this.destinationId,
					error: errorMsg,
					elapsedMs,
				},
			);

			throw error;
		}
	}

	override async publishBatch(batch: PublishBatchItem[]): Promise<void> {
		// Payloads are already pre-chunked by Manager (Phase 2 architecture refactoring).
		// This method simply publishes them directly.

		const startTime = Date.now();
		const batchId = Math.random().toString(36).substring(7);

		if (this.destBufferSync && !this.isConnected()) {
			this.agentLogger?.debugSync('Destination offline at batch entry, buffering entire batch', {
				component: LogComponents.agent,
				batchId,
				destinationId: this.destinationId,
				batchSize: batch.length,
				action: 'buffer_offline',
			});
			try {
				await this.bufferBatch(batch);
				const elapsedMs = Date.now() - startTime;
				this.agentLogger?.debugSync('MQTT publishBatch() exit - buffered offline', {
					component: LogComponents.agent,
					batchId,
					destinationId: this.destinationId,
					batchSize: batch.length,
					itemsBuffered: batch.length,
					elapsedMs,
				});
			} catch (bufferError) {
				const errorMsg = bufferError instanceof Error ? bufferError.message : String(bufferError);
				this.agentLogger?.errorSync(
					'Failed to buffer batch during offline condition',
					bufferError instanceof Error ? bufferError : new Error(String(bufferError)),
					{
						component: LogComponents.agent,
						batchId,
						destinationId: this.destinationId,
						batchSize: batch.length,
						error: errorMsg,
					},
				);
			}
			return;
		}

		const failedChunks: PublishBatchItem[] = [];
		let successCount = 0;
		let failureCount = 0;

		// Phase 6-R3: Concurrent MQTT publishing (4 at a time, not sequential)
		// CRITICAL: Limit concurrency to avoid event loop starvation with large batches (100k+)
		const MQTT_PUBLISH_CONCURRENCY = 4;
		const pending = new Set<Promise<void>>();
		const batchStartMs = Date.now();
		let eventLoopYieldCount = 0;
		let maxPendingSize = 0;
		let raceWaitCount = 0;

		this.agentLogger?.debugSync('[R3] Batch processing started', {
			component: LogComponents.agent,
			batchId,
			batchSize: batch.length,
			concurrencyLimit: MQTT_PUBLISH_CONCURRENCY,
		});

		for (const item of batch) {
			// If we have enough concurrent publishes pending, wait for one to complete
			if (pending.size >= MQTT_PUBLISH_CONCURRENCY) {
				raceWaitCount++;
				const raceStart = Date.now();
				await Promise.race(Array.from(pending));
				const _raceMs = Date.now() - raceStart;
			
				// Every ~50 items, yield control back to event loop for health checks
				eventLoopYieldCount++;
				if (eventLoopYieldCount % 50 === 0) {
					await new Promise(resolve => setImmediate(resolve));
				}
			}

			// Track max concurrency observed
			if (pending.size > maxPendingSize) {
				maxPendingSize = pending.size;
			}

			// Recheck connection before each item (can drop between publishes)
			if (!this.isConnected()) {
				this.agentLogger?.debugSync('Destination offline during batch item processing', {
					component: LogComponents.agent,
					batchId,
					destinationId: this.destinationId,
					topic: item.topic,
					action: 'connection_lost_during_loop',
				});
				failedChunks.push(item);
				failureCount++;
				continue;
			}

			try {
				// Log outgoing payload size
				const _payloadBytes = Buffer.isBuffer(item.payload)
					? item.payload.length
					: Buffer.byteLength(item.payload, 'utf8');

				// Don't await here - add to concurrent queue
				const task = Promise.resolve()
					.then(() =>
						this.client.publish(item.topic, item.payload, item.options)
					)
					.then(() => {
						successCount++;
					})
					.catch(() => {
						// Connection lost or publish failed, buffer this item if enabled
						failedChunks.push(item);
						failureCount++;
					})
					.finally(() => {
						pending.delete(task);
					});

				pending.add(task);
			} catch (_error) {
				// Synchronous errors during publish setup
				failedChunks.push(item);
				failureCount++;
			}
		}

		// Wait for all pending publishes to complete
		const finalWaitStart = Date.now();
		await Promise.all(pending);
		const finalWaitMs = Date.now() - finalWaitStart;

		const batchDurationMs = Date.now() - batchStartMs;
		
		// Always log R3 metrics for diagnosis
		this.agentLogger?.debugSync('[R3] Batch processing completed', {
			component: LogComponents.agent,
			batchId,
			batchSize: batch.length,
			totalDurationMs: batchDurationMs,
			finalWaitMs,
			raceWaitCount,
			maxConcurrency: maxPendingSize,
			eventLoopYields: eventLoopYieldCount,
			successCount,
			failureCount,
			avgMsPerItem: (batchDurationMs / batch.length).toFixed(2),
		});

		if (batchDurationMs > 2000 && batch.length > 1000) {
			this.agentLogger?.warnSync('Large batch processing took excessive time', {
				component: LogComponents.agent,
				batchId,
				batchSize: batch.length,
				durationMs: batchDurationMs,
				eventLoopYields: eventLoopYieldCount,
				maxConcurrency: maxPendingSize,
				avgTimePerItem: (batchDurationMs / batch.length).toFixed(2),
				warning: 'Consider reducing MAX_BATCH_MESSAGES if web admin is unresponsive',
			});
		}

		// Buffer any failed items if offline mode is enabled
		if (failedChunks.length > 0) {
			this.agentLogger?.debugSync('Handling failed items after batch publish', {
				component: LogComponents.agent,
				batchId,
				destinationId: this.destinationId,
				failedCount: failedChunks.length,
				successCount,
				totalItems: batch.length,
				bufferEnabled: !!this.destBufferSync,
				concurrency: MQTT_PUBLISH_CONCURRENCY,
			});

			if (this.destBufferSync) {
				try {
					await this.bufferBatch(failedChunks);
					this.agentLogger?.debugSync('Successfully buffered failed items', {
						component: LogComponents.agent,
						batchId,
						destinationId: this.destinationId,
						itemsBuffered: failedChunks.length,
					});
				} catch (bufferError) {
					const errorMsg = bufferError instanceof Error ? bufferError.message : String(bufferError);
					this.agentLogger?.errorSync(
						'Failed to buffer items after publish failure',
						bufferError instanceof Error ? bufferError : new Error(String(bufferError)),
						{
							component: LogComponents.agent,
							batchId,
							destinationId: this.destinationId,
							attemptedBufferCount: failedChunks.length,
							error: errorMsg,
						},
					);
				}
			} else {
				this.agentLogger?.errorSync(
					'MQTT batch items failed and buffering disabled — data loss risk',
					new Error('Buffering disabled and publish failed'),
					{
						component: LogComponents.agent,
						batchId,
						destinationId: this.destinationId,
						failedItemCount: failedChunks.length,
						successCount,
						totalItems: batch.length,
						recommendation: 'Enable buffering for this destination or verify MQTT broker connectivity',
					},
				);
			}
		}

	}

	private async bufferBatch(batch: PublishBatchItem[]): Promise<void> {
		const bufferId = Math.random().toString(36).substring(7);
		const startTime = Date.now();

		this.agentLogger?.debugSync('bufferBatch() entry', {
			component: LogComponents.agent,
			bufferId,
			destinationId: this.destinationId,
			batchSize: batch.length,
			timestamp: new Date().toISOString(),
		});

		let bufferedCount = 0;
		let bufferErrors = 0;

		for (let i = 0; i < batch.length; i++) {
			const item = batch[i];
			try {
				const destTopic = typeof item.options?.destinationTopic === 'string' && item.options.destinationTopic.trim().length > 0
					? item.options.destinationTopic.trim()
					: item.topic;
				const payload = Buffer.isBuffer(item.payload) ? item.payload : Buffer.from(String(item.payload));
				const payloadBytes = payload.length;

				this.agentLogger?.debugSync('Buffering item', {
					component: LogComponents.agent,
					bufferId,
					itemIndex: i,
					totalItems: batch.length,
					destinationId: this.destinationId,
					topic: item.topic,
					destTopic,
					payloadBytes,
					qos: item.options?.qos ?? 1,
				});

				const handleStart = Date.now();
				await this.destBufferSync!.handlePublish(destTopic, payload, { qos: item.options?.qos ?? 1 });
				const handleMs = Date.now() - handleStart;

				this.agentLogger?.debugSync('Item buffered successfully', {
					component: LogComponents.agent,
					bufferId,
					itemIndex: i,
					destinationId: this.destinationId,
					bufferHandleMs: handleMs,
					payloadBytes,
				});

				bufferedCount++;
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);

				this.agentLogger?.debugSync('Failed to buffer item', {
					component: LogComponents.agent,
					bufferId,
					itemIndex: i,
					destinationId: this.destinationId,
					topic: item.topic,
					error: errorMsg,
					action: 'buffer_error',
				});

				bufferErrors++;
			}
		}

		const elapsedMs = Date.now() - startTime;
		this.agentLogger?.debugSync('bufferBatch() exit', {
			component: LogComponents.agent,
			bufferId,
			destinationId: this.destinationId,
			batchSize: batch.length,
			bufferedCount,
			bufferErrors,
			totalTimeMs: elapsedMs,
			averageTimePerItemMs: batch.length > 0 ? (elapsedMs / batch.length).toFixed(2) : 0,
			timestamp: new Date().toISOString(),
		});

		if (bufferErrors > 0) {
			throw new Error(`Failed to buffer ${bufferErrors}/${batch.length} items`);
		}
	}

	private async enableDestinationBuffering(): Promise<void> {
		if (this.destBufferSync) {
			this.agentLogger?.debugSync('Destination buffering already enabled', {
				component: LogComponents.agent,
				destinationId: this.destinationId,
			});
			return;
		}

		const initStart = Date.now();
		this.agentLogger?.debugSync('enableDestinationBuffering() - starting initialization', {
			component: LogComponents.agent,
			destinationId: this.destinationId,
			timestamp: new Date().toISOString(),
		});

		try {
			this.agentLogger?.infoSync('Enabling destination message buffering', {
				component: LogComponents.agent,
				destinationId: this.destinationId,
			});
			const proxy = new ExternalMqttFlushProxy(this.client as ExternalMqttClient);

			this.agentLogger?.debugSync('Created ExternalMqttFlushProxy', {
				component: LogComponents.agent,
				destinationId: this.destinationId,
				proxyType: 'ExternalMqttFlushProxy',
			});

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

			this.agentLogger?.debugSync('Created MessageBufferSync instance', {
				component: LogComponents.agent,
				destinationId: this.destinationId,
				bufferConfig: {
					scopeEndpointName: `ext-dest-${this.destinationId}`,
					maxBufferRecords: 5000,
					flushBatchSize: 100,
					flushIntervalMs: 30000,
				},
			});

			const startMs = Date.now();
			await this.destBufferSync.start();
			const startupMs = Date.now() - startMs;

			const totalMs = Date.now() - initStart;
			this.agentLogger?.debugSync('enableDestinationBuffering() - initialization complete', {
				component: LogComponents.agent,
				destinationId: this.destinationId,
				bufferStartupMs: startupMs,
				totalInitMs: totalMs,
				timestamp: new Date().toISOString(),
			});
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			const totalMs = Date.now() - initStart;

			this.agentLogger?.errorSync(
				'Failed to enable destination buffering',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.agent,
					destinationId: this.destinationId,
					error: errorMsg,
					totalInitMs: totalMs,
				},
			);

			throw error;
		}
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
