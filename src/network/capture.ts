import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { exec } from '../lib/fs-utils.js';
import { getNetworkInterfaces } from '../system/interfaces.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';
import { TcpAssembler, type FlowId, type TcpStreamHandler } from './tcp-assembler.js';
import type { ProtocolFramer, FramedMessage } from './framers/index.js';
import { OpcUaFramer } from './framers/opcua.js';
import { getDecoderRegistry, type PacketMeta, type DecodedPacket } from './decoders/index.js';

// ── Data model ─────────────────────────────────────────────────────────────

export interface CapturedPacket {
	id: number;
	timestamp: number;
	length: number;
	capturedLength: number;
	rawPcap: Buffer;
	/** Original capture format, used to prevent invalid mixed-linktype PCAP exports. */
	pcapLinkType?: number;
	pcapGlobalHeader?: Buffer;
	appPayload: Buffer | null;
	srcIp: string;
	dstIp: string;
	srcPort: number | null;
	dstPort: number | null;
	ipProtocol: number;
	protocolName: string;
	direction: 'inbound' | 'outbound' | 'unknown';
	info: string;
	tcpSeq: number | null;
	tcpFlags: number | null;
	reassembledDecoded?: DecodedPacket;
}

export interface CaptureStatus {
	running: boolean;
	sessionId: string | null;
	startedAt: string | null;
	counters: {
		seen: number;
		stored: number;
		dropped: number;
		inbound: number;
		outbound: number;
		bytes: number;
	};
	iface: string;
	filter: string | null;
}

export interface CaptureFilter {
	direction?: 'inbound' | 'outbound';
	protocol?: string;
	srcIp?: string;
	dstIp?: string;
	port?: number;
	search?: string;
}

export interface CaptureStartOptions {
	filter?: string;
	maxPackets?: number;
	iface?: string;
}

export class CaptureInterfaceError extends Error {
	constructor(iface: string) {
		super(`Network interface is not available: ${iface}`);
		this.name = 'CaptureInterfaceError';
	}
}

// ── Well-known port → application protocol ─────────────────────────────────

const WELL_KNOWN_PORTS: Record<number, string> = {
	20: 'FTP-Data', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP',
	53: 'DNS', 67: 'DHCP', 68: 'DHCP', 80: 'HTTP', 110: 'POP3',
	123: 'NTP', 5353: 'mDNS', 143: 'IMAP', 443: 'HTTPS', 502: 'Modbus/TCP',
	993: 'IMAPS', 995: 'POP3S', 1883: 'MQTT', 3306: 'MySQL',
	4840: 'OPC-UA', 5432: 'PostgreSQL', 5672: 'AMQP', 6379: 'Redis',
	8080: 'HTTP-Alt', 8443: 'HTTPS-Alt', 8883: 'MQTT/TLS',
	27017: 'MongoDB', 47808: 'BACnet/IP',
};

const IP_PROTOCOL_NAMES: Record<number, string> = {
	1: 'ICMP', 2: 'IGMP', 6: 'TCP', 17: 'UDP', 41: 'IPv6', 47: 'GRE', 50: 'ESP', 58: 'ICMPv6', 0: 'HOPOPT',
};

// ── CaptureEngine ──────────────────────────────────────────────────────────

export class CaptureEngine extends EventEmitter {
	private logger: AgentLogger;
	private _available = false;
	private state: 'idle' | 'starting' | 'running' | 'stopping' = 'idle';
	private proc: ChildProcess | null = null;
	private lifecycleQueue: Promise<void> = Promise.resolve();
	private sessionId: string | null = null;
	private startedAt: string | null = null;

	private packets: CapturedPacket[] = [];
	private maxPackets = 10_000;
	private nextId = 1;

	private counters = { seen: 0, stored: 0, dropped: 0, inbound: 0, outbound: 0, bytes: 0 };

	private captureIface = 'any';
	private captureFilter: string | null = null;
	private localIps = new Set<string>();

	// pcap stream parsing state
	private pcapBuf = Buffer.alloc(0);
	private pcapGlobalHeader: Buffer | null = null;
	private linkLayerSize = 0; // bytes to skip for link-layer header
	private linkType = 0;
	private pcapBigEndian = false;
	private tcpdumpPath = 'tcpdump';

