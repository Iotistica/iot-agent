import { OpcuaDecoder } from '../../../src/network/decoders/opcua';
import { OpcUaReader } from '../../../src/network/decoders/opcua-binary';
import type { PacketMeta } from '../../../src/network/decoders/index';

const META: PacketMeta = {
	srcIp: '10.0.0.1', dstIp: '10.0.0.2',
	srcPort: 50000, dstPort: 4840,
	ipProtocol: 6, protocolName: 'OPC-UA',
};

// ── Helpers ────────────────────────────────────────────────────────────────

function writeHeader(msgType: string, byte3: string, bodySize: number): Buffer {
	const totalSize = 8 + bodySize;
	const buf = Buffer.alloc(totalSize);
	buf.write(msgType, 0, 3, 'ascii');
	buf[3] = byte3.charCodeAt(0);
	buf.writeUInt32LE(totalSize, 4);
	return buf;
}

function writeOpcUaString(s: string | null): Buffer {
	if (s === null) {
		const buf = Buffer.alloc(4);
		buf.writeInt32LE(-1, 0);
		return buf;
	}
	const strBuf = Buffer.from(s, 'utf8');
	const buf = Buffer.alloc(4 + strBuf.length);
	buf.writeInt32LE(strBuf.length, 0);
	strBuf.copy(buf, 4);
	return buf;
}

function buildHEL(fields: {
	protocolVersion?: number;
	receiveBufferSize?: number;
	sendBufferSize?: number;
	maxMessageSize?: number;
	maxChunkCount?: number;
	endpointUrl?: string | null;
}): Buffer {
	const url = fields.endpointUrl ?? 'opc.tcp://server:4840';
	const urlBuf = writeOpcUaString(url);
	const bodySize = 20 + urlBuf.length;
	const buf = Buffer.alloc(8 + bodySize);
	buf.write('HEL', 0, 3, 'ascii');
	buf[3] = 'F'.charCodeAt(0);
	buf.writeUInt32LE(8 + bodySize, 4);
	buf.writeUInt32LE(fields.protocolVersion ?? 0, 8);
	buf.writeUInt32LE(fields.receiveBufferSize ?? 65536, 12);
	buf.writeUInt32LE(fields.sendBufferSize ?? 65536, 16);
	buf.writeUInt32LE(fields.maxMessageSize ?? 0, 20);
	buf.writeUInt32LE(fields.maxChunkCount ?? 0, 24);
	urlBuf.copy(buf, 28);
	return buf;
}

function buildACK(fields: {
	protocolVersion?: number;
	receiveBufferSize?: number;
	sendBufferSize?: number;
	maxMessageSize?: number;
	maxChunkCount?: number;
}): Buffer {
	const buf = Buffer.alloc(28);
	buf.write('ACK', 0, 3, 'ascii');
	buf[3] = 'F'.charCodeAt(0);
	buf.writeUInt32LE(28, 4);
	buf.writeUInt32LE(fields.protocolVersion ?? 0, 8);
	buf.writeUInt32LE(fields.receiveBufferSize ?? 65536, 12);
	buf.writeUInt32LE(fields.sendBufferSize ?? 65536, 16);
	buf.writeUInt32LE(fields.maxMessageSize ?? 4194304, 20);
	buf.writeUInt32LE(fields.maxChunkCount ?? 0, 24);
	return buf;
}

function buildERR(statusCode: number, reason: string | null): Buffer {
	const reasonBuf = writeOpcUaString(reason);
	const totalSize = 8 + 4 + reasonBuf.length;
	const buf = Buffer.alloc(totalSize);
	buf.write('ERR', 0, 3, 'ascii');
	buf[3] = 'F'.charCodeAt(0);
	buf.writeUInt32LE(totalSize, 4);
	buf.writeUInt32LE(statusCode, 8);
	reasonBuf.copy(buf, 12);
	return buf;
}

