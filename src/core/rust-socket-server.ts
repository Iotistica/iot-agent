import * as path from "path";
import type { DeviceDataPoint, SocketOutput, Logger } from "../plugins/types.js";
import type { ISocketServer } from "./socket-server.js";

interface NativeIpcBinding {
	NativeIpcServer: new (
		socketPath: string,
		delimiter: string,
		label?: string,
	) => NativeIpcInstance;
}

interface NativeIpcInstance {
	start(): void;
	send(data: string): boolean;
	sendBatch(data: Buffer): boolean;
	getClientCount(): number;
	isRunning(): boolean;
	getStats(): string;
	getQueuedBytes(): number;
	getEvictionStats(): string;
	stop(): void;
}

let nativeBinding: NativeIpcBinding | null = null;

function loadNativeBinding(): NativeIpcBinding {
	if (nativeBinding) return nativeBinding;

	const candidates = [
		path.join(__dirname, "..", "..", "modules", "ipc", "ipc.node"),
	];

	for (const candidate of candidates) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			nativeBinding = require(candidate) as NativeIpcBinding;
			return nativeBinding;
		} catch {
			continue;
		}
	}

	throw new Error(
		`Failed to load ipc addon. Searched:\n  ${candidates.join("\n  ")}`,
	);
}

function writeStr(buf: Buffer, s: string, off: number): number {
	const len = Buffer.byteLength(s, "utf8");
	buf.writeUInt16LE(len, off);
	off += 2;
	buf.write(s, off, len, "utf8");
	return off + len;
}

const BACKPRESSURE_BYTES_THRESHOLD = 32 * 1024 * 1024; // 32MB

export class RustSocketServer implements ISocketServer {
	private native: NativeIpcInstance;
	private config: SocketOutput;
	private logger: Logger;
	private started = false;
	private encodeBuf: Buffer | null = null;
	private consecutiveBackpressure = 0;
	private totalDropped = 0;
	private lastBackpressureLogAt = 0;

	constructor(config: SocketOutput, logger: Logger, label?: string) {
		this.config = config;
		this.logger = logger;
		const binding = loadNativeBinding();
		this.native = new binding.NativeIpcServer(
			config.socketPath,
			config.delimiter || "\n",
			label,
		);
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.native.start();
		this.started = true;
		this.logger.info(
			`[ipc] Rust IPC server started at ${this.config.socketPath}`,
		);
	}

	sendData(dataPoints: DeviceDataPoint[], topic?: string): void {
		if (!this.started) return;
		const batch = this.encodeBatch(dataPoints);
		if (!this.native.sendBatch(batch)) {
			this.consecutiveBackpressure++;
			this.totalDropped += dataPoints.length;
			const now = Date.now();
			if (now - this.lastBackpressureLogAt >= 5000) {
				this.logger.warn(
					`[ipc] Backpressure — batch dropped (${dataPoints.length} pts, topic=${topic ?? "generic"}, consecutive=${this.consecutiveBackpressure}, total_dropped=${this.totalDropped}, queued=${(this.native.getQueuedBytes() / 1_048_576).toFixed(1)}MB)`,
				);
				this.lastBackpressureLogAt = now;
			}
		} else {
			if (this.consecutiveBackpressure > 0) {
				this.logger.debug(
					`[ipc] Backpressure resolved after ${this.consecutiveBackpressure} consecutive drops (${this.totalDropped} pts total)`,
				);
				this.consecutiveBackpressure = 0;
			}
		}
	}

	isBackpressured(): boolean {
		if (!this.started) return false;
		return this.native.getQueuedBytes() > BACKPRESSURE_BYTES_THRESHOLD;
	}

	sendControl(payload: Record<string, unknown>, _topic?: string): void {
		if (!this.started) return;
		const json = JSON.stringify(payload);
		this.native.send(json);
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.native.stop();
		this.started = false;
		this.logger.info("[ipc] Rust IPC server stopped");
	}

	isRunning(): boolean {
		return this.native.isRunning();
	}