	// TCP stream reassembly
	private tcpAssembler: TcpAssembler | null = null;
	private framers = new Map<FlowId, ProtocolFramer>();
	private flowProtocols = new Map<FlowId, string>();
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	constructor(logger: AgentLogger) {
		super();
		this.logger = logger;
	}

	get available(): boolean { return this._available; }

	// ── Lifecycle ───────────────────────────────────────────────────────────

	async checkAvailability(): Promise<boolean> {
		try {
			// Resolve full path so spawn works even with limited systemd PATH
			const { stdout: whichOut } = await exec('which tcpdump');
			this.tcpdumpPath = whichOut.trim() || 'tcpdump';
			await exec(`${this.tcpdumpPath} --version`);
			this._available = true;
			this.logger.infoSync(`tcpdump found at ${this.tcpdumpPath}`, {
				component: LogComponents.capture,
			});
		} catch {
			this._available = false;
			this.logger.warnSync('tcpdump not available — packet capture disabled', {
				component: LogComponents.capture,
			});
		}
		return this._available;
	}

	start(options?: CaptureStartOptions): Promise<CaptureStatus> {
		return this.enqueueLifecycle(() => this.startCapture(options));
	}

	stop(): Promise<CaptureStatus> {
		return this.enqueueLifecycle(() => this.stopCapture());
	}

	switchInterface(options: CaptureStartOptions): Promise<CaptureStatus> {
		return this.enqueueLifecycle(async () => {
			if (this.state !== 'running') throw new Error('Capture is not running');

			const previousIface = this.captureIface;
			const previousFilter = this.captureFilter;
			const nextIface = await this.validateInterface(options.iface);
			if (nextIface === previousIface) return this.getStatus();

			await this.stopCapture();
			try {
				return await this.startCapture({
					...options,
					iface: nextIface,
					filter: previousFilter ?? undefined,
					maxPackets: options.maxPackets ?? this.maxPackets,
				}, true);
			} catch (switchError) {
				try {
					await this.startCapture({
						iface: previousIface,
						filter: previousFilter ?? undefined,
						maxPackets: this.maxPackets,
					}, true);
				} catch (restoreError) {
					throw new AggregateError(
						[switchError, restoreError],
						'Interface switch failed and the previous capture could not be restarted'
					);
				}
				throw switchError;
			}
		});
	}

