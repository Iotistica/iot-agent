import { Agent, fetch } from 'undici';
import type { Response } from 'undici';

export class HttpError extends Error {
	constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly url: string,
    public readonly body?: any,
	) {
		super(`HTTP ${status} ${statusText}: ${url}`);
		this.name = 'HttpError';
	}
}

export interface HttpResponse<T = any> {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  json(): Promise<T>;
}

export interface HttpClientOptions {
  caCert?: string;
  rejectUnauthorized?: boolean;
  defaultHeaders?: Record<string, string>;
  defaultTimeout?: number;
  throwOnHttpError?: boolean;
}

export interface CompressionStats {
  uncompressedBytes: number;
  compressedBytes: number;
  compressionRatio: number;
  savings: number;
}

export interface HttpClient {
  get<T = any>(url: string, options?: {
    headers?: Record<string, string>;
    timeout?: number;
    signal?: AbortSignal;
  }): Promise<HttpResponse<T>>;

  post<T = any>(url: string, body: any, options?: {
    headers?: Record<string, string>;
    timeout?: number;
    compress?: boolean;
    onCompressionStats?: (stats: CompressionStats) => void;
  }): Promise<HttpResponse<T>>;

  patch<T = any>(url: string, body: any, options?: {
    headers?: Record<string, string>;
    timeout?: number;
    compress?: boolean;
    onCompressionStats?: (stats: CompressionStats) => void;
  }): Promise<HttpResponse<T>>;
}

export class FetchHttpClient implements HttpClient {
	private dispatcher?: Agent;
	private defaultHeaders: Record<string, string>;
	private defaultTimeout?: number;
	private throwOnHttpError: boolean;

	constructor(options?: HttpClientOptions) {
		this.defaultHeaders = options?.defaultHeaders || {};
		this.defaultTimeout = options?.defaultTimeout;
		this.throwOnHttpError = options?.throwOnHttpError ?? false;

		if (options?.caCert || options?.rejectUnauthorized === false) {
			this.dispatcher = new Agent({
				connections: 100,
				pipelining: 10,
				keepAliveTimeout: 10000,
				keepAliveMaxTimeout: 600000,
				connect: {
					ca: options.caCert,
					rejectUnauthorized: options.rejectUnauthorized ?? true,
				},
			});
		}
	}

	private combineSignals(s1?: AbortSignal, s2?: AbortSignal): AbortSignal | undefined {
		if (!s1 && !s2) return undefined;
		if (!s1) return s2;
		if (!s2) return s1;
		if (typeof AbortSignal.any === 'function') return AbortSignal.any([s1, s2]);
		return s1;
	}

	private createAbortSignal(timeoutMs?: number): AbortSignal | undefined {
		if (!timeoutMs) return undefined;
		const controller = new AbortController();
		setTimeout(() => controller.abort(), timeoutMs);
		return controller.signal;
	}

	private async request<T = any>(
		method: 'GET' | 'POST' | 'PATCH',
		url: string,
		body?: any,
		options?: {
      headers?: Record<string, string>;
      timeout?: number;
      signal?: AbortSignal;
      compress?: boolean;
      onCompressionStats?: (stats: CompressionStats) => void;
    },
	): Promise<HttpResponse<T>> {
		const timeout = options?.timeout ?? this.defaultTimeout;
		let finalBody: Buffer | string | undefined;
		let finalHeaders: Record<string, string>;

		if (method !== 'GET' && body !== undefined) {
			const prepared = await this.prepareBody(body, options);
			finalBody = prepared.finalBody;
			finalHeaders = prepared.finalHeaders;
		} else {
			finalHeaders = { ...this.defaultHeaders, ...options?.headers };
		}

		const response = await fetch(url, {
			method,
			headers: finalHeaders,
			body: finalBody,
			signal: this.combineSignals(options?.signal, this.createAbortSignal(timeout)),
			dispatcher: this.dispatcher,
		});

		return this.checkResponse<T>(response, url);
	}

	async get<T = any>(url: string, options?: {
    headers?: Record<string, string>;
    timeout?: number;
    signal?: AbortSignal;
  }): Promise<HttpResponse<T>> {
		return this.request<T>('GET', url, undefined, options);
	}

	async post<T = any>(url: string, body: any, options?: {
    headers?: Record<string, string>;
    timeout?: number;
    compress?: boolean;
    onCompressionStats?: (stats: CompressionStats) => void;
  }): Promise<HttpResponse<T>> {
		return this.request<T>('POST', url, body, options);
	}

	async patch<T = any>(url: string, body: any, options?: {
    headers?: Record<string, string>;
    timeout?: number;
    compress?: boolean;
    onCompressionStats?: (stats: CompressionStats) => void;
  }): Promise<HttpResponse<T>> {
		return this.request<T>('PATCH', url, body, options);
	}

	private async prepareBody(body: any, options?: {
    headers?: Record<string, string>;
    compress?: boolean;
    onCompressionStats?: (stats: CompressionStats) => void;
  }): Promise<{ finalBody: Buffer | string; finalHeaders: Record<string, string> }> {
		let finalBody: Buffer | string;
		const finalHeaders = { ...this.defaultHeaders, ...options?.headers };

		const bodyString = typeof body === 'string' ? body : JSON.stringify(body);

		if (typeof body !== 'string' && !finalHeaders['Content-Type'] && !finalHeaders['content-type']) {
			finalHeaders['Content-Type'] = 'application/json';
		}

		const uncompressedBytes = Buffer.byteLength(bodyString, 'utf8');

		if (options?.compress && uncompressedBytes >= 1024) {
			const { gzip } = await import('zlib');
			const { promisify } = await import('util');
			const gzipAsync = promisify(gzip);
			const compressed = await gzipAsync(bodyString);
			const compressedBytes = compressed.length;
			const savings = uncompressedBytes - compressedBytes;
			const compressionRatio = uncompressedBytes > 0 ? ((1 - compressedBytes / uncompressedBytes) * 100) : 0;

			if (options.onCompressionStats) {
				options.onCompressionStats({ uncompressedBytes, compressedBytes, compressionRatio, savings });
			}

			finalBody = compressed;
			finalHeaders['Content-Encoding'] = 'gzip';
			finalHeaders['Content-Length'] = compressed.length.toString();
		} else {
			finalBody = bodyString;
		}

		return { finalBody, finalHeaders };
	}

	private async checkResponse<T>(response: Response, url: string): Promise<HttpResponse<T>> {
		const httpResponse: HttpResponse<T> = {
			ok: response.ok,
			status: response.status,
			statusText: response.statusText,
			headers: { get: (name: string) => response.headers.get(name) },
			json: () => response.json() as Promise<T>,
		};

		if (this.throwOnHttpError && !response.ok) {
			let body: any;
			try { body = await response.json(); } catch { /* ignore */ }
			throw new HttpError(response.status, response.statusText, url, body);
		}

		return httpResponse;
	}
}
