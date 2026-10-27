import * as net from 'net';
import { EventEmitter } from 'events';
import { BasePublishPlugin } from '../core/base-plugin.js';
import type { IPublishClient, PublishMode, Logger } from '../core/types.js';

export interface SocketDestinationConfig {
	appId: number;
	serviceId: number;
	socketPath: string;
	connectTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadSocketConfig(config: Record<string, unknown> | null | undefined): SocketDestinationConfig | null {
	if (!isRecord(config)) return null;
	const socketPath = typeof config.socketPath === 'string' ? config.socketPath : '';
	if (!socketPath) return null;
	return {
		appId: typeof config.appId === 'number' ? config.appId : 0,
		serviceId: typeof config.serviceId === 'number' ? config.serviceId : 0,
		socketPath,
		connectTimeoutMs: typeof config.connectTimeoutMs === 'number' ? config.connectTimeoutMs : 5000,
	};
}

export class SocketPublishClient extends EventEmitter implements IPublishClient {
	private socket: net.Socket | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private connectTimer: NodeJS.Timeout | null = null;
	private stopped = false;
	private connected = false;
	private currentDelay: number;
	private attempts = 0;
	private lastPublishAt = 0;

	private readonly INITIAL_DELAY_MS = 500;
	private readonly MAX_DELAY_MS = 8000;
	private readonly FAST_RETRY_THRESHOLD = 5;
	private readonly ACTIVE_WINDOW_MS = 120_000;

	constructor(
		private readonly config: SocketDestinationConfig,
		private readonly logger?: Logger,
	) {
		super();
		this.currentDelay = this.INITIAL_DELAY_MS;
	}

	async connect(): Promise<void> {
		this.stopped = false;
		this.doConnect();
	}

	async disconnect(): Promise<void> {
		this.stopped = true;
		this.clearTimers();
		if (this.socket) {
			this.socket.removeAllListeners();
			this.socket.end();
			this.socket.destroy();
			this.socket = null;
		}
		this.connected = false;
		this.emit('disconnect');
	}

	async publish(topic: string, payload: string | Buffer, options?: { destinationTopic?: string }): Promise<void> {
		if (!this.socket || !this.connected) {
			throw new Error('Socket not connected');
		}
		const effectiveTopic = options?.destinationTopic || topic;
		const frame = JSON.stringify({ topic: effectiveTopic, data: typeof payload === 'string' ? payload : payload.toString('utf8'), ts: Date.now() }) + '\n';
		return new Promise<void>((resolve, reject) => {
			const flushed = this.socket!.write(frame, 'utf8', (err) => {
				if (err) return reject(err);
				this.lastPublishAt = Date.now();
			});
			if (flushed) {
				this.lastPublishAt = Date.now();
				resolve();
			} else {
				this.socket!.once('drain', () => {
					this.lastPublishAt = Date.now();
					resolve();
				});
			}
		});
	}

	isConnected(): boolean {
		return this.connected || (this.lastPublishAt > 0 && Date.now() - this.lastPublishAt < this.ACTIVE_WINDOW_MS);
	}

	getPublishMode(): PublishMode {
		return this.connected ? 'direct' : 'recovering';
	}

	private doConnect(): void {
		this.clearTimers();

		try {
			this.socket = net.createConnection({ path: this.config.socketPath });

			this.connectTimer = setTimeout(() => {
				if (!this.connected && this.socket) {
					this.socket.destroy(new Error('Connect timeout'));
				}
			}, this.config.connectTimeoutMs || 5000);

			this.socket.on('connect', () => {
				this.clearTimers();
				this.connected = true;
				this.attempts = 0;
				this.currentDelay = this.INITIAL_DELAY_MS;
				this.emit('connect');
			});

			this.socket.on('error', (err: Error) => {
				const isTransient = (err as NodeJS.ErrnoException).code === 'ENOENT'
					|| (err as NodeJS.ErrnoException).code === 'ECONNREFUSED';
				if (isTransient) {
					this.logger?.debug?.(`Socket not ready: ${this.config.socketPath} (${(err as NodeJS.ErrnoException).code})`);
				} else {
					this.logger?.error?.(`Socket error: ${err.message}`);
				}
			});

			this.socket.on('close', () => {
				this.clearTimers();
				const wasConnected = this.connected;
				this.connected = false;
				this.socket = null;
				if (wasConnected) {
					this.emit('disconnect');
				}
				if (!this.stopped) {
					this.scheduleReconnect();
				}
			});
		} catch (err) {
			this.logger?.error?.(`Failed to create socket connection: ${err}`);
			if (!this.stopped) {
				this.scheduleReconnect();
			}
		}
	}

	private scheduleReconnect(): void {
		this.clearTimers();
		let delay: number;
		if (this.attempts < this.FAST_RETRY_THRESHOLD) {
			delay = Math.min(this.currentDelay, this.MAX_DELAY_MS);
			this.currentDelay *= 2;
		} else {
			delay = this.MAX_DELAY_MS;
		}
		this.reconnectTimer = setTimeout(() => {
			this.attempts++;
			this.doConnect();
		}, delay);
	}

	private clearTimers(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.connectTimer) {
			clearTimeout(this.connectTimer);
			this.connectTimer = null;
		}
	}
}

export class SocketPublishPlugin extends BasePublishPlugin {
	public static fromConfig(
		config: Record<string, unknown> | null | undefined,
		logger?: Logger,
	): SocketPublishPlugin {
		const resolved = loadSocketConfig(config);
		if (!resolved) {
			throw new Error('socket publisher requires config_json with a socketPath');
		}
		return new SocketPublishPlugin(new SocketPublishClient(resolved, logger), logger);
	}
}