	private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.lifecycleQueue.then(operation);
		this.lifecycleQueue = result.then(() => undefined, () => undefined);
		return result;
	}

	private async validateInterface(requested?: string): Promise<string> {
		const iface = requested || 'any';
		if (iface === 'any') return iface;
		const hasControlCharacters = Array.from(iface).some((character) => {
			const code = character.charCodeAt(0);
			return code <= 0x1f || code === 0x7f;
		});
		if (iface.startsWith('-') || hasControlCharacters) {
			throw new CaptureInterfaceError(iface);
		}

		const interfaces = await getNetworkInterfaces();
		if (!interfaces.some((networkInterface) => networkInterface.name === iface)) {
			throw new CaptureInterfaceError(iface);
		}
		return iface;
	}

	private async startCapture(
		options?: CaptureStartOptions,
		preservePackets = false,
	): Promise<CaptureStatus> {
		if (this.state !== 'idle') throw new Error('Capture already running');
		if (!this._available) throw new Error('Capture not available');

		const iface = await this.validateInterface(options?.iface);
		this.maxPackets = options?.maxPackets ?? (preservePackets ? this.maxPackets : 10_000);
		this.captureIface = iface;
		this.captureFilter = options?.filter?.trim() || null;
		if (!preservePackets) {
			this.clear();
			this.nextId = 1;
		}

		this.sessionId = randomUUID();
		this.startedAt = new Date().toISOString();
		this.state = 'starting';
		this.pcapBuf = Buffer.alloc(0);
		this.pcapGlobalHeader = null;
		this.initReassembly();
		await this.resolveLocalIps();

		const args = ['-i', this.captureIface, '-U', '-w', '-', '-s', '65535'];
		if (this.captureFilter) args.push(...this.captureFilter.split(/\s+/));

		this.logger.infoSync(`Spawning: ${this.tcpdumpPath} ${args.join(' ')}`, {
			component: LogComponents.capture,
		});

		const proc = this.spawnCaptureProcess(args);
		this.proc = proc;
		proc.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
		proc.stderr?.on('data', (data: Buffer) => {
			const msg = data.toString().trim();
			if (msg) this.logger.infoSync(`tcpdump: ${msg}`, { component: LogComponents.capture });
		});
		proc.on('error', (err) => {
			this.logger.warnSync(`tcpdump process error: ${err.message}`, {
				component: LogComponents.capture,
			});
			if (this.proc === proc && this.state !== 'stopping') {
				this.state = 'idle';
				this.proc = null;
				this.teardownReassembly();
				this.emit('status-change', this.getStatus());
			}
		});
		proc.on('close', (code) => {
			this.logger.infoSync(`tcpdump exited with code ${code}`, {
				component: LogComponents.capture,
			});
			if (this.proc === proc && this.state !== 'stopping') {
				this.state = 'idle';
				this.proc = null;
				this.teardownReassembly();
				this.emit('status-change', this.getStatus());
			}
		});

		try {
			await new Promise<void>((resolve, reject) => {
				const onSpawn = () => {
					if (this.proc !== proc || this.state !== 'starting') {
						reject(new Error('Capture start was interrupted'));
						return;
					}
					this.state = 'running';
					resolve();
				};
				const onError = (error: Error) => reject(error);
				const onEarlyClose = (code: number | null) => {
					reject(new Error(`tcpdump exited before starting (code ${code ?? 'unknown'})`));
				};
				proc.once('spawn', onSpawn);
				proc.once('error', onError);
				proc.once('close', onEarlyClose);
				proc.once('spawn', () => proc.off('close', onEarlyClose));
			});
		} catch (error) {
			if (this.proc === proc) {
				this.proc = null;
				this.state = 'idle';
				this.teardownReassembly();
			}
			throw error;
		}

		this.logger.infoSync('Packet capture started', {
			component: LogComponents.capture,
			sessionId: this.sessionId,
			iface: this.captureIface,
			filter: this.captureFilter,
		});
		this.emit('status-change', this.getStatus());
		return this.getStatus();
	}

	private spawnCaptureProcess(args: string[]): ChildProcess {
		return spawn(this.tcpdumpPath, args);
	}

	private async stopCapture(): Promise<CaptureStatus> {
		if (this.state === 'idle') return this.getStatus();

		this.state = 'stopping';
		const proc = this.proc;
		if (proc) {
			proc.stdout?.removeAllListeners('data');
			proc.stderr?.removeAllListeners('data');
			await new Promise<void>((resolve) => {
				const killTimer = setTimeout(() => {
					if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
				}, 5_000);
				const onClose = () => {
					clearTimeout(killTimer);
					resolve();
				};
				proc.once('close', onClose);
				proc.kill('SIGINT');
			});
		}

		if (this.proc === proc) this.proc = null;
		this.pcapBuf = Buffer.alloc(0);
		this.teardownReassembly();
		this.state = 'idle';
		this.logger.infoSync('Packet capture stopped', {
			component: LogComponents.capture,
			sessionId: this.sessionId,
		});
		this.emit('status-change', this.getStatus());
		return this.getStatus();
	}

	clear(): void {
		this.packets = [];
		this.counters = { seen: 0, stored: 0, dropped: 0, inbound: 0, outbound: 0, bytes: 0 };
	}

	getStatus(): CaptureStatus {
		return {
			running: this.state === 'running',
			sessionId: this.sessionId,
			startedAt: this.startedAt,
			counters: { ...this.counters },
			iface: this.captureIface,
			filter: this.captureFilter,
		};
	}

	// ── Query ───────────────────────────────────────────────────────────────

	getPackets(filter?: CaptureFilter, offset = 0, limit = 50): { packets: CapturedPacket[]; total: number } {
		let result = this.packets;

		if (filter) {
			result = result.filter((p) => {
				if (filter.direction && p.direction !== filter.direction) return false;
				if (filter.protocol && p.protocolName.toLowerCase() !== filter.protocol.toLowerCase()) return false;
				if (filter.srcIp && !p.srcIp.includes(filter.srcIp)) return false;
				if (filter.dstIp && !p.dstIp.includes(filter.dstIp)) return false;
				if (filter.port != null && p.srcPort !== filter.port && p.dstPort !== filter.port) return false;
				if (filter.search) {
					const q = filter.search.toLowerCase();
					if (!p.info.toLowerCase().includes(q) && !p.protocolName.toLowerCase().includes(q)) return false;
				}
				return true;
			});
		}

		const total = result.length;
		const clamped = Math.min(limit, 250);
		return { packets: result.slice(offset, offset + clamped), total };
	}

	getPacket(id: number): CapturedPacket | undefined {
		return this.packets.find((p) => p.id === id);
	}

	exportPcap(): Buffer {
		if (!this.pcapGlobalHeader) {
			// Build a default global header (Ethernet, little-endian)
			const hdr = Buffer.alloc(24);
			hdr.writeUInt32LE(0xa1b2c3d4, 0); // magic
			hdr.writeUInt16LE(2, 4); // major
			hdr.writeUInt16LE(4, 6); // minor
			hdr.writeInt32LE(0, 8);  // thiszone
			hdr.writeUInt32LE(0, 12); // sigfigs
			hdr.writeUInt32LE(65535, 16); // snaplen
			hdr.writeUInt32LE(113, 20); // SLL link type
			return hdr;
		}

		// Classic PCAP has one global link-layer type. Retained packets can come
		// from different interfaces, so never silently write a corrupt mixed file.
		const first = this.packets[0];
		if (!first) return Buffer.from(this.pcapGlobalHeader);
		const linkType = first.pcapLinkType;
		if (this.packets.some((pkt) => pkt.pcapLinkType !== linkType)) {
			throw new Error('Cannot export packets with mixed link-layer types as classic PCAP; clear the capture or export each interface separately');
		}
		return Buffer.concat([first.pcapGlobalHeader ?? this.pcapGlobalHeader, ...this.packets.map((pkt) => pkt.rawPcap)]);
	}

	// ── Pcap stream parser ──────────────────────────────────────────────────

	private onData(chunk: Buffer): void {
		this.pcapBuf = Buffer.concat([this.pcapBuf, chunk]);

		// Read global header (24 bytes) first
		if (!this.pcapGlobalHeader) {
			if (this.pcapBuf.length < 24) return;
			this.pcapGlobalHeader = Buffer.from(this.pcapBuf.subarray(0, 24));
			const magic = this.pcapGlobalHeader.readUInt32LE(0);
			this.pcapBigEndian = magic === 0xd4c3b2a1;
			const linkType = this.pcapBigEndian
				? this.pcapGlobalHeader.readUInt32BE(20)
				: this.pcapGlobalHeader.readUInt32LE(20);
			this.linkType = linkType;
			// SLL (Linux cooked) = 113 → 16 bytes; SLL2 = 276 → 20 bytes; Ethernet = 1 → 14 bytes
			if (linkType === 276) this.linkLayerSize = 20;
			else if (linkType === 113) this.linkLayerSize = 16;
			else if (linkType === 1) this.linkLayerSize = 14;
			else if (linkType === 101) this.linkLayerSize = 0;
			else this.linkLayerSize = 0;
			this.logger.debugSync(`pcap magic: 0x${magic.toString(16)}, link type: ${linkType}, header size: ${this.linkLayerSize}`, {
				component: LogComponents.capture,
			});
			this.pcapBuf = Buffer.from(this.pcapBuf.subarray(24));
		}

		// Process packet records
		while (this.pcapBuf.length >= 16) {
			try {
				const r = this.pcapBigEndian ? 'readUInt32BE' : 'readUInt32LE' as const;
				const tsSec = this.pcapBuf[r](0);
				const tsUsec = this.pcapBuf[r](4);
				const capLen = this.pcapBuf[r](8);
				const origLen = this.pcapBuf[r](12);

				// Sanity check: reject absurd capture lengths
				if (capLen > 0xffff) {
					this.logger.warnSync(`pcap: invalid capLen ${capLen}, resetting buffer`, {
						component: LogComponents.capture,
					});
					this.pcapBuf = Buffer.alloc(0);
					break;
				}

				if (this.pcapBuf.length < 16 + capLen) break; // incomplete record

				const recordBuf = Buffer.from(this.pcapBuf.subarray(0, 16 + capLen));
				const payload = this.pcapBuf.subarray(16, 16 + capLen);

				this.pcapBuf = Buffer.from(this.pcapBuf.subarray(16 + capLen));

				const timestamp = tsSec * 1000 + Math.floor(tsUsec / 1000);
				const parsed = this.parsePayload(payload);

				const direction = this.detectDirection(parsed.srcIp, parsed.dstIp);
				const protocolName = this.resolveProtocolName(parsed.ipProtocol, parsed.srcPort, parsed.dstPort);

				const packet: CapturedPacket = {
					id: this.nextId++,
					timestamp,
					length: origLen,
					capturedLength: capLen,
					rawPcap: recordBuf,
					pcapLinkType: this.linkType,
					pcapGlobalHeader: this.pcapGlobalHeader,
					appPayload: parsed.appPayload,
					srcIp: parsed.srcIp,
					dstIp: parsed.dstIp,
					srcPort: parsed.srcPort,
					dstPort: parsed.dstPort,
					ipProtocol: parsed.ipProtocol,
					protocolName,
					direction,
					info: '',
					tcpSeq: parsed.tcpSeq,
					tcpFlags: parsed.tcpFlags,
				};
				packet.info = this.buildInfoString(packet);

				this.counters.seen++;
				this.counters.bytes += origLen;
				if (direction === 'inbound') this.counters.inbound++;
				else if (direction === 'outbound') this.counters.outbound++;

				if (this.packets.length >= this.maxPackets) {
					this.packets.shift();
					this.counters.dropped++;
				}
				this.packets.push(packet);
				this.counters.stored = this.packets.length;

				if (this.tcpAssembler && packet.ipProtocol === 6 && packet.tcpSeq !== null) {
					this.tcpAssembler.feed(packet);
				}

				this.emit('packet', packet);
			} catch (err) {
				this.logger.warnSync(`pcap parse error: ${err instanceof Error ? err.message : err}`, {
					component: LogComponents.capture,
				});
				this.pcapBuf = Buffer.alloc(0);
				break;
			}
		}
	}

	private parsePayload(payload: Buffer): {
		srcIp: string; dstIp: string;
		srcPort: number | null; dstPort: number | null;
		ipProtocol: number;
		appPayload: Buffer | null;
		tcpSeq: number | null;
		tcpFlags: number | null;
	} {
		const unknown = (protocol = -1) => ({
			srcIp: '?', dstIp: '?', srcPort: null, dstPort: null,
			ipProtocol: protocol, appPayload: null, tcpSeq: null, tcpFlags: null,
		});
		let ipOffset = this.linkLayerSize;
		if (payload.length < ipOffset) return unknown();
		let etherType: number;
		switch (this.linkType) {
			case 1: // Ethernet II
				if (payload.length < 14) return unknown();
				etherType = payload.readUInt16BE(12);
				// 802.1Q / QinQ VLAN headers contain another EtherType.
				for (let i = 0; i < 4 && (etherType === 0x8100 || etherType === 0x88a8 || etherType === 0x9100); i++) {
					if (payload.length < ipOffset + 4) return unknown();
					etherType = payload.readUInt16BE(ipOffset + 2);
					ipOffset += 4;
				}
				break;
			case 113: // Linux cooked capture v1
				if (payload.length < 16) return unknown();
				etherType = payload.readUInt16BE(14);
				break;
			case 276: // Linux cooked capture v2
				if (payload.length < 20) return unknown();
				etherType = payload.readUInt16BE(0);
				break;
			case 101: // DLT_RAW, IP header starts immediately
				ipOffset = 0;
				etherType = payload.length && (payload[0] >> 4) === 6 ? 0x86dd : 0x0800;
				break;
			default:
				return unknown();
		}
		let srcIp: string;
		let dstIp: string;
		let ipProtocol: number;
		let transportOffset: number;
		let transportEnd: number;
		let nonInitialFragment = false;
		if (etherType === 0x0800) {
			if (payload.length < ipOffset + 20 || (payload[ipOffset] >> 4) !== 4) return unknown();
			const ihl = (payload[ipOffset] & 0x0f) * 4;
			if (ihl < 20 || payload.length < ipOffset + ihl) return unknown();
			const totalLength = payload.readUInt16BE(ipOffset + 2);
			if (totalLength < ihl) return unknown();
			transportEnd = Math.min(payload.length, ipOffset + totalLength);
			ipProtocol = payload[ipOffset + 9];
			srcIp = Array.from(payload.subarray(ipOffset + 12, ipOffset + 16)).join('.');
			dstIp = Array.from(payload.subarray(ipOffset + 16, ipOffset + 20)).join('.');
			transportOffset = ipOffset + ihl;
			nonInitialFragment = (payload.readUInt16BE(ipOffset + 6) & 0x1fff) !== 0;
		} else if (etherType === 0x86dd) {
			if (payload.length < ipOffset + 40 || (payload[ipOffset] >> 4) !== 6) return unknown();
			const formatIp6 = (offset: number): string => {
				const groups = Array.from({ length: 8 }, (_, i) => payload.readUInt16BE(offset + i * 2));
				// Canonical compressed form also matches addresses returned by hostname -I.
				let bestStart = -1, bestLength = 1;
				for (let i = 0; i < 8;) {
					if (groups[i] !== 0) { i++; continue; }
					let j = i;
					while (j < 8 && groups[j] === 0) j++;
					if (j - i > bestLength) { bestStart = i; bestLength = j - i; }
					i = j;
				}
				if (bestStart < 0) return groups.map((n) => n.toString(16)).join(':');
				const before = groups.slice(0, bestStart).map((n) => n.toString(16)).join(':');
				const after = groups.slice(bestStart + bestLength).map((n) => n.toString(16)).join(':');
				return `${before}::${after}`;
			};
			srcIp = formatIp6(ipOffset + 8);
			dstIp = formatIp6(ipOffset + 24);
			ipProtocol = payload[ipOffset + 6];
			transportOffset = ipOffset + 40;
			transportEnd = Math.min(payload.length, transportOffset + payload.readUInt16BE(ipOffset + 4));
			// Traverse known extension headers with strict bounds and iteration limit.
			for (let i = 0; i < 16; i++) {
				if (ipProtocol === 0 || ipProtocol === 43 || ipProtocol === 60 || ipProtocol === 135) {
					if (transportOffset + 2 > transportEnd) return { ...unknown(ipProtocol), srcIp, dstIp };
					const size = (payload[transportOffset + 1] + 1) * 8;
					if (transportOffset + size > transportEnd) return { ...unknown(ipProtocol), srcIp, dstIp };
					const next = payload[transportOffset];
					transportOffset += size;
					ipProtocol = next;
				} else if (ipProtocol === 44) { // Fragment
					if (transportOffset + 8 > transportEnd) return { ...unknown(ipProtocol), srcIp, dstIp };
					const next = payload[transportOffset];
					nonInitialFragment = (payload.readUInt16BE(transportOffset + 2) & 0xfff8) !== 0;
					transportOffset += 8;
					ipProtocol = next;
					if (nonInitialFragment) break;
				} else if (ipProtocol === 51) { // AH
					if (transportOffset + 2 > transportEnd) return { ...unknown(ipProtocol), srcIp, dstIp };
					const size = (payload[transportOffset + 1] + 2) * 4;
					if (size < 8 || transportOffset + size > transportEnd) return { ...unknown(ipProtocol), srcIp, dstIp };
					const next = payload[transportOffset];
					transportOffset += size;
					ipProtocol = next;
				} else break;
			}
		} else {
			return unknown(); // Non-IP Ethernet protocol; do not mislabel as IP/0.
		}

		let srcPort: number | null = null;
		let dstPort: number | null = null;
		let tcpSeq: number | null = null;
		let tcpFlags: number | null = null;
		let appPayload: Buffer | null = null;
		if (!nonInitialFragment && (ipProtocol === 6 || ipProtocol === 17) && transportOffset + 4 <= transportEnd) {
			srcPort = payload.readUInt16BE(transportOffset);
			dstPort = payload.readUInt16BE(transportOffset + 2);
		}
		if (!nonInitialFragment && ipProtocol === 6 && transportOffset + 20 <= transportEnd) {
			const headerLength = (payload[transportOffset + 12] >> 4) * 4;
			if (headerLength >= 20 && transportOffset + headerLength <= transportEnd) {
				tcpSeq = payload.readUInt32BE(transportOffset + 4);
				tcpFlags = payload[transportOffset + 13];
				if (transportOffset + headerLength < transportEnd) {
					appPayload = Buffer.from(payload.subarray(transportOffset + headerLength, transportEnd));
				}
			}
		} else if (!nonInitialFragment && ipProtocol === 17 && transportOffset + 8 <= transportEnd) {
			const udpLength = payload.readUInt16BE(transportOffset + 4);
			if (udpLength >= 8 && transportOffset + 8 < transportEnd) {
				appPayload = Buffer.from(payload.subarray(transportOffset + 8, Math.min(transportEnd, transportOffset + udpLength)));
			}
		}
		return { srcIp, dstIp, srcPort, dstPort, ipProtocol, appPayload, tcpSeq, tcpFlags };
	}

	private resolveProtocolName(ipProtocol: number, srcPort: number | null, dstPort: number | null): string {
		// Check well-known ports first for application-layer identification
		if (dstPort != null && WELL_KNOWN_PORTS[dstPort]) return WELL_KNOWN_PORTS[dstPort];
		if (srcPort != null && WELL_KNOWN_PORTS[srcPort]) return WELL_KNOWN_PORTS[srcPort];
		return IP_PROTOCOL_NAMES[ipProtocol] ?? (ipProtocol < 0 ? 'Unknown' : `IP/${ipProtocol}`);
	}

	private detectDirection(srcIp: string, dstIp: string): 'inbound' | 'outbound' | 'unknown' {
		if (this.localIps.has(dstIp)) return 'inbound';
		if (this.localIps.has(srcIp)) return 'outbound';
		return 'unknown';
	}

	private buildInfoString(p: CapturedPacket): string {
		const src = p.srcPort != null ? `${p.srcIp}:${p.srcPort}` : p.srcIp;
		const dst = p.dstPort != null ? `${p.dstIp}:${p.dstPort}` : p.dstIp;
		return `${src} → ${dst} ${p.protocolName} len=${p.length}`;
	}

	private async resolveLocalIps(): Promise<void> {
		this.localIps.clear();
		this.localIps.add('127.0.0.1');
		try {
			const { stdout } = await exec('hostname -I');
			for (const ip of stdout.trim().split(/\s+/)) {
				if (ip) this.localIps.add(ip);
			}
		} catch {
			// Fall back to loopback only
		}
	}

	// ── TCP stream reassembly ─────────────────────────────────────────────

	private initReassembly(): void {
		this.framers.clear();
		this.flowProtocols.clear();

		const handler: TcpStreamHandler = {
			onData: (flowId, data, packetId) => this.onStreamData(flowId, data, packetId),
			onGap: (flowId) => {
				const framer = this.framers.get(flowId);
				if (framer) framer.reset();
			},
			onClose: (flowId) => {
				this.framers.delete(flowId);
				this.flowProtocols.delete(flowId);
			},
		};

		this.tcpAssembler = new TcpAssembler(handler);
		this.cleanupTimer = setInterval(() => {
			this.tcpAssembler?.cleanup(Date.now());
		}, 30_000);
	}

	private teardownReassembly(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
		this.tcpAssembler?.reset();
		this.tcpAssembler = null;
		this.framers.clear();
		this.flowProtocols.clear();
	}

	private createFramer(protocolName: string): ProtocolFramer | null {
		if (protocolName === 'OPC-UA') return new OpcUaFramer();
		return null;
	}

	private onStreamData(flowId: FlowId, data: Buffer, packetId: number): void {
		let proto = this.flowProtocols.get(flowId);
		if (!proto) {
			const pkt = this.packets.find(p => p.id === packetId);
			if (!pkt) return;
			proto = pkt.protocolName;
			this.flowProtocols.set(flowId, proto);
		}

		let framer = this.framers.get(flowId);
		if (!framer) {
			const created = this.createFramer(proto);
			if (!created) return;
			framer = created;
			this.framers.set(flowId, framer);
		}

		const messages = framer.push(data, packetId);
		for (const msg of messages) {
			this.decodeReassembled(msg, proto);
		}
	}

	private decodeReassembled(msg: FramedMessage, protocolName: string): void {
		const pkt = this.packets.find(p => p.id === msg.completingPacketId);
		if (!pkt) return;

		const meta: PacketMeta = {
			srcIp: pkt.srcIp, dstIp: pkt.dstIp,
			srcPort: pkt.srcPort, dstPort: pkt.dstPort,
			ipProtocol: pkt.ipProtocol, protocolName,
		};

		const decoded = getDecoderRegistry().decode(protocolName, msg.payload, meta);
		if (decoded) {
			pkt.reassembledDecoded = decoded;
		}
	}
}
