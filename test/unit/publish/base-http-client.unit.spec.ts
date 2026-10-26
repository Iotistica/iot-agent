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

		it('sends a POST with string payload and JSON content type', async () => {
			fetchMock.mockResolvedValueOnce(ok());
			await client.publish('telemetry/sensor1', '{"temp":22}');

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe('https://example.com/ingest');
			expect(init!.method).toBe('POST');
			expect((init!.headers as Record<string, string>)['Content-Type']).toBe('application/json');
			expect((init!.headers as Record<string, string>)['X-Api-Key']).toBe('secret');
			expect(init!.body).toBe('{"temp":22}');
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