	getClientCount(): number {
		return this.native.getClientCount();
	}

	getStats(): string {
		return this.native.getStats();
	}

	/**
	 * Encode data points into binary format v1 for Rust-side JSON serialization.
	 * See ipc/src/lib.rs decode_batch_to_json() for the wire format.
	 */
	private encodeBatch(dataPoints: DeviceDataPoint[]): Buffer {
		const batchTimestamp = new Date().toISOString();
		const bufSize = 64 + dataPoints.length * 2048;
		if (!this.encodeBuf || this.encodeBuf.length < bufSize) {
			this.encodeBuf = Buffer.allocUnsafe(bufSize);
		}
		const buf = this.encodeBuf;
		let off = 0;

		buf[off++] = 1; // format version
		buf.writeUInt32LE(dataPoints.length, off);
		off += 4;
		off = writeStr(buf, batchTimestamp, off);

		for (const pt of dataPoints) {
			let mask = 0;
			if (pt.deviceId) mask |= 1;
			if (pt.endpoint_uuid) mask |= 1 << 1;
			if (pt.device_uuid) mask |= 1 << 2;
			if (pt.protocol) mask |= 1 << 3;
			if (pt.resolvedDisplayName) mask |= 1 << 4;
			if (pt.deviceDisplayName) mask |= 1 << 5;
			if (pt.qualityCode) mask |= 1 << 6;
			if (pt.rawObjectName) mask |= 1 << 7;
			if (pt.rawPointName) mask |= 1 << 8;
			if (pt.normalizationName) mask |= 1 << 9;
			if (pt.normalizationDeviceName) mask |= 1 << 10;
			if (pt.sourceEndpointName) mask |= 1 << 11;
			if (pt.pointUuid) mask |= 1 << 12;
			if (pt.writable) mask |= 1 << 13;
			if (pt.unit != null) mask |= 1 << 14;

			buf.writeUInt32LE(mask, off);
			off += 4;
			off = writeStr(buf, pt.timestamp, off);
			off = writeStr(buf, pt.deviceName, off);

			if (mask & 1) off = writeStr(buf, pt.deviceId!, off);
			if (mask & (1 << 1)) off = writeStr(buf, pt.endpoint_uuid!, off);
			if (mask & (1 << 2)) off = writeStr(buf, pt.device_uuid!, off);
			if (mask & (1 << 3)) off = writeStr(buf, pt.protocol!, off);
			if (mask & (1 << 4))
				off = writeStr(buf, pt.resolvedDisplayName!, off);
			if (mask & (1 << 5))
				off = writeStr(buf, pt.deviceDisplayName!, off);

			off = writeStr(buf, pt.metric, off);

			const v = pt.value;
			if (v === null || v === undefined) {
				buf[off++] = 0;
			} else if (typeof v === "number") {
				buf[off++] = 1;
				buf.writeDoubleLE(v, off);
				off += 8;
			} else if (typeof v === "boolean") {
				buf[off++] = v ? 2 : 3;
			} else {
				buf[off++] = 4;
				off = writeStr(buf, String(v), off);
			}

			if (mask & (1 << 14)) off = writeStr(buf, pt.unit!, off);

			buf[off++] =
				pt.quality === "GOOD" ? 0 : pt.quality === "BAD" ? 1 : 2;

			if (mask & (1 << 6)) off = writeStr(buf, pt.qualityCode!, off);
			if (mask & (1 << 7)) off = writeStr(buf, pt.rawObjectName!, off);
			if (mask & (1 << 8)) off = writeStr(buf, pt.rawPointName!, off);
			if (mask & (1 << 9))
				off = writeStr(buf, pt.normalizationName!, off);
			if (mask & (1 << 10))
				off = writeStr(buf, pt.normalizationDeviceName!, off);
			if (mask & (1 << 11))
				off = writeStr(buf, pt.sourceEndpointName!, off);
			if (mask & (1 << 12)) off = writeStr(buf, pt.pointUuid!, off);
		}

		return buf.subarray(0, off);
	}
}
