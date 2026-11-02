import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { exec } from '../lib/fs-utils.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';

// ── Data model ─────────────────────────────────────────────────────────────

export interface CapturedPacket {
	id: number;
	timestamp: number;
	length: number;
	capturedLength: number;
	rawPcap: Buffer;
	srcIp: string;
	dstIp: string;
	srcPort: number | null;
	dstPort: number | null;
	ipProtocol: number;
	protocolName: string;
	direction: 'inbound' | 'outbound' | 'unknown';
	info: string;
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

// ── Well-known port → application protocol ─────────────────────────────────

const WELL_KNOWN_PORTS: Record<number, string> = {
	20: 'FTP-Data', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP',
	53: 'DNS', 67: 'DHCP', 68: 'DHCP', 80: 'HTTP', 110: 'POP3',
	123: 'NTP', 143: 'IMAP', 443: 'HTTPS', 502: 'Modbus/TCP',
	993: 'IMAPS', 995: 'POP3S', 1883: 'MQTT', 3306: 'MySQL',
	4840: 'OPC-UA', 5432: 'PostgreSQL', 5672: 'AMQP', 6379: 'Redis',
	8080: 'HTTP-Alt', 8443: 'HTTPS-Alt', 8883: 'MQTT/TLS',
	27017: 'MongoDB', 47808: 'BACnet/IP',
};

const IP_PROTOCOL_NAMES: Record<number, string> = {
	1: 'ICMP', 2: 'IGMP', 6: 'TCP', 17: 'UDP', 41: 'IPv6', 47: 'GRE', 50: 'ESP', 58: 'ICMPv6',
};

// ── CaptureEngine ──────────────────────────────────────────────────────────

export class CaptureEngine extends EventEmitter {
	private logger: AgentLogger;
	private _available = false;
	private state: 'idle' | 'running' | 'stopping' = 'idle';
	private proc: ChildProcess | null = null;
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
	private pcapBigEndian = false;
	private tcpdumpPath = 'tcpdump';

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

	async start(options?: CaptureStartOptions): Promise<CaptureStatus> {
		if (this.state === 'running') throw new Error('Capture already running');
		if (!this._available) throw new Error('Capture not available');

		this.maxPackets = options?.maxPackets ?? 10_000;
		this.captureIface = options?.iface ?? 'any';
		this.captureFilter = options?.filter ?? null;

		this.clear();
		this.sessionId = randomUUID();
		this.startedAt = new Date().toISOString();
		this.state = 'running';
		this.nextId = 1;
		this.pcapBuf = Buffer.alloc(0);
		this.pcapGlobalHeader = null;

		await this.resolveLocalIps();

		const args = ['-i', this.captureIface, '-U', '-w', '-', '-s', '65535'];
		if (this.captureFilter) args.push(...this.captureFilter.split(/\s+/));

		this.logger.infoSync(`Spawning: ${this.tcpdumpPath} ${args.join(' ')}`, {
			component: LogComponents.capture,
		});

		this.proc = spawn(this.tcpdumpPath, args);

		this.proc.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
		this.proc.stderr?.on('data', (data: Buffer) => {
			const msg = data.toString().trim();
			if (msg) {
				this.logger.infoSync(`tcpdump: ${msg}`, { component: LogComponents.capture });
			}
		});
		this.proc.on('error', (err) => {
			this.logger.warnSync(`tcpdump process error: ${err.message}`, {
				component: LogComponents.capture,
			});
			this.state = 'idle';
			this.proc = null;
			this.emit('status-change', this.getStatus());
		});
		this.proc.on('close', (code) => {
			this.logger.infoSync(`tcpdump exited with code ${code}`, {
				component: LogComponents.capture,
			});
			this.state = 'idle';
			this.proc = null;
			this.emit('status-change', this.getStatus());
		});

		this.logger.infoSync('Packet capture started', {
			component: LogComponents.capture,
			sessionId: this.sessionId,
			iface: this.captureIface,
			filter: this.captureFilter,
		});

		this.emit('status-change', this.getStatus());
		return this.getStatus();
	}

	stop(): CaptureStatus {
		if (this.state !== 'running') return this.getStatus();
		this.state = 'stopping';
		if (this.proc) {
			this.proc.kill('SIGTERM');
			this.proc = null;
		}
		this.state = 'idle';
		this.logger.debugSync('Packet capture stopped', {
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

		const parts: Buffer[] = [this.pcapGlobalHeader];
		for (const pkt of this.packets) {
			parts.push(pkt.rawPcap);
		}
		return Buffer.concat(parts);
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
			// SLL (Linux cooked) = 113 → 16 bytes; SLL2 = 276 → 20 bytes; Ethernet = 1 → 14 bytes
			if (linkType === 276) this.linkLayerSize = 20;
			else if (linkType === 113) this.linkLayerSize = 16;
			else if (linkType === 1) this.linkLayerSize = 14;
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
					srcIp: parsed.srcIp,
					dstIp: parsed.dstIp,
					srcPort: parsed.srcPort,
					dstPort: parsed.dstPort,
					ipProtocol: parsed.ipProtocol,
					protocolName,
					direction,
					info: '',
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
	} {
		const ipOffset = this.linkLayerSize;
		if (payload.length < ipOffset + 20) {
			return { srcIp: '?', dstIp: '?', srcPort: null, dstPort: null, ipProtocol: 0 };
		}

		const versionIhl = payload[ipOffset];
		const version = (versionIhl >> 4) & 0x0f;
		if (version !== 4) {
			return { srcIp: '?', dstIp: '?', srcPort: null, dstPort: null, ipProtocol: 0 };
		}

		const ihl = (versionIhl & 0x0f) * 4;
		const ipProtocol = payload[ipOffset + 9];

		const srcIp = `${payload[ipOffset + 12]}.${payload[ipOffset + 13]}.${payload[ipOffset + 14]}.${payload[ipOffset + 15]}`;
		const dstIp = `${payload[ipOffset + 16]}.${payload[ipOffset + 17]}.${payload[ipOffset + 18]}.${payload[ipOffset + 19]}`;

		let srcPort: number | null = null;
		let dstPort: number | null = null;

		// TCP (6) and UDP (17) have ports at the same offset
		if ((ipProtocol === 6 || ipProtocol === 17) && payload.length >= ipOffset + ihl + 4) {
			srcPort = payload.readUInt16BE(ipOffset + ihl);
			dstPort = payload.readUInt16BE(ipOffset + ihl + 2);
		}

		return { srcIp, dstIp, srcPort, dstPort, ipProtocol };
	}

	private resolveProtocolName(ipProtocol: number, srcPort: number | null, dstPort: number | null): string {
		// Check well-known ports first for application-layer identification
		if (dstPort != null && WELL_KNOWN_PORTS[dstPort]) return WELL_KNOWN_PORTS[dstPort];
		if (srcPort != null && WELL_KNOWN_PORTS[srcPort]) return WELL_KNOWN_PORTS[srcPort];
		return IP_PROTOCOL_NAMES[ipProtocol] ?? `IP/${ipProtocol}`;
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
}
