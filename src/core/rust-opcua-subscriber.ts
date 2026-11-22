import * as path from "path";
import type { Logger } from "../plugins/types.js";
import type { ISocketServer } from "./socket-server.js";

interface SubscriberConfig {
	endpointUrl: string;
	securityMode?: string;
	securityPolicy?: string;
	username?: string;
	password?: string;
	applicationName?: string;
	sessionTimeoutMs?: number;
	certificateTrustMode?: string;
}

interface NodeConfig {
	nodeId: string;
	deviceName: string;
	metric: string;
	deviceId?: string;
	endpointUuid?: string;
	deviceUuid?: string;
	protocol?: string;
	resolvedDisplayName?: string;
	deviceDisplayName?: string;
	sourceEndpointName?: string;
	pointUuid?: string;
	unit?: string;
	writable?: boolean;
	rawObjectName?: string;
	rawPointName?: string;
	normalizationName?: string;
	normalizationDeviceName?: string;
}

interface NativeSubscriberBinding {
	OpcuaSubscriber: new (config: {
		endpointUrl: string;
		securityMode?: string;
		securityPolicy?: string;
		username?: string;
		password?: string;
		applicationName?: string;
		sessionTimeoutMs?: number;
		certificateTrustMode?: string;
	}) => NativeSubscriberInstance;
}

interface NativeSubscriberInstance {
	connect(): Promise<void>;
	subscribe(
		nodes: Array<{
			nodeId: string;
			deviceName: string;
			metric: string;
			deviceId?: string;
			endpointUuid?: string;
			deviceUuid?: string;
			protocol?: string;
			resolvedDisplayName?: string;
			deviceDisplayName?: string;
			sourceEndpointName?: string;
			pointUuid?: string;
			unit?: string;
			writable?: boolean;
			rawObjectName?: string;
			rawPointName?: string;
			normalizationName?: string;
			normalizationDeviceName?: string;
		}>,
		publishingIntervalMs: number,
		samplingIntervalMs: number,
		onData: (batch: Buffer) => void,
	): Promise<void>;
	disconnect(): Promise<void>;
	isConnected(): boolean;
	getStats(): string;
	getSubscribedCount(): number;
	getDataChangeCount(): number;
}

let nativeBinding: NativeSubscriberBinding | null = null;

function loadNativeBinding(): NativeSubscriberBinding {
	if (nativeBinding) return nativeBinding;

	const candidates = [
		path.join(__dirname, "..", "opcua-subscriber", "opcua-subscriber.node"),
		path.join(__dirname, "..", "..", "opcua-subscriber", "opcua-subscriber.node"),
		path.join(__dirname, "..", "opcua-subscriber.node"),
	];

	for (const candidate of candidates) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			nativeBinding = require(candidate) as NativeSubscriberBinding;
			return nativeBinding;
		} catch {
			continue;
		}
	}

	throw new Error(
		`Failed to load opcua-subscriber addon. Searched:\n  ${candidates.join("\n  ")}`,
	);
}

export class RustOpcuaSubscriber {
	private native: NativeSubscriberInstance;
	private ipcServer: ISocketServer | null = null;
	private logger: Logger;
	private batchesForwarded = 0;
	private bytesForwarded = 0;
	private forwardErrors = 0;
	private lastStatsLogAt = 0;
	private statsInterval: ReturnType<typeof setInterval> | null = null;

	constructor(config: SubscriberConfig, logger: Logger) {
		this.logger = logger;
		const binding = loadNativeBinding();
		this.native = new binding.OpcuaSubscriber({
			endpointUrl: config.endpointUrl,
			securityMode: config.securityMode,
			securityPolicy: config.securityPolicy,
			username: config.username,
			password: config.password,
			applicationName: config.applicationName,
			sessionTimeoutMs: config.sessionTimeoutMs,
			certificateTrustMode: config.certificateTrustMode,
		});
		this.logger.info(`[opcua-rust] Subscriber wrapper created for ${config.endpointUrl}`);
	}

