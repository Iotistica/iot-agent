/** Shared base MQTT client for external cloud publish providers. */

import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import mqtt from 'mqtt';
import type { IClientOptions, MqttClient } from 'mqtt';
import type { AgentLogger } from '../../logging/agent-logger.js';
import { LogComponents } from '../../logging/types.js';
import type { MqttConnection, PublishMode } from './types.js';

// If a connection dies this fast after connecting, it's more likely a broker-side
// clientId collision (kicked by another session with the same ID) than a network blip.
const RAPID_DROP_THRESHOLD_MS = 3000;
// Consecutive rapid drops before we assume a collision and rotate the clientId.
const RAPID_DROP_LIMIT = 3;

export abstract class BaseMqttClient extends EventEmitter implements MqttConnection {
	protected client: MqttClient | null = null;
	protected connected = false;
	protected readonly maxPublishRetries = 3;

	// Collision self-healing: if a duplicate/orphaned client elsewhere holds the same
	// deterministic clientId, both sides kick each other in a tight reconnect loop.
	// Detect the pattern (connect, then drop almost immediately, repeatedly) and rotate
	// the clientId so this instance stops fighting over the same identity.
	private baseClientId?: string;
	private connectedAt = 0;
	private rapidDropCount = 0;

	constructor(protected readonly logger?: AgentLogger) {
		super();
	}

	protected abstract get providerName(): string;
	protected abstract buildMqttOptions(): IClientOptions;
	protected abstract buildPublishTopic(sourceTopic: string): string;
	protected abstract getLogContext(): Record<string, unknown>;

	protected onConnected(): void {}

	protected onPreDisconnect(): void {}

	protected isTransientPublishError(_error: Error): boolean {
		return true;
	}

	protected onPublishRetry(_attempt: number, _error: Error, _nextDelayMs: number): void {}

	public async connect(): Promise<void> {
		const options = this.buildMqttOptions();
		this.baseClientId = typeof options.clientId === 'string' ? options.clientId : undefined;
		this.rapidDropCount = 0;

		await new Promise<void>((resolve, reject) => {
			const client = mqtt.connect(options as any);
			// Assign immediately so disconnect() can always call end(), even if
			// the initial connection fails and this.client would otherwise stay null.
			this.client = client;
			let initialized = false;

			const markConnected = () => {
				const wasConnected = this.connected;
				this.connected = true;
				this.connectedAt = Date.now();

				if (!wasConnected) {
					this.logger?.infoSync(`${this.providerName} connected`, {
						component: LogComponents.agent,
						...this.getLogContext(),
					});
					this.emit('connect');
					this.onConnected();
				}
			};

			const onConnect = () => {
				markConnected();
				if (!initialized) {
					initialized = true;
					client.removeListener('error', onError);
					resolve();
				}
			};

			const onCloseLike = () => {
				const wasConnected = this.connected;
				this.connected = false;
				if (wasConnected) {
					this.logger?.warnSync(`${this.providerName} connection lost`, {
						component: LogComponents.agent,
						...this.getLogContext(),
					});
					this.trackRapidDrop(client);
				}
			};

			const onDisconnect = () => {
				onCloseLike();
				this.emit('disconnect');
			};

			const onOffline = () => {
				onCloseLike();
			};

			const onReconnect = () => {
				this.logger?.infoSync(`${this.providerName} reconnecting`, {
					component: LogComponents.agent,
					...this.getLogContext(),
				});
			};

			const onEnd = () => {
				onCloseLike();
			};

			const onClose = () => {
				onCloseLike();
			};

			const onError = (err: Error) => {
				if (!initialized) {
					initialized = true;
					client.removeListener('connect', onConnect);
					reject(err);
				}
			};

			client.on('connect', onConnect);
			client.once('error', onError);

			client.on('error', (err) => {
				this.logger?.errorSync(
					`${this.providerName} client error`,
					err instanceof Error ? err : new Error(String(err)),
					{ component: LogComponents.agent, ...this.getLogContext() },
				);
				// Only re-emit if a consumer has registered a listener; otherwise an unhandled
				// 'error' event on an EventEmitter throws and crashes the process.
				if (this.listenerCount('error') > 0) {
					this.emit('error', err);
				}
			});

			client.on('disconnect', onDisconnect);
			client.on('offline', onOffline);
			client.on('reconnect', onReconnect);
			client.on('end', onEnd);
			client.on('close', onClose);
		});
	}

