/** Shared base HTTP client for HTTP-based publishing destinations. */

import { EventEmitter } from 'events';
import type { AgentLogger } from '../../logging/agent-logger.js';
import { LogComponents } from '../../logging/types.js';
import type { PublishMode, IPublishClient } from './types.js';

export interface HttpClientConfig {
	endpoint: string;
	headers?: Record<string, string>;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export abstract class BaseHttpClient extends EventEmitter implements IPublishClient {
	protected ready = false;
	protected readonly maxPublishRetries = 3;

	constructor(protected readonly logger?: AgentLogger) {
		super();
	}

	protected abstract get providerName(): string;
	protected abstract getLogContext(): Record<string, unknown>;
	protected abstract resolveConfig(): HttpClientConfig;

	protected buildEndpoint(config: HttpClientConfig, _topic: string): string {
		return config.endpoint;
	}

	protected buildHeaders(config: HttpClientConfig, payload: string | Buffer): Record<string, string> {
		const contentType = Buffer.isBuffer(payload) ? 'application/octet-stream' : 'application/json';
		return { 'Content-Type': contentType, ...config.headers };
	}

	protected buildBody(payload: string | Buffer): string | Uint8Array {
		return Buffer.isBuffer(payload) ? new Uint8Array(payload) : payload;
	}

	protected isTransientError(status: number, _error?: Error): boolean {
		return status === 408 || status === 429 || status >= 500;
	}

	protected isTransientNetworkError(error: Error): boolean {
		const msg = error.message.toLowerCase();
		return msg.includes('fetch failed')
			|| msg.includes('network')
			|| msg.includes('econnrefused')
			|| msg.includes('econnreset')
			|| msg.includes('etimedout')
			|| msg.includes('enetunreach')
			|| msg.includes('abort')
			|| error.name === 'AbortError';
	}

	protected onPublishRetry(attempt: number, error: Error, nextDelayMs: number): void {
		this.logger?.debugSync('HTTP publish retry', {
			component: LogComponents.agent,
			attempt,
			error: error.message,
			nextDelayMs,
			...this.getLogContext(),
		});
	}

	protected onPublishSuccess(_response: Response, _topic: string): void {}

	protected onPublishError(_error: Error, _topic: string): void {}

	public async connect(): Promise<void> {
		this.ready = true;
		this.logger?.infoSync('HTTP destination ready', {
			component: LogComponents.agent,
			destination: this.providerName,
			...this.getLogContext(),
		});
		this.emit('connect');
	}

	public async disconnect(): Promise<void> {
		this.ready = false;
		this.logger?.infoSync('HTTP destination disconnected', {
			component: LogComponents.agent,
			destination: this.providerName,
			...this.getLogContext(),
		});
		this.emit('disconnect');
	}

	public isConnected(): boolean {
		return this.ready;
	}

	public getPublishMode(): PublishMode {
		return this.ready ? 'direct' : 'buffer-only';
	}

	public getMessageIdGenerator(): undefined {
		return undefined;
	}

	public async publish(
		topic: string,
		payload: string | Buffer,
		options?: { qos?: 0 | 1 | 2; destinationTopic?: string },
	): Promise<void> {
		if (!this.ready) {
			throw new Error(`${this.providerName}: not connected`);
		}

		const config = this.resolveConfig();
		const targetTopic =
			typeof options?.destinationTopic === 'string' && options.destinationTopic.trim().length > 0
				? options.destinationTopic.trim()
				: topic;

		const url = this.buildEndpoint(config, targetTopic);
		const headers = this.buildHeaders(config, payload);
		const body = this.buildBody(payload);
		const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

		let lastError: Error | null = null;
		for (let attempt = 0; attempt < this.maxPublishRetries; attempt++) {
			let response: Response;
			try {
				response = await fetch(url, {
					method: 'POST',
					headers,
					body: body as any,
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (error) {
				const asError = error instanceof Error ? error : new Error(String(error));
				lastError = asError;

				const isNetwork = this.isTransientNetworkError(asError);
				const isLast = attempt === this.maxPublishRetries - 1;
				if (!isNetwork || isLast) {
					this.onPublishError(asError, targetTopic);
					throw asError;
				}

				const delayMs = this._retryDelayMs(attempt);
				this.onPublishRetry(attempt, asError, delayMs);
				await this._sleep(delayMs);
				continue;
			}

			if (response.ok) {
				this.onPublishSuccess(response, targetTopic);
				return;
			}

			const errMsg = `HTTP ${response.status}: ${response.statusText}`;
			const httpError = new Error(errMsg);
			lastError = httpError;

			if (!this.isTransientError(response.status, httpError) || attempt === this.maxPublishRetries - 1) {
				this.onPublishError(httpError, targetTopic);
				throw httpError;
			}

			const delayMs = this._retryDelayMs(attempt);
			this.onPublishRetry(attempt, httpError, delayMs);
			await this._sleep(delayMs);
		}

		throw lastError || new Error(`${this.providerName} publish failed after retries`);
	}

	protected _retryDelayMs(attempt: number): number {
		return Math.min(250 * 2 ** attempt, 1000);
	}

	protected _sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