function buildRHE(serverUri: string, endpointUrl: string): Buffer {
	const uriBuf = writeOpcUaString(serverUri);
	const urlBuf = writeOpcUaString(endpointUrl);
	const totalSize = 8 + uriBuf.length + urlBuf.length;
	const buf = Buffer.alloc(totalSize);
	buf.write('RHE', 0, 3, 'ascii');
	buf[3] = 'F'.charCodeAt(0);
	buf.writeUInt32LE(totalSize, 4);
	uriBuf.copy(buf, 8);
	urlBuf.copy(buf, 8 + uriBuf.length);
	return buf;
}

function buildOPN(opts: {
	secureChannelId?: number;
	securityPolicy?: string;
	senderCert?: Buffer | null;
	receiverThumbprint?: Buffer | null;
}): Buffer {
	const channelId = opts.secureChannelId ?? 1;
	const policyBuf = writeOpcUaString(opts.securityPolicy ?? 'http://opcfoundation.org/UA/SecurityPolicy#None');
	const certBuf = opts.senderCert
		? Buffer.concat([Buffer.alloc(4), opts.senderCert])
		: writeOpcUaString(null); // -1 length = no cert
	if (opts.senderCert) certBuf.writeInt32LE(opts.senderCert.length, 0);
	const thumbBuf = opts.receiverThumbprint
		? Buffer.concat([Buffer.alloc(4), opts.receiverThumbprint])
		: writeOpcUaString(null);
	if (opts.receiverThumbprint) thumbBuf.writeInt32LE(opts.receiverThumbprint.length, 0);

	const bodySize = 4 + policyBuf.length + certBuf.length + thumbBuf.length;
	const totalSize = 8 + bodySize;
	const buf = Buffer.alloc(totalSize);
	buf.write('OPN', 0, 3, 'ascii');
	buf[3] = 'F'.charCodeAt(0);
	buf.writeUInt32LE(totalSize, 4);
	buf.writeUInt32LE(channelId, 8);
	let offset = 12;
	policyBuf.copy(buf, offset); offset += policyBuf.length;
	certBuf.copy(buf, offset); offset += certBuf.length;
	thumbBuf.copy(buf, offset);
	return buf;
}

function buildMSG(opts: {
	chunkType?: string;
	secureChannelId?: number;
	tokenId?: number;
	extraBody?: Buffer;
}): Buffer {
	const extraLen = opts.extraBody?.length ?? 0;
	const bodySize = 4 + 4 + extraLen; // channelId + tokenId + extra
	const totalSize = 8 + bodySize;
	const buf = Buffer.alloc(totalSize);
	buf.write('MSG', 0, 3, 'ascii');
	buf[3] = (opts.chunkType ?? 'F').charCodeAt(0);
	buf.writeUInt32LE(totalSize, 4);
	buf.writeUInt32LE(opts.secureChannelId ?? 1, 8);
	buf.writeUInt32LE(opts.tokenId ?? 1, 12);
	if (opts.extraBody) opts.extraBody.copy(buf, 16);
	return buf;
}

function buildCLO(opts?: { secureChannelId?: number; tokenId?: number }): Buffer {
	const totalSize = 16;
	const buf = Buffer.alloc(totalSize);
	buf.write('CLO', 0, 3, 'ascii');
	buf[3] = 'F'.charCodeAt(0);
	buf.writeUInt32LE(totalSize, 4);
	buf.writeUInt32LE(opts?.secureChannelId ?? 1, 8);
	buf.writeUInt32LE(opts?.tokenId ?? 1, 12);
	return buf;
}

