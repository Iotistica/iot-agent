import type { CapturedPacket } from './capture.js';

export type FlowId = string;

export interface TcpStreamHandler {
	onData(flowId: FlowId, data: Buffer, packetId: number): void;
	onGap(flowId: FlowId, expectedSeq: number, gotSeq: number): void;
	onClose(flowId: FlowId): void;
}

export interface TcpAssemblerOptions {
	maxFlows?: number;
	inactivityTimeout?: number;
}

interface FlowState {
	nextSeq: number;
	lastSeen: number;
	initialized: boolean;
	protocolName: string;
}

const TCP_SYN = 0x02;
const TCP_FIN = 0x01;
const TCP_RST = 0x04;

export class TcpAssembler {
	private flows = new Map<FlowId, FlowState>();
	private handler: TcpStreamHandler;
	private maxFlows: number;
	private inactivityTimeout: number;

	constructor(handler: TcpStreamHandler, opts?: TcpAssemblerOptions) {
		this.handler = handler;
		this.maxFlows = opts?.maxFlows ?? 500;
		this.inactivityTimeout = opts?.inactivityTimeout ?? 60_000;
	}

	get flowCount(): number { return this.flows.size; }

	feed(packet: CapturedPacket): void {
		if (packet.ipProtocol !== 6) return;
		if (packet.tcpSeq === null || packet.tcpFlags === null) return;
		if (packet.srcPort === null || packet.dstPort === null) return;

		const flowId: FlowId = `${packet.srcIp}:${packet.srcPort}-${packet.dstIp}:${packet.dstPort}`;
		const seq = packet.tcpSeq;
		const flags = packet.tcpFlags;
		const payload = packet.appPayload;
		const hasData = payload !== null && payload.length > 0;

		if (flags & TCP_RST) {
			if (this.flows.has(flowId)) {
				this.flows.delete(flowId);
				this.handler.onClose(flowId);
			}
			return;
		}

		if (flags & TCP_SYN) {
			this.evictIfNeeded();
			this.flows.set(flowId, {
				nextSeq: (seq + 1) >>> 0,
				lastSeen: packet.timestamp,
				initialized: true,
				protocolName: packet.protocolName,
			});
			return;
		}

		if (flags & TCP_FIN) {
			if (hasData) {
				this.deliverData(flowId, seq, payload, packet);
			}
			if (this.flows.has(flowId)) {
				this.flows.delete(flowId);
				this.handler.onClose(flowId);
			}
			return;
		}

		if (!hasData) return;

		this.deliverData(flowId, seq, payload, packet);
	}

	private deliverData(flowId: FlowId, seq: number, payload: Buffer, packet: CapturedPacket): void {
		let flow = this.flows.get(flowId);

		if (!flow) {
			this.evictIfNeeded();
			flow = {
				nextSeq: (seq + payload.length) >>> 0,
				lastSeen: packet.timestamp,
				initialized: true,
				protocolName: packet.protocolName,
			};
			this.flows.set(flowId, flow);
			this.handler.onData(flowId, payload, packet.id);
			return;
		}

		flow.lastSeen = packet.timestamp;

		if (seq === flow.nextSeq) {
			flow.nextSeq = (seq + payload.length) >>> 0;
			this.handler.onData(flowId, payload, packet.id);
		} else if (this.seqAfter(seq, flow.nextSeq)) {
			this.handler.onGap(flowId, flow.nextSeq, seq);
			flow.nextSeq = (seq + payload.length) >>> 0;
			this.handler.onData(flowId, payload, packet.id);
		}
		// seq < nextSeq → retransmit/duplicate, ignore
	}

	private seqAfter(a: number, b: number): boolean {
		return ((a - b) & 0x7FFFFFFF) > 0 && ((a - b) & 0x7FFFFFFF) < 0x40000000;
	}

	cleanup(now: number): void {
		for (const [flowId, flow] of this.flows) {
			if (now - flow.lastSeen > this.inactivityTimeout) {
				this.flows.delete(flowId);
				this.handler.onClose(flowId);
			}
		}
	}

	reset(): void {
		this.flows.clear();
	}

	private evictIfNeeded(): void {
		if (this.flows.size < this.maxFlows) return;
		let oldest: FlowId | null = null;
		let oldestTime = Infinity;
		for (const [fid, flow] of this.flows) {
			if (flow.lastSeen < oldestTime) {
				oldestTime = flow.lastSeen;
				oldest = fid;
			}
		}
		if (oldest) {
			this.flows.delete(oldest);
			this.handler.onClose(oldest);
		}
	}
}
