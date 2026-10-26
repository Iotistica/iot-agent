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
const TRANSIENT_NETWORK_ERROR_CODES = new Set([
	'ECONNREFUSED',
	'ECONNRESET',
	'ETIMEDOUT',
	'ENETUNREACH',
]);

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
		const contentType = Buffer.isBuffer(payload) ? 'application/octet-stream' : 'text/plain; charset=utf-8';
		return { 'Content-Type': contentType, ...config.headers };
	}

	protected buildBody(payload: string | Buffer): string | Uint8Array {
		return Buffer.isBuffer(payload) ? new Uint8Array(payload) : payload;
	}

	protected isTransientError(status: number, _error?: Error): boolean {
		return status === 408 || status === 429 || status >= 500;
	}

	protected isTransientNetworkError(error: Error): boolean {
		const seen = new Set<unknown>();
		let current: unknown = error;

		while (current && typeof current === 'object' && !seen.has(current)) {
			seen.add(current);
			const candidate = current as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
			if (
				candidate.name === 'TimeoutError'
				|| candidate.name === 'AbortError'
				|| (typeof candidate.code === 'string' && TRANSIENT_NETWORK_ERROR_CODES.has(candidate.code.toUpperCase()))
				|| (
					typeof candidate.message === 'string'
					&& /fetch failed|network|econnrefused|econnreset|etimedout|enetunreach/i.test(candidate.message)
				)
			) {
				return true;
			}
			current = candidate.cause;
		}

		return false;
	}

	protected getRetryReason(error: Error): string {
		const httpStatus = (error as Error & { status?: unknown }).status;
		if (typeof httpStatus === 'number') return `HTTP ${httpStatus}`;

		const seen = new Set<unknown>();
		let current: unknown = error;
		while (current && typeof current === 'object' && !seen.has(current)) {
			seen.add(current);
			const candidate = current as { name?: unknown; code?: unknown; cause?: unknown };
			if (candidate.name === 'TimeoutError' || candidate.name === 'AbortError') {
				return String(candidate.name);
			}
			if (typeof candidate.code === 'string' && TRANSIENT_NETWORK_ERROR_CODES.has(candidate.code.toUpperCase())) {
				return candidate.code.toUpperCase();
			}
			current = candidate.cause;
		}

		return 'network error';
	}

	protected onPublishRetry(attempt: number, error: Error, nextDelayMs: number): void {
		this.logger?.debugSync('HTTP publish retry', {
			component: LogComponents.agent,
			attempt: attempt + 1,
			maxAttempts: this.maxPublishRetries,
			retryReason: this.getRetryReason(error),
			error: error.message,
			nextDelayMs,
			...this.getLogContext(),
		});
	}

	protected onPublishSuccess(_response: Response, _topic: string): void {}

	protected onPublishError(_error: Error, _topic: string): void {}

	public async connect(): Promise<void> {
		if (this.ready) return;

		this.ready = true;
		this.logger?.infoSync('HTTP destination ready', {
			component: LogComponents.agent,
			destination: this.providerName,
			...this.getLogContext(),
		});
		this.emit('connect');
	}

	public async disconnect(): Promise<void> {
		if (!this.ready) return;

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
		// Retrying a POST is at-least-once: a server may accept a request before its
		// response is lost. Destinations that require de-duplication should provide an
		// idempotency key through their configured headers.
		for (let attempt = 0; attempt < this.maxPublishRetries; attempt++) {
			if (!this.ready) {
				const error = new Error(`${this.providerName}: not connected`);
				this.onPublishError(error, targetTopic);
				throw error;
			}

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
			const httpError = Object.assign(new Error(errMsg), {
				status: response.status,
				statusText: response.statusText,
			});
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