	public async disconnect(): Promise<void> {
		this.onPreDisconnect();
		if (!this.client) return;
		const client = this.client;
		this.client = null;
		this.connected = false;
		this.rapidDropCount = 0;
		// force=true stops any pending reconnect timer immediately
		await new Promise<void>((resolve) => client.end(true, {}, () => resolve()));
		this.emit('disconnect');
	}

	/**
	 * Detect a suspected clientId collision (another session — e.g. a stale/orphaned
	 * agent instance — holding the same deterministic clientId) and self-heal by
	 * rotating to a suffixed clientId, breaking the connect/kick/reconnect tie-loop
	 * without requiring a manual restart. mqtt.js rebuilds the CONNECT packet from
	 * `client.options.clientId` on every reconnect attempt, so mutating it here takes
	 * effect on the next automatic retry.
	 */
	private trackRapidDrop(client: MqttClient): void {
		if (!this.baseClientId || !this.connectedAt) return;

		const aliveMs = Date.now() - this.connectedAt;
		if (aliveMs >= RAPID_DROP_THRESHOLD_MS) {
			this.rapidDropCount = 0;
			return;
		}

		this.rapidDropCount++;
		if (this.rapidDropCount < RAPID_DROP_LIMIT) return;

		const suffix = randomBytes(3).toString('hex');
		const newClientId = `${this.baseClientId}-${suffix}`;
		(client.options as IClientOptions).clientId = newClientId;
		this.rapidDropCount = 0;

		this.logger?.warnSync(`${this.providerName} suspected clientId collision — rotating clientId`, {
			component: LogComponents.agent,
			...this.getLogContext(),
			previousClientId: this.baseClientId,
			newClientId,
			note: 'Connection dropped almost immediately after connecting, repeatedly — likely another session (e.g. a stale agent instance) holding the same clientId. Rotating to break the loop.',
		});
	}

	public async publish(
		topic: string,
		payload: string | Buffer,
		options?: { qos?: 0 | 1 | 2; destinationTopic?: string },
	): Promise<void> {
		if (!this.client || !this.connected) {
			throw new Error(`${this.providerName}: not connected`);
		}

		const targetTopic =
			typeof options?.destinationTopic === 'string' && options.destinationTopic.trim().length > 0
				? options.destinationTopic.trim()
				: this.buildPublishTopic(topic);
		const qos = options?.qos ?? 1;

		let lastError: Error | null = null;
		for (let attempt = 0; attempt < this.maxPublishRetries; attempt++) {
			try {
				await new Promise<void>((resolve, reject) => {
					this.client!.publish(targetTopic, payload, { qos }, (err) =>
						err ? reject(err) : resolve(),
					);
				});
				return;
			} catch (error) {
				const asError = error instanceof Error ? error : new Error(String(error));
				lastError = asError;

				const isLast = attempt === this.maxPublishRetries - 1;
				if (!this.isTransientPublishError(asError) || isLast) {
					throw asError;
				}

				const delayMs = this._retryDelayMs(attempt);
				this.onPublishRetry(attempt, asError, delayMs);
				await this._sleep(delayMs);
			}
		}

		throw lastError || new Error(`${this.providerName} publish failed after retries`);
	}

	public isConnected(): boolean {
		return this.connected;
	}

	public getPublishMode(): PublishMode {
		return this.connected ? 'direct' : 'buffer-only';
	}

	public getMessageIdGenerator(): undefined {
		return undefined;
	}

	protected _retryDelayMs(attempt: number): number {
		return Math.min(250 * 2 ** attempt, 1000);
	}

	protected _sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