	setIpcServer(server: ISocketServer): void {
		this.ipcServer = server;
	}

	async connect(): Promise<void> {
		this.logger.info("[opcua-rust] Connecting...");
		await this.native.connect();
		this.logger.info("[opcua-rust] Connected");
		this.startStatsReporter();
	}

	async subscribe(
		nodes: NodeConfig[],
		publishingIntervalMs: number,
		samplingIntervalMs: number,
	): Promise<void> {
		this.logger.info(
			`[opcua-rust] Subscribing to ${nodes.length} nodes (pub=${publishingIntervalMs}ms, sample=${samplingIntervalMs}ms)`,
		);

		const nativeNodes = nodes.map((n) => ({
			nodeId: n.nodeId,
			deviceName: n.deviceName,
			metric: n.metric,
			deviceId: n.deviceId,
			endpointUuid: n.endpointUuid,
			deviceUuid: n.deviceUuid,
			protocol: n.protocol ?? "opcua",
			resolvedDisplayName: n.resolvedDisplayName,
			deviceDisplayName: n.deviceDisplayName,
			sourceEndpointName: n.sourceEndpointName,
			pointUuid: n.pointUuid,
			unit: n.unit,
			writable: n.writable,
			rawObjectName: n.rawObjectName,
			rawPointName: n.rawPointName,
			normalizationName: n.normalizationName,
			normalizationDeviceName: n.normalizationDeviceName,
		}));

		await this.native.subscribe(
			nativeNodes,
			publishingIntervalMs,
			samplingIntervalMs,
			(batch: Buffer) => {
				this.batchesForwarded++;
				this.bytesForwarded += batch.length;

				if (this.ipcServer) {
					const server = this.ipcServer as any;
					if (typeof server.native?.sendBatch === "function") {
						if (!server.native.sendBatch(batch)) {
							this.forwardErrors++;
							if (this.forwardErrors === 1 || this.forwardErrors % 100 === 0) {
								this.logger.warn(
									`[opcua-rust] IPC backpressure — batch dropped (${batch.length} bytes, errors=${this.forwardErrors})`,
								);
							}
						}
					} else {
						this.forwardErrors++;
						if (this.forwardErrors <= 3) {
							this.logger.warn(
								"[opcua-rust] IPC server does not support sendBatch — data lost",
							);
						}
					}
				}
			},
		);

		this.logger.info(
			`[opcua-rust] Subscribed: ${this.native.getSubscribedCount()} nodes active`,
		);
	}

	async disconnect(): Promise<void> {
		this.stopStatsReporter();
		this.logger.info("[opcua-rust] Disconnecting...");
		await this.native.disconnect();
		this.logger.info("[opcua-rust] Disconnected");
	}

	isConnected(): boolean {
		return this.native.isConnected();
	}

	getStats(): {
		native: string;
		batchesForwarded: number;
		bytesForwardedMB: string;
		forwardErrors: number;
	} {
		return {
			native: this.native.getStats(),
			batchesForwarded: this.batchesForwarded,
			bytesForwardedMB: (this.bytesForwarded / 1_048_576).toFixed(1),
			forwardErrors: this.forwardErrors,
		};
	}

	private startStatsReporter(): void {
		this.statsInterval = setInterval(() => {
			if (!this.native.isConnected()) return;
			const stats = this.native.getStats();
			this.logger.debug(
				`[opcua-rust] stats: ${stats} | fwd_batches=${this.batchesForwarded} fwd_mb=${(this.bytesForwarded / 1_048_576).toFixed(1)} fwd_errors=${this.forwardErrors}`,
			);
		}, 30_000);
	}

	private stopStatsReporter(): void {
		if (this.statsInterval) {
			clearInterval(this.statsInterval);
			this.statsInterval = null;
		}
	}
}

export function isRustOpcuaAvailable(): boolean {
	try {
		loadNativeBinding();
		return true;
	} catch {
		return false;
	}
}
