import { EventEmitter } from 'events';
import type { IPublishPlugin, PublishBatchItem, Logger } from '../core/types.js';

interface DatabricksConfig {
	serverEndpoint: string;
	workspaceUrl: string;
	workspaceId: string;
	clientId: string;
	clientSecret: string;
	tableName: string;
	maxRecordsPerRequest: number;
	requestTimeoutMs: number;
	tokenRefreshBufferMs: number;
}

interface TagsPayload {
	timestamp?: number;
	node?: string;
	group?: string;
	tags?: Array<{ name: string; rawName?: string; value?: unknown; error?: unknown; dqStatus?: string; unit?: string }>;
	context?: { deviceUuid?: string; assetPath?: string; metadata?: Record<string, unknown> };
}

interface OAuthToken {
	value: string;
	expiresAt: number;
}

function isTagsPayload(obj: unknown): obj is TagsPayload {
	return typeof obj === 'object' && obj !== null && 'tags' in obj && Array.isArray((obj as TagsPayload).tags);
}

function loadConfig(raw: Record<string, unknown> | null | undefined, _logger?: Logger): DatabricksConfig {
	if (!raw) throw new Error('Databricks destination requires configuration');

	const serverEndpoint = typeof raw.serverEndpoint === 'string' ? raw.serverEndpoint.trim() : '';
	const workspaceUrl = typeof raw.workspaceUrl === 'string' ? raw.workspaceUrl.trim() : '';
	const workspaceId = typeof raw.workspaceId === 'string' ? raw.workspaceId.trim() : '';
	const clientId = typeof raw.clientId === 'string' ? raw.clientId.trim() : '';
	const clientSecret = typeof raw.clientSecret === 'string' ? raw.clientSecret.trim() : '';
	const tableName = typeof raw.tableName === 'string' ? raw.tableName.trim() : '';

	if (!serverEndpoint) throw new Error('Databricks config missing required field: serverEndpoint');
	if (!workspaceUrl) throw new Error('Databricks config missing required field: workspaceUrl');
	if (!workspaceId) throw new Error('Databricks config missing required field: workspaceId');
	if (!clientId) throw new Error('Databricks config missing required field: clientId');
	if (!clientSecret) throw new Error('Databricks config missing required field: clientSecret');
	if (!tableName) throw new Error('Databricks config missing required field: tableName');

	const parts = tableName.split('.');
	if (parts.length !== 3) throw new Error('Databricks tableName must be fully qualified: catalog.schema.table');

	return {
		serverEndpoint: serverEndpoint.replace(/\/+$/, ''),
		workspaceUrl: workspaceUrl.replace(/\/+$/, ''),
		workspaceId,
		clientId,
		clientSecret,
		tableName,
		maxRecordsPerRequest: typeof raw.maxRecordsPerRequest === 'number' && raw.maxRecordsPerRequest > 0
			? Math.min(Math.floor(raw.maxRecordsPerRequest), 5000) : 500,
		requestTimeoutMs: typeof raw.requestTimeoutMs === 'number' && raw.requestTimeoutMs > 0
			? raw.requestTimeoutMs : 30000,
		tokenRefreshBufferMs: typeof raw.tokenRefreshBufferMs === 'number' && raw.tokenRefreshBufferMs > 0
			? raw.tokenRefreshBufferMs : 60000,
	};
}

function buildAuthorizationDetails(tableName: string): string {
	const [catalog, schema, table] = tableName.split('.');
	return JSON.stringify([
		{ type: 'unity_catalog_privileges', privileges: ['USE CATALOG'], object_type: 'CATALOG', object_full_path: catalog },
		{ type: 'unity_catalog_privileges', privileges: ['USE SCHEMA'], object_type: 'SCHEMA', object_full_path: `${catalog}.${schema}` },
		{ type: 'unity_catalog_privileges', privileges: ['SELECT', 'MODIFY'], object_type: 'TABLE', object_full_path: `${catalog}.${schema}.${table}`, operations: ['zerobuswrite'] },
	]);
}

export class DatabricksPublishPlugin extends EventEmitter implements IPublishPlugin {
	private running = false;
	private token: OAuthToken | null = null;
	private lastSuccessAt = 0;
	private readonly config: DatabricksConfig;
	private readonly logger?: Logger;
	private readonly deviceUuid: string;

	constructor(config: DatabricksConfig, logger: Logger | undefined, deviceUuid: string) {
		super();
		this.config = config;
		this.logger = logger;
		this.deviceUuid = deviceUuid;
	}

	static fromConfig(raw: Record<string, unknown> | null, logger?: Logger, deviceUuid?: string): DatabricksPublishPlugin {
		const config = loadConfig(raw, logger);
		return new DatabricksPublishPlugin(config, logger, deviceUuid ?? 'unknown-agent');
	}

	async start(): Promise<void> {
		if (this.running) return;

		try {
			await this.refreshToken();
		} catch (err) {
			this.logger?.warn('Databricks: initial token fetch failed — will retry on first publish', {
				error: (err as Error).message,
			});
		}

		this.running = true;
		this.emit('started');
		this.logger?.info(`Databricks plugin started — ${this.config.serverEndpoint} → ${this.config.tableName}`);
	}

	async stop(): Promise<void> {
		if (!this.running) return;
		this.token = null;
		this.running = false;
		this.emit('stopped');
	}

	isRunning(): boolean {
		return this.running;
	}

	isConnected(): boolean {
		const staleAfterMs = 60000;
		return this.running && (this.lastSuccessAt === 0 || Date.now() - this.lastSuccessAt < staleAfterMs);
	}

