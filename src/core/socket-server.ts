import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import { Worker } from "node:worker_threads";
import { type DeviceDataPoint, type SocketOutput, type Logger } from "../plugins/types.js";

export interface ISocketServer {
	start(): Promise<void>;
	stop(): Promise<void>;
	sendData(dataPoints: DeviceDataPoint[], topic?: string): void;
	sendControl(payload: Record<string, unknown>, topic?: string): void;
}

interface ClientSubscription {
	socket: net.Socket;
	topics: Set<string>; // Empty set = all topics
	rules: ClientRoutingRules;
	lastSentAt: number;
}

interface ClientRoutingRules {
	includeMetrics: Set<string>;
	excludeMetrics: Set<string>;
	includeDevices: Set<string>;
	excludeDevices: Set<string>;
	allowedQualities: Set<"GOOD" | "BAD" | "UNCERTAIN">;
	minIntervalMs: number;
	maxPointsPerMessage: number;
}

/**
 * IPC Socket Server — bridges protocol adapters to the publish pipeline.
 *
 * Data flow:
 *
 *   Adapter                       SocketServer                  PublishManager
 *   ───────                       ────────────                  ──────────────
 *   subscription notifications    sendData(batch, topic)        SocketConnection
 *   → coalescing buffer (Map)     → formatAsJson()              → 'data' events
 *   → flush every coalesceMs      → socket.write() per chunk    → MessageBatcher.appendData()
 *   → emit('data', chunk)                                       → JSON.parse + batch
 *     (FLUSH_CHUNK_SIZE items)                                  → publishBatch() → MQTT/HTTP
 *
 * Transport: Unix domain socket (Linux/Docker) or Windows Named Pipe.
 * Framing: newline-delimited JSON (delimiter configurable via endpoint_outputs).
 *
 * Subscription handshake:
 *   client → {"subscribe": ["opcua"]}   (empty array = wildcard / all topics)
 *   server → {"ok": true, "subscribed_to": ["opcua"], "routing": {...}}
 *   Routing rules (includeMetrics, excludeDevices, qualities, minIntervalMs,
 *   maxPointsPerMessage) are optional per-client overrides on the handshake.
 *
 * Backpressure (critical at scale):
 *   The adapter and consumer share one event loop. At 70k points the adapter
 *   emits ~140 chunks per flush; each is JSON-serialised and socket.write()'d.
 *   The kernel buffer fills quickly and write() returns false.
 *   Writes are skipped when Node's internal write queue exceeds
 *   MAX_WRITE_QUEUE_BYTES (32 MB). Skipped data is not lost permanently —
 *   the adapter's coalescing buffer re-fills every publish interval and the
 *   next flush picks up fresh values. No drain-timeout removal: in same-process
 *   IPC the consumer cannot be "stuck" independently of the server — if the
 *   event loop runs, it will drain. Dead clients are caught by socket
 *   close/error events, not by write-side timers.
 *
 * Control messages:
 *   sendControl() delivers out-of-band payloads (e.g. device-schema declarations)
 *   to subscribers. Device-schema messages are retained per topic+deviceName and
 *   replayed on new subscriptions so late-connecting clients don't miss them.
 *
 * Lookup: Map<topic, Set<socket>> + wildcard Set → O(K) per send, K = subscribers.
 */
export class SocketServer implements ISocketServer {
	private server?: net.Server;
	private subscriptions: Map<net.Socket, ClientSubscription> = new Map();
	private pendingSubscriptions: Set<net.Socket> = new Set();
	private topicToSockets: Map<string, Set<net.Socket>> = new Map();
	private wildcardSockets: Set<net.Socket> = new Set();
	// topic → deviceName → latest device-schema payload, replayed on new subscriptions.
	private retainedDeviceSchema: Map<string, Map<string, Record<string, unknown>>> = new Map();
	private config: SocketOutput;
	private logger: Logger;
	private started = false;
	private isWindowsNamedPipe: boolean;
	private lastBackpressureLogAt = 0;
	private readonly MAX_CLIENTS = 10;
	private readonly SUBSCRIPTION_TIMEOUT_MS = 5000;
	private readonly MAX_WRITE_QUEUE_BYTES = 32 * 1024 * 1024;
	private readonly MAX_POINTS_PER_MESSAGE_LIMIT = 1000;
	private readonly MAX_MIN_INTERVAL_MS = 60_000;
	private readonly MAX_SUBSCRIPTION_BUFFER = 8192;