function buildAbort(msgType: string, opts: {
	secureChannelId?: number;
	tokenId?: number;
	statusCode?: number;
	reason?: string | null;
}): Buffer {
	const reasonBuf = writeOpcUaString(opts.reason ?? null);
	const bodySize = 4 + 4 + 4 + reasonBuf.length;
	const totalSize = 8 + bodySize;
	const buf = Buffer.alloc(totalSize);
	buf.write(msgType, 0, 3, 'ascii');
	buf[3] = 'A'.charCodeAt(0);
	buf.writeUInt32LE(totalSize, 4);
	buf.writeUInt32LE(opts.secureChannelId ?? 1, 8);
	buf.writeUInt32LE(opts.tokenId ?? 1, 12);
	buf.writeUInt32LE(opts.statusCode ?? 0x80010000, 16);
	reasonBuf.copy(buf, 20);
	return buf;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('OpcUaReader', () => {
	it('reads uint8', () => {
		const r = new OpcUaReader(Buffer.from([0x42]));
		expect(r.readUInt8()).toBe(0x42);
		expect(r.offset).toBe(1);
	});

	it('returns null when buffer exhausted', () => {
		const r = new OpcUaReader(Buffer.alloc(0));
		expect(r.readUInt8()).toBeNull();
		expect(r.readUInt16LE()).toBeNull();
		expect(r.readUInt32LE()).toBeNull();
		expect(r.readInt32LE()).toBeNull();
	});

	it('reads LE integers correctly', () => {
		const buf = Buffer.alloc(6);
		buf.writeUInt16LE(0x1234, 0);
		buf.writeUInt32LE(0xDEADBEEF, 2);
		const r = new OpcUaReader(buf);
		expect(r.readUInt16LE()).toBe(0x1234);
		expect(r.readUInt32LE()).toBe(0xDEADBEEF);
	});

	it('reads OPC UA string', () => {
		const str = 'opc.tcp://test';
		const strBuf = Buffer.from(str, 'utf8');
		const buf = Buffer.alloc(4 + strBuf.length);
		buf.writeInt32LE(strBuf.length, 0);
		strBuf.copy(buf, 4);
		const r = new OpcUaReader(buf);
		expect(r.readString()).toBe(str);
	});

	it('reads null string (-1 length)', () => {
		const buf = Buffer.alloc(4);
		buf.writeInt32LE(-1, 0);
		const r = new OpcUaReader(buf);
		expect(r.readString()).toBeNull();
	});

	it('returns undefined for truncated string', () => {
		const buf = Buffer.alloc(4);
		buf.writeInt32LE(100, 0); // claims 100 bytes but buffer ends here
		const r = new OpcUaReader(buf);
		expect(r.readString()).toBeUndefined();
	});

	it('returns undefined for string exceeding max length', () => {
		const buf = Buffer.alloc(8);
		buf.writeInt32LE(5000, 0);
		const r = new OpcUaReader(buf);
		expect(r.readString(100)).toBeUndefined();
	});

	it('returns undefined for negative string length (not -1)', () => {
		const buf = Buffer.alloc(4);
		buf.writeInt32LE(-2, 0);
		const r = new OpcUaReader(buf);
		expect(r.readString()).toBeUndefined();
	});

	it('skips byte string and returns length', () => {
		const data = Buffer.alloc(20);
		const buf = Buffer.alloc(4 + data.length);
		buf.writeInt32LE(data.length, 0);
		data.copy(buf, 4);
		const r = new OpcUaReader(buf);
		expect(r.skipByteString()).toBe(20);
		expect(r.offset).toBe(24);
	});

	it('skip returns false on overflow', () => {
		const r = new OpcUaReader(Buffer.alloc(2));
		expect(r.skip(3)).toBe(false);
		expect(r.offset).toBe(0);
	});
});

describe('OpcuaDecoder', () => {
	const decoder = new OpcuaDecoder();

	// ── Message identification ─────────────────────────────────────────

	describe('message identification', () => {
		it('decodes valid HEL', () => {
			const buf = buildHEL({});
			const result = decoder.decode(buf, META);
			expect(result).not.toBeNull();
			expect(result!.operation).toBe('HEL');
			expect(result!.status).toBe('ok');
			expect(result!.details.endpointUrl).toBe('opc.tcp://server:4840');
		});

		it('decodes valid ACK', () => {
			const buf = buildACK({ receiveBufferSize: 8192 });
			const result = decoder.decode(buf, META);
			expect(result).not.toBeNull();
			expect(result!.operation).toBe('ACK');
			expect(result!.status).toBe('ok');
			expect(result!.details.receiveBufferSize).toBe(8192);
		});

		it('decodes valid ERR', () => {
			const buf = buildERR(0x80470000, 'Bad endpoint');
			const result = decoder.decode(buf, META);
			expect(result).not.toBeNull();
			expect(result!.operation).toBe('ERR');
			expect(result!.status).toBe('error');
			expect(result!.details.statusName).toBe('BadTcpEndpointUrlInvalid');
			expect(result!.details.reason).toBe('Bad endpoint');
		});

		it('decodes valid RHE', () => {
			const buf = buildRHE('urn:server', 'opc.tcp://server:4840');
			const result = decoder.decode(buf, META);
			expect(result).not.toBeNull();
			expect(result!.operation).toBe('RHE');
			expect(result!.details.serverUri).toBe('urn:server');
			expect(result!.details.endpointUrl).toBe('opc.tcp://server:4840');
		});

		it('decodes valid OPN', () => {
			const buf = buildOPN({ secureChannelId: 42 });
			const result = decoder.decode(buf, META);
			expect(result).not.toBeNull();
			expect(result!.operation).toBe('OPN');
			expect(result!.details.secureChannelId).toBe(42);
			expect(result!.details.securityPolicy).toContain('None');
		});

		it('decodes valid MSG final chunk', () => {
			const buf = buildMSG({ secureChannelId: 5, tokenId: 3 });
			const result = decoder.decode(buf, META);
			expect(result).not.toBeNull();
			expect(result!.operation).toBe('MSG');
			expect(result!.details.secureChannelId).toBe(5);
			expect(result!.details.tokenId).toBe(3);
			expect(result!.details.encrypted).toBe(true);
		});

		it('decodes valid CLO', () => {
			const buf = buildCLO({ secureChannelId: 5, tokenId: 3 });
			const result = decoder.decode(buf, META);
			expect(result).not.toBeNull();
			expect(result!.operation).toBe('CLO');
			expect(result!.details.secureChannelId).toBe(5);
			expect(result!.details.tokenId).toBe(3);
		});

		it('returns null for unknown message type', () => {
			const buf = Buffer.alloc(16);
			buf.write('XYZ', 0, 3, 'ascii');
			buf[3] = 'F'.charCodeAt(0);
			buf.writeUInt32LE(16, 4);
			expect(decoder.decode(buf, META)).toBeNull();
		});

		it('rejects invalid chunk type for MSG', () => {
			const buf = Buffer.alloc(16);
			buf.write('MSG', 0, 3, 'ascii');
			buf[3] = 'X'.charCodeAt(0);
			buf.writeUInt32LE(16, 4);
			const result = decoder.decode(buf, META);
			expect(result).not.toBeNull();
			expect(result!.status).toBe('error');
			expect(result!.details.malformed).toBe(true);
		});

		it('rejects invalid byte3 for HEL', () => {
			const buf = Buffer.alloc(32);
			buf.write('HEL', 0, 3, 'ascii');
			buf[3] = 'C'.charCodeAt(0); // must be 'F'
			buf.writeUInt32LE(32, 4);
			const result = decoder.decode(buf, META);
			expect(result).not.toBeNull();
			expect(result!.status).toBe('error');
			expect(result!.details.malformed).toBe(true);
		});

		it('rejects random data that starts with valid ASCII', () => {
			// 'MSG' followed by garbage: messageSize = 2 (below minimum 16)
			const buf = Buffer.from([0x4d, 0x53, 0x47, 0x46, 0x02, 0x00, 0x00, 0x00]);
			const result = decoder.decode(buf, META);
			expect(result).not.toBeNull();
			expect(result!.status).toBe('error');
			expect(result!.details.malformed).toBe(true);
		});
	});

	// ── Length validation ──────────────────────────────────────────────

	describe('length validation', () => {
		it('returns null for empty buffer', () => {
			expect(decoder.decode(Buffer.alloc(0), META)).toBeNull();
		});

		it('returns null for buffer shorter than 8 bytes', () => {
			expect(decoder.decode(Buffer.alloc(4), META)).toBeNull();
		});

		it('rejects messageSize smaller than type minimum', () => {
			const buf = writeHeader('HEL', 'F', 0); // 8 total, min is 32
			// Fix messageSize to 8 (already correct from writeHeader)
			const result = decoder.decode(buf, META);
			expect(result!.status).toBe('error');
			expect(result!.details.malformed).toBe(true);
		});

		it('rejects messageSize exceeding configured limit', () => {
			const small = new OpcuaDecoder({ maxMessageSize: 100 });
			const buf = buildHEL({});
			// Overwrite messageSize to something huge
			buf.writeUInt32LE(200, 4);
			const result = small.decode(buf, META);
			expect(result!.status).toBe('error');
			expect(result!.details.malformed).toBe(true);
		});

		it('detects truncated payload (available < messageSize)', () => {
			const full = buildHEL({});
			const truncated = full.subarray(0, 20); // cut off most of it
			// Fix messageSize to something valid
			truncated.writeUInt32LE(full.length, 4);
			const result = decoder.decode(truncated, META);
			expect(result).not.toBeNull();
			expect(result!.status).toBe('warning');
			expect(result!.details.truncated).toBe(true);
			expect(result!.summary).toContain('truncated');
		});

		it('detects coalesced messages', () => {
			const hel1 = buildHEL({});
			const hel2 = buildHEL({});
			const combined = Buffer.concat([hel1, hel2]);
			const result = decoder.decode(combined, META);
			expect(result).not.toBeNull();
			expect(result!.details.coalescedMessages).toBe(true);
		});
	});

	// ── Connection messages ───────────────────────────────────────────

	describe('HEL decoding', () => {
		it('extracts all fields', () => {
			const buf = buildHEL({
				protocolVersion: 0,
				receiveBufferSize: 65536,
				sendBufferSize: 65536,
				maxMessageSize: 4194304,
				maxChunkCount: 1000,
				endpointUrl: 'opc.tcp://myserver:4840/UA/Server',
			});
			const result = decoder.decode(buf, META)!;
			expect(result.details.protocolVersion).toBe(0);
			expect(result.details.receiveBufferSize).toBe(65536);
			expect(result.details.sendBufferSize).toBe(65536);
			expect(result.details.maxMessageSize).toBe(4194304);
			expect(result.details.maxChunkCount).toBe(1000);
			expect(result.details.endpointUrl).toBe('opc.tcp://myserver:4840/UA/Server');
			expect(result.summary).toContain('opc.tcp://myserver:4840/UA/Server');
		});

		it('handles empty endpoint URL', () => {
			const buf = buildHEL({ endpointUrl: '' });
			const result = decoder.decode(buf, META)!;
			expect(result.details.endpointUrl).toBe('');
			expect(result.status).toBe('ok');
		});
	});

	describe('ACK decoding', () => {
		it('extracts negotiated values', () => {
			const buf = buildACK({
				protocolVersion: 0,
				receiveBufferSize: 8192,
				sendBufferSize: 8192,
				maxMessageSize: 2097152,
				maxChunkCount: 500,
			});
			const result = decoder.decode(buf, META)!;
			expect(result.operation).toBe('ACK');
			expect(result.details.receiveBufferSize).toBe(8192);
			expect(result.details.sendBufferSize).toBe(8192);
			expect(result.details.maxMessageSize).toBe(2097152);
			expect(result.details.maxChunkCount).toBe(500);
			expect(result.summary).toContain('recvBuf=8192');
			expect(result.summary).toContain('sendBuf=8192');
		});
	});

	describe('ERR decoding', () => {
		it('decodes status code and reason', () => {
			const buf = buildERR(0x80470000, 'Invalid endpoint URL');
			const result = decoder.decode(buf, META)!;
			expect(result.status).toBe('error');
			expect(result.details.statusCode).toBe(0x80470000);
			expect(result.details.statusName).toBe('BadTcpEndpointUrlInvalid');
			expect(result.details.reason).toBe('Invalid endpoint URL');
			expect(result.summary).toContain('BadTcpEndpointUrlInvalid');
		});

		it('handles malformed reason (truncated string)', () => {
			// Build ERR with statusCode but truncated reason
			const buf = Buffer.alloc(16);
			buf.write('ERR', 0, 3, 'ascii');
			buf[3] = 'F'.charCodeAt(0);
			buf.writeUInt32LE(16, 4);
			buf.writeUInt32LE(0x80010000, 8);
			buf.writeInt32LE(500, 12); // claims 500 bytes of string
			const result = decoder.decode(buf, META)!;
			expect(result.status).toBe('error');
			expect(result.details.statusCode).toBe(0x80010000);
			// reason should be missing (truncated)
			expect(result.details.reason).toBeUndefined();
		});

		it('handles unknown status code', () => {
			const buf = buildERR(0x99990000, 'something');
			const result = decoder.decode(buf, META)!;
			expect(result.details.statusName).toBe('0x99990000');
		});
	});

	describe('RHE decoding', () => {
		it('extracts serverUri and endpointUrl', () => {
			const buf = buildRHE('urn:my:server', 'opc.tcp://reverse:4840');
			const result = decoder.decode(buf, META)!;
			expect(result.operation).toBe('RHE');
			expect(result.details.serverUri).toBe('urn:my:server');
			expect(result.details.endpointUrl).toBe('opc.tcp://reverse:4840');
			expect(result.summary).toContain('opc.tcp://reverse:4840');
		});
	});

	// ── Secure conversation ───────────────────────────────────────────

	describe('OPN decoding', () => {
		it('extracts security policy and channel id', () => {
			const buf = buildOPN({
				secureChannelId: 42,
				securityPolicy: 'http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256',
			});
			const result = decoder.decode(buf, META)!;
			expect(result.operation).toBe('OPN');
			expect(result.details.secureChannelId).toBe(42);
			expect(result.details.securityPolicy).toBe('http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256');
			expect(result.details.encrypted).toBe(true);
			expect(result.summary).toContain('channel=42');
			expect(result.summary).toContain('Basic256Sha256');
		});

		it('identifies None security policy', () => {
			const buf = buildOPN({
				securityPolicy: 'http://opcfoundation.org/UA/SecurityPolicy#None',
			});
			const result = decoder.decode(buf, META)!;
			expect(result.details.encrypted).toBeUndefined();
		});

		it('reports certificate lengths', () => {
			const cert = Buffer.alloc(512);
			const thumb = Buffer.alloc(20);
			const buf = buildOPN({ senderCert: cert, receiverThumbprint: thumb });
			const result = decoder.decode(buf, META)!;
			expect(result.details.senderCertificateLength).toBe(512);
			expect(result.details.receiverThumbprintLength).toBe(20);
		});

		it('handles truncated OPN', () => {
			const full = buildOPN({ secureChannelId: 1 });
			const truncated = full.subarray(0, 14);
			truncated.writeUInt32LE(full.length, 4); // messageSize says larger
			const result = decoder.decode(truncated, META)!;
			expect(result.status).toBe('warning');
			expect(result.details.truncated).toBe(true);
		});
	});

	describe('MSG decoding', () => {
		it('extracts channel and token', () => {
			const buf = buildMSG({ secureChannelId: 10, tokenId: 7 });
			const result = decoder.decode(buf, META)!;
			expect(result.details.secureChannelId).toBe(10);
			expect(result.details.tokenId).toBe(7);
			expect(result.details.encrypted).toBe(true);
			expect(result.summary).toContain('channel=10');
			expect(result.summary).toContain('token=7');
			expect(result.summary).toContain('encrypted');
		});

		it('decodes intermediate chunk', () => {
			const buf = buildMSG({ chunkType: 'C', secureChannelId: 3 });
			const result = decoder.decode(buf, META)!;
			expect(result.details.chunkType).toBe('C');
			expect(result.summary).toContain('intermediate');
		});

		it('decodes abort chunk', () => {
			const buf = buildAbort('MSG', {
				secureChannelId: 5,
				tokenId: 2,
				statusCode: 0x80010000,
				reason: 'Too large',
			});
			const result = decoder.decode(buf, META)!;
			expect(result.status).toBe('error');
			expect(result.details.chunkType).toBe('A');
			expect(result.details.abortStatusCode).toBe(0x80010000);
			expect(result.details.abortStatusName).toBe('BadUnexpectedError');
			expect(result.details.abortReason).toBe('Too large');
			expect(result.summary).toContain('Abort');
		});
	});

	describe('CLO decoding', () => {
		it('identifies channel closure', () => {
			const buf = buildCLO({ secureChannelId: 99, tokenId: 12 });
			const result = decoder.decode(buf, META)!;
			expect(result.operation).toBe('CLO');
			expect(result.details.secureChannelId).toBe(99);
			expect(result.details.tokenId).toBe(12);
			expect(result.summary).toContain('CloseSecureChannel');
		});
	});

	// ── Malformed packets ─────────────────────────────────────────────

	describe('malformed packet handling', () => {
		it('never throws on random data', () => {
			for (let i = 0; i < 50; i++) {
				const buf = Buffer.alloc(Math.floor(Math.random() * 200) + 1);
				for (let j = 0; j < buf.length; j++) buf[j] = Math.floor(Math.random() * 256);
				expect(() => decoder.decode(buf, META)).not.toThrow();
			}
		});

		it('handles buffer with valid type but absurd messageSize', () => {
			const buf = Buffer.alloc(8);
			buf.write('HEL', 0, 3, 'ascii');
			buf[3] = 'F'.charCodeAt(0);
			buf.writeUInt32LE(0xFFFFFFFF, 4);
			const result = decoder.decode(buf, META);
			expect(result!.status).toBe('error');
			expect(result!.details.malformed).toBe(true);
		});

		it('handles invalid chunk/message combination', () => {
			// OPN with 'C' chunk (not allowed — only F and A)
			const buf = Buffer.alloc(16);
			buf.write('OPN', 0, 3, 'ascii');
			buf[3] = 'C'.charCodeAt(0);
			buf.writeUInt32LE(16, 4);
			const result = decoder.decode(buf, META)!;
			expect(result.status).toBe('error');
			expect(result.details.malformed).toBe(true);
		});

		it('handles ERR byte3 not F', () => {
			const buf = Buffer.alloc(16);
			buf.write('ERR', 0, 3, 'ascii');
			buf[3] = 'A'.charCodeAt(0);
			buf.writeUInt32LE(16, 4);
			const result = decoder.decode(buf, META)!;
			expect(result.status).toBe('error');
			expect(result.details.malformed).toBe(true);
		});

		it('does not crash on string with negative length other than -1', () => {
			// Build a HEL with a corrupted endpointUrl length
			const buf = Buffer.alloc(32);
			buf.write('HEL', 0, 3, 'ascii');
			buf[3] = 'F'.charCodeAt(0);
			buf.writeUInt32LE(32, 4);
			buf.writeUInt32LE(0, 8);      // protocolVersion
			buf.writeUInt32LE(65536, 12);  // receiveBufferSize
			buf.writeUInt32LE(65536, 16);  // sendBufferSize
			buf.writeUInt32LE(0, 20);      // maxMessageSize
			buf.writeUInt32LE(0, 24);      // maxChunkCount
			buf.writeInt32LE(-5, 28);      // corrupt string length
			const result = decoder.decode(buf, META);
			expect(result).not.toBeNull();
			// Should still decode the numeric fields, just skip the bad string
			expect(result!.details.protocolVersion).toBe(0);
		});
	});

	// ── Configurable limits ───────────────────────────────────────────

	describe('configurable limits', () => {
		it('respects maxStringLength', () => {
			const small = new OpcuaDecoder({ maxStringLength: 10 });
			const buf = buildHEL({ endpointUrl: 'opc.tcp://very-long-hostname.example.com:4840/path/to/endpoint' });
			const result = small.decode(buf, META)!;
			// String exceeds limit, so it should be undefined/missing
			expect(result.details.endpointUrl).toBeUndefined();
			// But numeric fields should still be there
			expect(result.details.receiveBufferSize).toBe(65536);
		});

		it('respects maxMessageSize', () => {
			const small = new OpcuaDecoder({ maxMessageSize: 24 });
			const buf = buildACK({});
			// ACK is 28 bytes, should be rejected
			const result = small.decode(buf, META)!;
			expect(result.status).toBe('error');
			expect(result.details.malformed).toBe(true);
		});
	});
});
