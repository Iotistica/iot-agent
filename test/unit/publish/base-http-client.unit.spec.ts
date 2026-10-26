import { BaseHttpClient, type HttpClientConfig } from '../../../src/publish/core/base-http-client';

const fetchMock = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>();
(global as any).fetch = fetchMock;

function ok(status = 200): Response {
	return { ok: true, status, statusText: 'OK' } as Response;
}

function fail(status: number, text = 'Error'): Response {
	return { ok: false, status, statusText: text } as Response;
}

function makeLogger() {
	return {
		debugSync: jest.fn(),
		infoSync: jest.fn(),
		warnSync: jest.fn(),
		errorSync: jest.fn(),
	} as any;
}

class TestHttpClient extends BaseHttpClient {
	constructor(
		private config: HttpClientConfig,
		logger?: any,
	) {
		super(logger);
	}

	protected get providerName(): string {
		return 'test-http';
	}

	protected getLogContext(): Record<string, unknown> {
		return { endpoint: this.config.endpoint };
	}

	protected resolveConfig(): HttpClientConfig {
		return this.config;
	}

	// Expose for testing
	public _retryDelayMs(_attempt: number): number {
		return 0; // no delay in tests
	}
}

describe('BaseHttpClient', () => {
	let client: TestHttpClient;
	let logger: ReturnType<typeof makeLogger>;

	beforeEach(() => {
		jest.clearAllMocks();
		logger = makeLogger();
		client = new TestHttpClient(
			{ endpoint: 'https://example.com/ingest', headers: { 'X-Api-Key': 'secret' } },
			logger,
		);
	});

	afterEach(async () => {
		if (client.isConnected()) await client.disconnect();
	});

	describe('connect / disconnect / state', () => {
		it('starts disconnected', () => {
			expect(client.isConnected()).toBe(false);
			expect(client.getPublishMode()).toBe('buffer-only');
		});

		it('connect sets ready and emits event', async () => {
			const spy = jest.fn();
			client.on('connect', spy);
			await client.connect();
			expect(client.isConnected()).toBe(true);
			expect(client.getPublishMode()).toBe('direct');
			expect(spy).toHaveBeenCalledTimes(1);
		});

		it('does not repeat connect or disconnect side effects', async () => {
			const connectSpy = jest.fn();
			const disconnectSpy = jest.fn();
			client.on('connect', connectSpy);
			client.on('disconnect', disconnectSpy);

			await client.connect();
			await client.connect();
			expect(connectSpy).toHaveBeenCalledTimes(1);
			expect(logger.infoSync).toHaveBeenCalledTimes(1);

			await client.disconnect();
			await client.disconnect();
			expect(disconnectSpy).toHaveBeenCalledTimes(1);
			expect(logger.infoSync).toHaveBeenCalledTimes(2);
		});

		it('disconnect clears ready and emits event', async () => {
			await client.connect();
			const spy = jest.fn();
			client.on('disconnect', spy);
			await client.disconnect();
			expect(client.isConnected()).toBe(false);
			expect(spy).toHaveBeenCalledTimes(1);
		});

		it('getMessageIdGenerator returns undefined', () => {
			expect(client.getMessageIdGenerator()).toBeUndefined();
		});
	});

	describe('publish', () => {
		beforeEach(async () => {
			await client.connect();
		});

		it('throws when not connected', async () => {
			await client.disconnect();
			await expect(client.publish('t', 'data')).rejects.toThrow('not connected');
		});

		it('sends a POST with string payload and a text content type', async () => {
			fetchMock.mockResolvedValueOnce(ok());
			await client.publish('telemetry/sensor1', '{"temp":22}');

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe('https://example.com/ingest');
			expect(init!.method).toBe('POST');
			expect((init!.headers as Record<string, string>)['Content-Type']).toBe('text/plain; charset=utf-8');
			expect((init!.headers as Record<string, string>)['X-Api-Key']).toBe('secret');
			expect(init!.body).toBe('{"temp":22}');
		});

		it('allows configured content type to override the default', async () => {
			const customClient = new TestHttpClient({
				endpoint: 'https://example.com/ingest',
				headers: { 'Content-Type': 'application/json' },
			});
			await customClient.connect();
			fetchMock.mockResolvedValueOnce(ok());

			await customClient.publish('telemetry/sensor1', '{"temp":22}');

			const [, init] = fetchMock.mock.calls[0];
			expect((init!.headers as Record<string, string>)['Content-Type']).toBe('application/json');
			await customClient.disconnect();
		});

		it('sends Buffer payload with octet-stream content type', async () => {
			fetchMock.mockResolvedValueOnce(ok());
			const buf = Buffer.from([0x01, 0x02, 0x03]);
			await client.publish('telemetry/bin', buf);

			const [, init] = fetchMock.mock.calls[0];
			expect((init!.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream');
			expect(init!.body).toEqual(new Uint8Array(buf));
		});

		it('uses destinationTopic over source topic', async () => {
			const customClient = new TestHttpClient(
				{ endpoint: 'https://example.com' },
				logger,
			);
			// Override buildEndpoint to use topic in URL
			(customClient as any).buildEndpoint = (config: HttpClientConfig, topic: string) =>
				`${config.endpoint}/${topic}`;
			await customClient.connect();

			fetchMock.mockResolvedValueOnce(ok());
			await customClient.publish('source/topic', 'data', { destinationTopic: 'custom/topic' });

			const [url] = fetchMock.mock.calls[0];
			expect(url).toBe('https://example.com/custom/topic');
			await customClient.disconnect();
		});
	});

	describe('retry logic', () => {
		beforeEach(async () => {
			await client.connect();
		});

		it('retries on HTTP 500 and succeeds', async () => {
			fetchMock
				.mockResolvedValueOnce(fail(500, 'Internal Server Error'))
				.mockResolvedValueOnce(ok());

			await client.publish('t', 'data');
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it('retries on HTTP 429 and succeeds', async () => {
			fetchMock
				.mockResolvedValueOnce(fail(429, 'Too Many Requests'))
				.mockResolvedValueOnce(ok());

			await client.publish('t', 'data');
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it('retries on HTTP 408 and succeeds', async () => {
			fetchMock
				.mockResolvedValueOnce(fail(408, 'Request Timeout'))
				.mockResolvedValueOnce(ok());

			await client.publish('t', 'data');
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it('does not retry on HTTP 400', async () => {
			fetchMock.mockResolvedValueOnce(fail(400, 'Bad Request'));
			await expect(client.publish('t', 'data')).rejects.toThrow('HTTP 400');
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it('preserves HTTP status metadata on errors', async () => {
			fetchMock.mockResolvedValueOnce(fail(400, 'Bad Request'));

			await expect(client.publish('t', 'data')).rejects.toMatchObject({
				message: 'HTTP 400: Bad Request',
				status: 400,
				statusText: 'Bad Request',
			});
		});

		it('does not retry on HTTP 401', async () => {
			fetchMock.mockResolvedValueOnce(fail(401, 'Unauthorized'));
			await expect(client.publish('t', 'data')).rejects.toThrow('HTTP 401');
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it('retries on network errors', async () => {
			fetchMock
				.mockRejectedValueOnce(new Error('fetch failed'))
				.mockResolvedValueOnce(ok());

			await client.publish('t', 'data');
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it('retries on ECONNREFUSED', async () => {
			fetchMock
				.mockRejectedValueOnce(new Error('ECONNREFUSED'))
				.mockResolvedValueOnce(ok());

			await client.publish('t', 'data');
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it.each(['TimeoutError', 'AbortError'])('retries on %s', async (name) => {
			fetchMock
				.mockRejectedValueOnce(Object.assign(new Error(name), { name }))
				.mockResolvedValueOnce(ok());

			await client.publish('t', 'data');
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH'])(
			'retries on network error code %s',
			async (code) => {
				fetchMock
					.mockRejectedValueOnce(Object.assign(new Error('socket failure'), { code }))
					.mockResolvedValueOnce(ok());

				await client.publish('t', 'data');
				expect(fetchMock).toHaveBeenCalledTimes(2);
			},
		);

		it('retries when a transient network code is nested in cause', async () => {
			const cause = Object.assign(new Error('socket failure'), { code: 'ECONNRESET' });
			fetchMock
				.mockRejectedValueOnce(Object.assign(new Error('request failed'), { cause }))
				.mockResolvedValueOnce(ok());

			await client.publish('t', 'data');

			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(logger.debugSync).toHaveBeenCalledWith('HTTP publish retry', expect.objectContaining({
				attempt: 1,
				maxAttempts: 3,
				retryReason: 'ECONNRESET',
			}));
		});

		it('does not retry after disconnect during retry delay', async () => {
			fetchMock.mockRejectedValueOnce(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
			(client as any)._sleep = async () => client.disconnect();

			await expect(client.publish('t', 'data')).rejects.toThrow('not connected');
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it('exhausts retries and throws', async () => {
			fetchMock
				.mockResolvedValueOnce(fail(503))
				.mockResolvedValueOnce(fail(503))
				.mockResolvedValueOnce(fail(503));

			await expect(client.publish('t', 'data')).rejects.toThrow('HTTP 503');
			expect(fetchMock).toHaveBeenCalledTimes(3);
		});

		it('exhausts retries on network errors and throws', async () => {
			const err = new Error('ETIMEDOUT');
			fetchMock
				.mockRejectedValueOnce(err)
				.mockRejectedValueOnce(err)
				.mockRejectedValueOnce(err);

			await expect(client.publish('t', 'data')).rejects.toThrow('ETIMEDOUT');
			expect(fetchMock).toHaveBeenCalledTimes(3);
		});
	});

	describe('timeout and response body handling', () => {
		function withBody(res: Response, used = false) {
			const cancel = jest.fn().mockResolvedValue(undefined);
			return { res: { ...res, body: { cancel }, bodyUsed: used } as unknown as Response, cancel };
		}

		it.each([0, -5, NaN, Infinity, '100' as any])('falls back to default timeout for %p', async (timeoutMs) => {
			const spy = jest.spyOn(AbortSignal, 'timeout');
			const c = new TestHttpClient({ endpoint: 'https://example.com', timeoutMs });
			await c.connect();
			fetchMock.mockResolvedValueOnce(ok());
			await c.publish('t', 'data');
			expect(spy).toHaveBeenCalledWith(10_000);
			spy.mockRestore();
		});

		it('uses a valid configured timeout', async () => {
			const spy = jest.spyOn(AbortSignal, 'timeout');
			const c = new TestHttpClient({ endpoint: 'https://example.com', timeoutMs: 1234 });
			await c.connect();
			fetchMock.mockResolvedValueOnce(ok());
			await c.publish('t', 'data');
			expect(spy).toHaveBeenCalledWith(1234);
			spy.mockRestore();
		});

		it('cancels unused body on success', async () => {
			await client.connect();
			const { res, cancel } = withBody(ok());
			fetchMock.mockResolvedValueOnce(res);
			await client.publish('t', 'data');
			expect(cancel).toHaveBeenCalledTimes(1);
		});

		it('does not cancel body already used', async () => {
			await client.connect();
			const { res, cancel } = withBody(ok(), true);
			fetchMock.mockResolvedValueOnce(res);
			await client.publish('t', 'data');
			expect(cancel).not.toHaveBeenCalled();
		});

		it('cancels body on non-OK response before retry and before throw', async () => {
			await client.connect();
			const a = withBody(fail(503));
			const b = withBody(ok());
			fetchMock.mockResolvedValueOnce(a.res).mockResolvedValueOnce(b.res);
			await client.publish('t', 'data');
			expect(a.cancel).toHaveBeenCalledTimes(1);

			const c = withBody(fail(400));
			fetchMock.mockResolvedValueOnce(c.res);
			await expect(client.publish('t', 'data')).rejects.toThrow('HTTP 400');
			expect(c.cancel).toHaveBeenCalledTimes(1);
		});

		it('ignores body cancel errors', async () => {
			await client.connect();
			const { res, cancel } = withBody(ok());
			cancel.mockRejectedValueOnce(new Error('boom'));
			fetchMock.mockResolvedValueOnce(res);
			await expect(client.publish('t', 'data')).resolves.toBeUndefined();
		});
	});

	describe('retry delay', () => {
		it('follows exponential backoff pattern', () => {
			const raw = new TestHttpClient({ endpoint: 'http://x' });
			// Access the real implementation via the prototype
			const delay = BaseHttpClient.prototype['_retryDelayMs'];
			expect(delay(0)).toBe(250);
			expect(delay(1)).toBe(500);
			expect(delay(2)).toBe(1000);
			expect(delay(3)).toBe(1000); // capped
		});
	});

	describe('subclass hooks', () => {
		it('calls onPublishSuccess on 2xx', async () => {
			const successSpy = jest.fn();
			(client as any).onPublishSuccess = successSpy;
			await client.connect();
			fetchMock.mockResolvedValueOnce(ok());
			await client.publish('t', 'data');
			expect(successSpy).toHaveBeenCalledTimes(1);
		});

		it('calls onPublishError on non-transient failure', async () => {
			const errorSpy = jest.fn();
			(client as any).onPublishError = errorSpy;
			await client.connect();
			fetchMock.mockResolvedValueOnce(fail(400));
			await expect(client.publish('t', 'data')).rejects.toThrow();
			expect(errorSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe('BasePublishPlugin compatibility', () => {
		it('implements IPublishClient interface', () => {
			expect(typeof client.connect).toBe('function');
			expect(typeof client.disconnect).toBe('function');
			expect(typeof client.publish).toBe('function');
			expect(typeof client.isConnected).toBe('function');
			expect(typeof client.getPublishMode).toBe('function');
		});
	});
});