	constructor(config: SocketOutput, logger: Logger) {
		this.config = config;
		this.logger = logger;
		this.isWindowsNamedPipe =
			this.config.socketPath.startsWith("\\\\.\\pipe\\");
	}

	async start(): Promise<void> {
		if (this.started) {
			this.logger.debug(
				`IPC server already running at: ${this.config.socketPath}`,
			);
			return;
		}

		try {
			if (!this.isWindowsNamedPipe) {
				const socketDir = path.dirname(this.config.socketPath);
				if (!fs.existsSync(socketDir)) {
					fs.mkdirSync(socketDir, { recursive: true });
				}
				if (fs.existsSync(this.config.socketPath)) {
					fs.unlinkSync(this.config.socketPath);
				}
			}

			this.server = net.createServer((socket) => {
				this.handleClientConnection(socket);
			});

			await new Promise<void>((resolve, reject) => {
				let settled = false;

				this.server!.listen(this.config.socketPath, () => {
					const transportType = this.isWindowsNamedPipe
						? "Windows Named Pipe"
						: "Unix socket";
					this.logger.info(
						`IPC server started (${transportType}) with pub/sub routing at: ${this.config.socketPath}`,
					);

					if (!this.isWindowsNamedPipe) {
						try {
							fs.chmodSync(this.config.socketPath, 0o660);
						} catch { /* some environments may not allow chmod on sockets */ }
					}

					this.started = true;
					settled = true;
					resolve();
				});

				this.server!.on("error", (error) => {
					if (!settled) {
						reject(error);
					} else {
						this.logger.error(`Socket server runtime error: ${error.message}`);
					}
				});
			});
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to start socket server: ${errorMessage}`);
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (!this.started || !this.server) {
			return;
		}

		try {
			for (const { socket } of this.subscriptions.values()) {
				socket.destroy();
			}
			for (const socket of this.pendingSubscriptions) {
				socket.destroy();
			}
			this.subscriptions.clear();
			this.pendingSubscriptions.clear();
			this.topicToSockets.clear();
			this.wildcardSockets.clear();

			await new Promise<void>((resolve) => {
				this.server!.close(() => {
					const transportType = this.isWindowsNamedPipe
						? "Windows Named Pipe"
						: "Unix socket";
					this.logger.debug(`IPC server stopped (${transportType})`);
					resolve();
				});
			});

			if (!this.isWindowsNamedPipe) {
				try {
					if (fs.existsSync(this.config.socketPath)) {
						fs.unlinkSync(this.config.socketPath);
					}
				} catch (unlinkError: any) {
					if (unlinkError?.code !== "ENOENT") {
						this.logger.warn(
							`Failed to remove socket file: ${unlinkError?.message || unlinkError}`,
						);
					}
				}
			}

			this.started = false;
			this.server = undefined;
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			this.logger.error(`Error stopping socket server: ${errorMessage}`);
		}
	}

	sendData(dataPoints: DeviceDataPoint[], topic: string = "generic"): void {
		if (!this.started || this.subscriptions.size === 0) {
			return;
		}

		try {
			const sentTo = new Set<net.Socket>();
			const topicSubscribers = this.topicToSockets.get(topic);
			if (topicSubscribers) {
				topicSubscribers.forEach((socket) => {
					this.routeAndSendToSocket(socket, dataPoints, topic, sentTo);
				});
			}

			this.wildcardSockets.forEach((socket) => {
				if (!sentTo.has(socket)) {
					this.routeAndSendToSocket(socket, dataPoints, topic, sentTo);
				}
			});
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			this.logger.error(`Error sending data: ${errorMessage}`);
		}
	}

	/** Out-of-band control message (e.g. device-schema) — bypasses routing rules. */
	sendControl(payload: Record<string, unknown>, topic: string = "generic"): void {
		if (payload.__control === "device-schema" && typeof payload.deviceName === "string") {
			let byDevice = this.retainedDeviceSchema.get(topic);
			if (!byDevice) {
				byDevice = new Map();
				this.retainedDeviceSchema.set(topic, byDevice);
			}
			byDevice.set(payload.deviceName, payload);
		}

		if (!this.started || this.subscriptions.size === 0) {
			// TEMPORARY diagnostic — see issue #17 follow-up investigation.
			this.logger.debug(`[SCHEMA_DECLARE_DIAG] sendControl dropped: started=${this.started} subscriptions=${this.subscriptions.size} topic=${topic}`);
			return;
		}

		try {
			const data = JSON.stringify(payload) + this.config.delimiter;
			const sentTo = new Set<net.Socket>();

			const topicSubscribers = this.topicToSockets.get(topic);
			// TEMPORARY diagnostic — see issue #17 follow-up investigation.
			this.logger.debug(`[SCHEMA_DECLARE_DIAG] sendControl topic=${topic} topicSubscribers=${topicSubscribers?.size ?? 0} wildcardSockets=${this.wildcardSockets.size}`);
			if (topicSubscribers) {
				topicSubscribers.forEach((socket) => {
					this.sendToSocket(socket, data, topic, sentTo);
				});
			}

			this.wildcardSockets.forEach((socket) => {
				if (!sentTo.has(socket)) {
					this.sendToSocket(socket, data, topic, sentTo);
				}
			});
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			this.logger.error(`Error sending control message: ${errorMessage}`);
		}
	}

	private routeAndSendToSocket(
		socket: net.Socket,
		dataPoints: DeviceDataPoint[],
		topic: string,
		sentTo: Set<net.Socket>,
	): void {
		const subscription = this.subscriptions.get(socket);
		if (!subscription) {
			return;
		}

		const filteredPoints = this.applyRoutingRules(subscription, dataPoints);
		if (filteredPoints.length === 0) {
			return;
		}

		const data = this.formatData(filteredPoints) + this.config.delimiter;
		const sent = this.sendToSocket(socket, data, topic, sentTo);
		if (sent) {
			subscription.lastSentAt = Date.now();
		}
	}

	private sendToSocket(
		socket: net.Socket,
		data: string,
		topic: string,
		sentTo: Set<net.Socket>,
	): boolean {
		try {
			if (socket.writableLength > this.MAX_WRITE_QUEUE_BYTES) {
				const now = Date.now();
				if (now - this.lastBackpressureLogAt >= 10_000) {
					this.lastBackpressureLogAt = now;
					this.logger.warn(
						`IPC write queue full (topic: ${topic}, queued: ${(socket.writableLength / (1024 * 1024)).toFixed(1)}MB / ${(this.MAX_WRITE_QUEUE_BYTES / (1024 * 1024)).toFixed(0)}MB cap) — skipping writes until consumer drains`,
					);
				}
				return false;
			}

			socket.write(data);
			sentTo.add(socket);
			return true;
		} catch (error) {
			this.logger.warn(
				`Failed to send data to client (topic: ${topic}): ${error}`,
			);
			this.removeClient(socket);
		}

		return false;
	}

	private replayRetainedDeviceSchema(
		socket: net.Socket,
		subscription: ClientSubscription,
	): void {
		if (this.retainedDeviceSchema.size === 0) {
			return;
		}

		const topics =
			subscription.topics.size > 0
				? subscription.topics
				: this.retainedDeviceSchema.keys();

		const sentTo = new Set<net.Socket>();
		for (const topic of topics) {
			const byDevice = this.retainedDeviceSchema.get(topic);
			if (!byDevice) {
				continue;
			}
			for (const payload of byDevice.values()) {
				const data = JSON.stringify(payload) + this.config.delimiter;
				this.sendToSocket(socket, data, topic, sentTo);
			}
		}
	}

	getClientCount(): number {
		return this.subscriptions.size;
	}

	getSubscriptionStats(): { totalClients: number; topicCounts: Record<string, number> } {
		const topicCounts: Record<string, number> = {};

		this.subscriptions.forEach(({ topics }) => {
			if (topics.size === 0) {
				topicCounts["*"] = (topicCounts["*"] || 0) + 1;
			} else {
				topics.forEach((topic) => {
					topicCounts[topic] = (topicCounts[topic] || 0) + 1;
				});
			}
		});

		return {
			totalClients: this.subscriptions.size,
			topicCounts,
		};
	}

	isRunning(): boolean {
		return this.started;
	}

	private handleClientConnection(socket: net.Socket): void {
		const totalPending = this.subscriptions.size + this.pendingSubscriptions.size;
		if (totalPending >= this.MAX_CLIENTS) {
			this.logger.warn(
				`Rejected IPC client (max ${this.MAX_CLIENTS} clients reached) at ${this.config.socketPath}`,
			);
			socket.destroy();
			return;
		}

		const subscription: ClientSubscription = {
			socket,
			topics: new Set(),
			rules: this.getDefaultRoutingRules(),
			lastSentAt: 0,
		};

		this.pendingSubscriptions.add(socket);
		let subscriptionReceived = false;
		let subscriptionBuffer = "";
		let timeoutHandle: NodeJS.Timeout | null = null;

		const handleSubscriptionMessage = (chunk: Buffer) => {
			if (subscriptionBuffer.length + chunk.length > this.MAX_SUBSCRIPTION_BUFFER) {
				this.logger.warn("Client subscription buffer exceeded limit — disconnecting");
				if (timeoutHandle) clearTimeout(timeoutHandle);
				socket.destroy();
				this.removeClient(socket);
				return;
			}
			subscriptionBuffer += chunk.toString("utf-8");
			const lines = subscriptionBuffer.split("\n");
			for (let i = 0; i < lines.length - 1; i++) {
				const line = lines[i].trim();
				if (!line) continue;

				try {
					const msg = JSON.parse(line);

					if (msg.subscribe && Array.isArray(msg.subscribe)) {
						this.unsubscribeAll(socket, subscription);
						subscription.rules = this.parseRoutingRules(msg.route);

						if (msg.subscribe.length > 0) {
							this.wildcardSockets.delete(socket);
							subscription.topics = new Set(msg.subscribe);
							for (const topic of msg.subscribe) {
								if (!this.topicToSockets.has(topic)) {
									this.topicToSockets.set(topic, new Set());
								}
								this.topicToSockets.get(topic)!.add(socket);
							}
							
							this.logger.debug(
								`Client subscribed to topics: ${Array.from(subscription.topics).join(", ")}`,
							);
						} else {
							this.wildcardSockets.add(socket);
							subscription.topics.clear();
							
							this.logger.debug("Client subscribed to all topics");
						}

						subscriptionReceived = true;
						if (timeoutHandle) {
							clearTimeout(timeoutHandle);
							timeoutHandle = null;
						}
						if (this.pendingSubscriptions.has(socket)) {
							this.pendingSubscriptions.delete(socket);
							this.subscriptions.set(socket, subscription);
						}

						try {
							socket.write(
								JSON.stringify({
									ok: true,
									subscribed_to:
										subscription.topics.size > 0
											? Array.from(subscription.topics)
											: ["*"],
									routing: this.getSerializableRules(subscription.rules),
								}) + this.config.delimiter,
							);
						} catch (_ackError) {
							// Non-fatal: subscription is already active.
						}

						this.replayRetainedDeviceSchema(socket, subscription);

						break;
					}
				} catch (_parseError) {
					// Not valid JSON yet, wait for more data
				}
			}

			subscriptionBuffer = lines[lines.length - 1];
		};

		timeoutHandle = setTimeout(() => {
			if (!subscriptionReceived) {
				this.logger.warn(
					`Client subscription timeout (expected JSON: {"subscribe": ["modbus"]})`,
				);
				socket.destroy();
				this.removeClient(socket);
			}
		}, this.SUBSCRIPTION_TIMEOUT_MS);

		socket.on("data", handleSubscriptionMessage);

		socket.once("error", (error) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			this.logger.warn(`Client socket error during subscription: ${error.message}`);
			this.removeClient(socket);
		});

		socket.once("close", () => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			this.removeClient(socket);
		});
	}

	private unsubscribeAll(
		socket: net.Socket,
		subscription: ClientSubscription,
	): void {
		this.wildcardSockets.delete(socket);
		subscription.topics.forEach((topic) => {
			const sockets = this.topicToSockets.get(topic);
			if (sockets) {
				sockets.delete(socket);
				if (sockets.size === 0) {
					this.topicToSockets.delete(topic);
				}
			}
		});

		subscription.topics.clear();
	}

	private removeClient(socket: net.Socket): void {
		if (this.pendingSubscriptions.has(socket)) {
			this.pendingSubscriptions.delete(socket);
			try {
				socket.destroy();
			} catch (_error) {
				// Ignore errors when destroying socket
			}
			return;
		}

		// Check if socket is in active subscriptions
		const subscription = this.subscriptions.get(socket);
		if (subscription) {
			this.subscriptions.delete(socket);
			if (subscription.topics.size === 0) {
				this.wildcardSockets.delete(socket);
			} else {
				subscription.topics.forEach((topic) => {
					const sockets = this.topicToSockets.get(topic);
					if (sockets) {
						sockets.delete(socket);
						if (sockets.size === 0) {
							this.topicToSockets.delete(topic);
						}
					}
				});
			}

			try {
				socket.destroy();
			} catch (_error) {
				// Ignore errors when destroying socket
			}
		}
	}

	private getDefaultRoutingRules(): ClientRoutingRules {
		return {
			includeMetrics: new Set(),
			excludeMetrics: new Set(),
			includeDevices: new Set(),
			excludeDevices: new Set(),
			allowedQualities: new Set(["GOOD", "BAD", "UNCERTAIN"]),
			minIntervalMs: 0,
			maxPointsPerMessage: 0,
		};
	}

	private parseRoutingRules(route: unknown): ClientRoutingRules {
		const rules = this.getDefaultRoutingRules();

		if (!route || typeof route !== "object") {
			return rules;
		}

		const candidate = route as {
			includeMetrics?: unknown;
			excludeMetrics?: unknown;
			includeDevices?: unknown;
			excludeDevices?: unknown;
			qualities?: unknown;
			minIntervalMs?: unknown;
			maxPointsPerMessage?: unknown;
		};

		rules.includeMetrics = this.asStringSet(candidate.includeMetrics);
		rules.excludeMetrics = this.asStringSet(candidate.excludeMetrics);
		rules.includeDevices = this.asStringSet(candidate.includeDevices);
		rules.excludeDevices = this.asStringSet(candidate.excludeDevices);

		if (Array.isArray(candidate.qualities)) {
			const qualitySet = new Set<"GOOD" | "BAD" | "UNCERTAIN">();
			for (const value of candidate.qualities) {
				if (value === "GOOD" || value === "BAD" || value === "UNCERTAIN") {
					qualitySet.add(value);
				}
			}
			if (qualitySet.size > 0) {
				rules.allowedQualities = qualitySet;
			}
		}

		if (
			typeof candidate.minIntervalMs === "number" &&
			Number.isFinite(candidate.minIntervalMs)
		) {
			rules.minIntervalMs = Math.max(
				0,
				Math.min(Math.floor(candidate.minIntervalMs), this.MAX_MIN_INTERVAL_MS),
			);
		}

		if (
			typeof candidate.maxPointsPerMessage === "number" &&
			Number.isFinite(candidate.maxPointsPerMessage)
		) {
			rules.maxPointsPerMessage = Math.max(
				0,
				Math.min(
					Math.floor(candidate.maxPointsPerMessage),
					this.MAX_POINTS_PER_MESSAGE_LIMIT,
				),
			);
		}

		return rules;
	}

	private asStringSet(value: unknown): Set<string> {
		if (!Array.isArray(value)) {
			return new Set();
		}

		const result = new Set<string>();
		for (const item of value) {
			if (typeof item === "string" && item.trim().length > 0) {
				result.add(item.trim());
			}
		}

		return result;
	}

	private applyRoutingRules(
		subscription: ClientSubscription,
		dataPoints: DeviceDataPoint[],
	): DeviceDataPoint[] {
		const { rules } = subscription;

		if (
			rules.minIntervalMs > 0 &&
			subscription.lastSentAt > 0 &&
			Date.now() - subscription.lastSentAt < rules.minIntervalMs
		) {
			return [];
		}

		let filtered = dataPoints.filter((point) => {
			if (!rules.allowedQualities.has(point.quality)) {
				return false;
			}

			if (
				rules.includeMetrics.size > 0 &&
				!rules.includeMetrics.has(point.metric)
			) {
				return false;
			}

			if (rules.excludeMetrics.has(point.metric)) {
				return false;
			}

			if (
				rules.includeDevices.size > 0 &&
				!rules.includeDevices.has(point.deviceName)
			) {
				return false;
			}

			if (rules.excludeDevices.has(point.deviceName)) {
				return false;
			}

			return true;
		});

		if (
			rules.maxPointsPerMessage > 0 &&
			filtered.length > rules.maxPointsPerMessage
		) {
			filtered = filtered.slice(0, rules.maxPointsPerMessage);
		}

		return filtered;
	}

	private getSerializableRules(rules: ClientRoutingRules): Record<string, unknown> {
		return {
			includeMetrics: Array.from(rules.includeMetrics),
			excludeMetrics: Array.from(rules.excludeMetrics),
			includeDevices: Array.from(rules.includeDevices),
			excludeDevices: Array.from(rules.excludeDevices),
			qualities: Array.from(rules.allowedQualities),
			minIntervalMs: rules.minIntervalMs,
			maxPointsPerMessage: rules.maxPointsPerMessage,
		};
	}

	private formatData(dataPoints: DeviceDataPoint[]): string {
		if (this.config.dataFormat === "csv") {
			return this.formatAsCsv(dataPoints);
		} else {
			return this.formatAsJson(dataPoints);
		}
	}

	private formatAsJson(dataPoints: DeviceDataPoint[]): string {
		const timestamp = new Date().toISOString();

		const readings = dataPoints.map((point) => ({
			timestamp: point.timestamp,
			deviceName: point.deviceName,
			...(point.deviceId && { deviceId: point.deviceId }),
			...(point.endpoint_uuid && { endpoint_uuid: point.endpoint_uuid }),
			...(point.device_uuid && { device_uuid: point.device_uuid }),
			...(point.protocol && { protocol: point.protocol }),
			...(point.resolvedDisplayName && {
				resolvedDisplayName: point.resolvedDisplayName,
			}),
			...(point.deviceDisplayName && { deviceDisplayName: point.deviceDisplayName }),
			metric: point.metric,
			value: point.value,
			unit: point.unit,
			quality: point.quality,
			...(point.qualityCode && { qualityCode: point.qualityCode }),
			...(point.rawObjectName && { rawObjectName: point.rawObjectName }),
			...(point.rawPointName && { rawPointName: point.rawPointName }),
			...(point.normalizationName && {
				normalizationName: point.normalizationName,
			}),
			...(point.normalizationDeviceName && {
				normalizationDeviceName: point.normalizationDeviceName,
			}),
			...(point.sourceEndpointName && { sourceEndpointName: point.sourceEndpointName }),
			...(point.pointUuid && { pointUuid: point.pointUuid }),
			...(point.writable && { writable: true }),
		}));

		if (readings.length === 1) {
			return JSON.stringify(readings[0]);
		} else {
			return JSON.stringify({ timestamp, readings });
		}
	}

	private formatAsCsv(dataPoints: DeviceDataPoint[]): string {
		const rows: string[] = [];

		for (const point of dataPoints) {
			const row = [
				point.deviceName,
				point.metric,
				String(point.value),
				point.unit,
				point.quality,
				point.timestamp,
			].join(",");

			rows.push(row);
		}

		return rows.join("\n");
	}
}

export class WorkerBackedSocketServer implements ISocketServer {
	private worker: Worker;
	private logger: Logger;
	private ready = false;

	constructor(config: SocketOutput, logger: Logger) {
		this.logger = logger;
		this.worker = new Worker(path.join(__dirname, 'ipc-writer-worker.js'), {
			workerData: { config },
		});
		this.worker.on('message', (msg: { type: string; level?: string; msg?: string; error?: string }) => {
			if (msg.type === 'ready') {
				this.ready = true;
			} else if (msg.type === 'log' && msg.level && msg.msg) {
				const logFn = this.logger[msg.level as keyof Logger];
				if (typeof logFn === 'function') (logFn as (m: string) => void).call(this.logger, `[IPC-Worker] ${msg.msg}`);
			} else if (msg.type === 'error') {
				this.logger.error(`[IPC-Worker] startup error: ${msg.error}`);
			}
		});
		this.worker.on('error', (err) => {
			this.logger.error(`[IPC-Worker] worker error: ${err.message}`);
		});
		this.worker.on('exit', (code) => {
			if (code !== 0) this.logger.error(`[IPC-Worker] worker exited with code ${code}`);
			this.ready = false;
		});
	}

	async start(): Promise<void> {
		if (this.ready) return;
		await new Promise<void>((resolve, reject) => {
			const onMessage = (msg: { type: string; error?: string }) => {
				if (msg.type === 'ready') {
					this.worker.off('message', onMessage);
					resolve();
				} else if (msg.type === 'error') {
					this.worker.off('message', onMessage);
					reject(new Error(msg.error));
				}
			};
			this.worker.on('message', onMessage);
		});
	}

	sendData(dataPoints: DeviceDataPoint[], topic?: string): void {
		if (!this.ready) return;
		this.worker.postMessage({ type: 'data', points: dataPoints, topic });
	}

	sendControl(payload: Record<string, unknown>, topic?: string): void {
		if (!this.ready) return;
		this.worker.postMessage({ type: 'control', payload, topic });
	}

	async stop(): Promise<void> {
		if (!this.ready) return;
		this.worker.postMessage({ type: 'stop' });
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.worker.terminate();
				resolve();
			}, 5000);
			this.worker.on('exit', () => {
				clearTimeout(timeout);
				resolve();
			});
		});
		this.ready = false;
	}
}