	async publishBatch(batch: PublishBatchItem[]): Promise<void> {
		if (!this.running) throw new Error('Databricks plugin not started');

		const records = this.buildRecords(batch);
		if (records.length === 0) return;

		const { maxRecordsPerRequest } = this.config;
		for (let i = 0; i < records.length; i += maxRecordsPerRequest) {
			const chunk = records.slice(i, i + maxRecordsPerRequest);
			await this.postRecordsWithRetry(chunk);
		}

		this.lastSuccessAt = Date.now();
	}

	private buildRecords(batch: PublishBatchItem[]): Record<string, unknown>[] {
		const records: Record<string, unknown>[] = [];

		for (const item of batch) {
			try {
				const text = Buffer.isBuffer(item.payload) ? item.payload.toString('utf-8') : item.payload;
				const raw = JSON.parse(text);

				if (!isTagsPayload(raw) || !raw.tags) continue;

				const ts = raw.timestamp ?? Date.now();
				const deviceName = raw.node ?? null;
				const endpoint = raw.group ?? null;
				const deviceUuid = raw.context?.deviceUuid ?? null;
				const assetPath = raw.context?.assetPath ?? null;

				for (const tag of raw.tags) {
					if (!tag.name) continue;

					const hasError = tag.error !== undefined && tag.error !== null;
					const numericValue = typeof tag.value === 'number' && isFinite(tag.value) ? tag.value
							: typeof tag.value === 'boolean' ? (tag.value ? 1 : 0)
							: null;
					const stringValue = tag.value != null && typeof tag.value !== 'number' && typeof tag.value !== 'boolean'
						? String(tag.value)
						: null;

					records.push({
						timestamp: ts,
						device_name: deviceName,
						endpoint,
						metric_name: tag.name,
						raw_name: tag.rawName ?? tag.name,
						value: numericValue,
						value_str: stringValue,
						quality: hasError ? 'BAD' : (tag.dqStatus ?? 'GOOD'),
						unit: tag.unit ?? null,
						device_uuid: deviceUuid,
						asset_path: assetPath,
						agent_uuid: this.deviceUuid,
					});
				}
			} catch (err) {
				this.logger?.warn('Databricks: failed to parse payload', { error: (err as Error).message });
			}
		}

		return records;
	}

	private async postRecordsWithRetry(records: Record<string, unknown>[], maxAttempts = 3): Promise<void> {
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				const token = await this.ensureToken();
				const url = `${this.config.serverEndpoint}/zerobus/v1/tables/${this.config.tableName}/insert`;

				const response = await fetch(url, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${token}`,
					},
					body: JSON.stringify(records),
					signal: AbortSignal.timeout(this.config.requestTimeoutMs),
				});

				if (response.ok) return;

				if (response.status === 401 && attempt === 1) {
					this.token = null;
					this.logger?.info('Databricks: 401 — refreshing OAuth token');
					continue;
				}

				if (response.status === 400) {
					const body = await response.text().catch(() => '');
					this.logger?.error(`Databricks: schema/data error (400) — skipping batch`, { body });
					return;
				}

				if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
					const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
					this.logger?.warn(`Databricks: ${response.status} — retrying (${attempt}/${maxAttempts}, ${delayMs}ms)`);
					await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
					continue;
				}

				const body = await response.text().catch(() => '');
				throw new Error(`Databricks insert failed: HTTP ${response.status} — ${body}`);
			} catch (err) {
				if (err instanceof Error && err.name === 'TimeoutError' && attempt < maxAttempts) {
					const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
					this.logger?.warn(`Databricks: request timeout — retrying (${attempt}/${maxAttempts}, ${delayMs}ms)`);
					await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
					continue;
				}
				throw err;
			}
		}
	}

	private async ensureToken(): Promise<string> {
		if (this.token && Date.now() < this.token.expiresAt - this.config.tokenRefreshBufferMs) {
			return this.token.value;
		}
		await this.refreshToken();
		return this.token!.value;
	}

	private async refreshToken(): Promise<void> {
		const { workspaceUrl, workspaceId, clientId, clientSecret, tableName, requestTimeoutMs } = this.config;
		const tokenUrl = `${workspaceUrl}/oidc/v1/token`;

		const params = new URLSearchParams({
			grant_type: 'client_credentials',
			scope: 'all-apis',
			resource: `api://databricks/workspaces/${workspaceId}/zerobusDirectWriteApi`,
			authorization_details: buildAuthorizationDetails(tableName),
		});

		const response = await fetch(tokenUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'Authorization': `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
			},
			body: params.toString(),
			signal: AbortSignal.timeout(requestTimeoutMs),
		});

		if (!response.ok) {
			const body = await response.text().catch(() => '');
			throw new Error(`Databricks OAuth token request failed: HTTP ${response.status} — ${body}`);
		}

		const data = await response.json() as { access_token: string; expires_in: number };
		this.token = {
			value: data.access_token,
			expiresAt: Date.now() + data.expires_in * 1000,
		};

		this.logger?.debug('Databricks: OAuth token refreshed', { expiresIn: data.expires_in });
	}

	static async testConnection(raw: Record<string, unknown> | null | undefined, logger?: Logger): Promise<{ ok: boolean; message?: string; error?: string }> {
		try {
			const config = loadConfig(raw, logger);
			const plugin = new DatabricksPublishPlugin(config, logger, 'test');
			await plugin.refreshToken();
			return { ok: true, message: `Authenticated to ${config.workspaceUrl} — table: ${config.tableName}` };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}
}
