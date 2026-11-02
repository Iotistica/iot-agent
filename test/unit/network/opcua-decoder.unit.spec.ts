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

/** Build abort chunk with correct layout per OPC 10000-6 §6.7.3:
 *  Header(8) + ChannelId(4) + TokenId(4) + SeqNum(4) + ReqId(4) + StatusCode(4) + Reason */
function buildAbort(msgType: string, opts: {
	secureChannelId?: number;
	tokenId?: number;
	sequenceNumber?: number;
	requestId?: number;
	statusCode?: number;
	reason?: string | null;
}): Buffer {
	const reasonBuf = writeOpcUaString(opts.reason ?? null);
	// channelId(4) + tokenId(4) + seqNum(4) + reqId(4) + statusCode(4) + reason
	const bodySize = 4 + 4 + 4 + 4 + 4 + reasonBuf.length;
	const totalSize = 8 + bodySize;
	const buf = Buffer.alloc(totalSize);
	buf.write(msgType, 0, 3, 'ascii');
	buf[3] = 'A'.charCodeAt(0);
	buf.writeUInt32LE(totalSize, 4);
	buf.writeUInt32LE(opts.secureChannelId ?? 1, 8);
	buf.writeUInt32LE(opts.tokenId ?? 1, 12);
	buf.writeUInt32LE(opts.sequenceNumber ?? 1, 16);   // SequenceNumber
	buf.writeUInt32LE(opts.requestId ?? 1, 20);         // RequestId
	buf.writeUInt32LE(opts.statusCode ?? 0x80010000, 24);
	reasonBuf.copy(buf, 28);
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

	// ── Defect 11 regression: cursor rewind on string failure ──────────

	it('rewinds cursor on truncated readString (defect 11)', () => {
		const buf = Buffer.alloc(12);
		buf.writeInt32LE(100, 0); // bad string: claims 100 bytes
		buf.writeUInt32LE(0x42, 4); // next valid uint32
		const r = new OpcUaReader(buf);
		expect(r.readString()).toBeUndefined();
		expect(r.offset).toBe(0); // cursor rewound to before the length prefix
	});

	it('rewinds cursor on truncated skipByteString (defect 11)', () => {
		const buf = Buffer.alloc(12);
		buf.writeInt32LE(100, 0); // bad bytestring
		buf.writeUInt32LE(0x42, 4);
		const r = new OpcUaReader(buf);
		expect(r.skipByteString()).toBeUndefined();
		expect(r.offset).toBe(0); // cursor rewound
	});

	// ── Defect 6 regression: bounded reader ────────────────────────────

	it('respects length bound (defect 6)', () => {
		const buf = Buffer.alloc(20);
		buf.writeUInt32LE(0xAA, 0);
		buf.writeUInt32LE(0xBB, 4);
		buf.writeUInt32LE(0xCC, 8);  // outside bound
		const r = new OpcUaReader(buf, 0, 8);
		expect(r.readUInt32LE()).toBe(0xAA);
		expect(r.readUInt32LE()).toBe(0xBB);
		expect(r.readUInt32LE()).toBeNull(); // bounded, even though buf has more
		expect(r.remaining).toBe(0);
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

		it('decodes valid ERR with correct status code', () => {
			const buf = buildERR(0x80830000, 'Bad endpoint');
			const result = decoder.decode(buf, META);
			expect(result).not.toBeNull();
			expect(result!.operation).toBe('ERR');
			expect(result!.status).toBe('error');
			expect(result!.details.statusCode).toBe(0x80830000);
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
			expect(result!.details.bodyVisibility).toBe('unknown');
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
			const result = decoder.decode(buf, META);
			expect(result!.status).toBe('error');
			expect(result!.details.malformed).toBe(true);
		});

		it('rejects messageSize exceeding configured limit', () => {
			const small = new OpcuaDecoder({ maxMessageSize: 100 });
			const buf = buildHEL({});
			buf.writeUInt32LE(200, 4);
			const result = small.decode(buf, META);
			expect(result!.status).toBe('error');
			expect(result!.details.malformed).toBe(true);
		});

		it('detects incomplete transport (available < messageSize)', () => {
			const full = buildHEL({});
			const truncated = full.subarray(0, 20); // cut off most of it
			truncated.writeUInt32LE(full.length, 4);
			const result = decoder.decode(truncated, META);
			expect(result).not.toBeNull();
			expect(result!.status).toBe('warning');
			expect(result!.details.incompleteTransport).toBe(true);
			expect(result!.summary).toContain('[incomplete]');
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
			const buf = buildERR(0x80830000, 'Invalid endpoint URL');
			const result = decoder.decode(buf, META)!;
			expect(result.status).toBe('error');
			expect(result.details.statusCode).toBe(0x80830000);
			expect(result.details.statusName).toBe('BadTcpEndpointUrlInvalid');
			expect(result.details.reason).toBe('Invalid endpoint URL');
			expect(result.summary).toContain('BadTcpEndpointUrlInvalid');
		});

		it('handles malformed reason (truncated string)', () => {
			const buf = Buffer.alloc(16);
			buf.write('ERR', 0, 3, 'ascii');
			buf[3] = 'F'.charCodeAt(0);
			buf.writeUInt32LE(16, 4);
			buf.writeUInt32LE(0x80010000, 8);
			buf.writeInt32LE(500, 12); // claims 500 bytes of string
			const result = decoder.decode(buf, META)!;
			expect(result.status).toBe('error');
			expect(result.details.statusCode).toBe(0x80010000);
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
			expect(result.details.bodyVisibility).toBe('encrypted');
			expect(result.summary).toContain('channel=42');
			expect(result.summary).toContain('Basic256Sha256');
		});

		it('identifies None security policy as plaintext', () => {
			const buf = buildOPN({
				securityPolicy: 'http://opcfoundation.org/UA/SecurityPolicy#None',
			});
			const result = decoder.decode(buf, META)!;
			expect(result.details.bodyVisibility).toBe('plaintext');
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
			expect(result.details.incompleteTransport).toBe(true);
		});
	});

	describe('MSG decoding', () => {
		it('extracts channel and token with unknown body visibility', () => {
			const buf = buildMSG({ secureChannelId: 10, tokenId: 7 });
			const result = decoder.decode(buf, META)!;
			expect(result.details.secureChannelId).toBe(10);
			expect(result.details.tokenId).toBe(7);
			expect(result.details.bodyVisibility).toBe('unknown');
			expect(result.summary).toContain('channel=10');
			expect(result.summary).toContain('token=7');
		});

		it('decodes intermediate chunk', () => {
			const buf = buildMSG({ chunkType: 'C', secureChannelId: 3 });
			const result = decoder.decode(buf, META)!;
			expect(result.details.chunkType).toBe('C');
			expect(result.summary).toContain('intermediate');
		});

		it('decodes abort chunk with sequence header', () => {
			const buf = buildAbort('MSG', {
				secureChannelId: 5,
				tokenId: 2,
				sequenceNumber: 100,
				requestId: 42,
				statusCode: 0x80010000,
				reason: 'Too large',
			});
			const result = decoder.decode(buf, META)!;
			expect(result.status).toBe('error');
			expect(result.details.chunkType).toBe('A');
			expect(result.details.sequenceNumber).toBe(100);
			expect(result.details.requestId).toBe(42);
			expect(result.details.abortStatusCode).toBe(0x80010000);
			expect(result.details.abortStatusName).toBe('BadUnexpectedError');
			expect(result.details.abortReason).toBe('Too large');
			expect(result.details.bodyVisibility).toBe('plaintext');
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
			// OPN with 'C' chunk (not allowed — OPN only supports 'F')
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
			const buf = Buffer.alloc(32);
			buf.write('HEL', 0, 3, 'ascii');
			buf[3] = 'F'.charCodeAt(0);
			buf.writeUInt32LE(32, 4);
			buf.writeUInt32LE(0, 8);
			buf.writeUInt32LE(65536, 12);
			buf.writeUInt32LE(65536, 16);
			buf.writeUInt32LE(0, 20);
			buf.writeUInt32LE(0, 24);
			buf.writeInt32LE(-5, 28); // corrupt string length
			const result = decoder.decode(buf, META);
			expect(result).not.toBeNull();
			expect(result!.details.protocolVersion).toBe(0);
		});
	});

	// ── Configurable limits ───────────────────────────────────────────

	describe('configurable limits', () => {
		it('respects maxStringLength', () => {
			const small = new OpcuaDecoder({ maxStringLength: 10 });
			const buf = buildHEL({ endpointUrl: 'opc.tcp://very-long-hostname.example.com:4840/path/to/endpoint' });
			const result = small.decode(buf, META)!;
			expect(result.details.endpointUrl).toBeUndefined();
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

		it('falls back to defaults for invalid config values (defect 12)', () => {
			const bad = new OpcuaDecoder({ maxMessageSize: -5, maxStringLength: NaN });
			const buf = buildHEL({});
			const result = bad.decode(buf, META)!;
			expect(result.status).toBe('ok');
			expect(result.details.endpointUrl).toBe('opc.tcp://server:4840');
		});
	});

	// ── Defect regression tests ───────────────────────────────────────

	describe('defect regressions', () => {
		// Defect 1: StatusCode values verified against OPC Foundation CSV
		describe('defect 1 — verified StatusCode values', () => {
			const codes: Array<[number, string]> = [
				[0x00000000, 'Good'],
				[0x80010000, 'BadUnexpectedError'],
				[0x80060000, 'BadEncodingError'],
				[0x80070000, 'BadDecodingError'],
				[0x80220000, 'BadSecureChannelIdInvalid'],
				[0x807D0000, 'BadTcpServerTooBusy'],
				[0x807E0000, 'BadTcpMessageTypeInvalid'],
				[0x807F0000, 'BadTcpSecureChannelUnknown'],
				[0x80800000, 'BadTcpMessageTooLarge'],
				[0x80810000, 'BadTcpNotEnoughResources'],
				[0x80820000, 'BadTcpInternalError'],
				[0x80830000, 'BadTcpEndpointUrlInvalid'],
				[0x80BE0000, 'BadProtocolVersionUnsupported'],
			];

			it.each(codes)('ERR 0x%s resolves to %s', (code, name) => {
				const buf = buildERR(code, 'test');
				const result = decoder.decode(buf, META)!;
				expect(result.details.statusName).toBe(name);
			});
		});

		// Defect 2: OPN only allows chunk type 'F' (not 'A')
		describe('defect 2 — OPN chunk validation', () => {
			it('rejects OPN with abort chunk type', () => {
				const buf = Buffer.alloc(16);
				buf.write('OPN', 0, 3, 'ascii');
				buf[3] = 'A'.charCodeAt(0);
				buf.writeUInt32LE(16, 4);
				const result = decoder.decode(buf, META)!;
				expect(result.status).toBe('error');
				expect(result.details.malformed).toBe(true);
			});

			it('rejects OPN with intermediate chunk type', () => {
				const buf = Buffer.alloc(16);
				buf.write('OPN', 0, 3, 'ascii');
				buf[3] = 'C'.charCodeAt(0);
				buf.writeUInt32LE(16, 4);
				const result = decoder.decode(buf, META)!;
				expect(result.status).toBe('error');
				expect(result.details.malformed).toBe(true);
			});

			it('accepts OPN with final chunk type', () => {
				const buf = buildOPN({});
				const result = decoder.decode(buf, META)!;
				expect(result.status).toBe('ok');
				expect(result.operation).toBe('OPN');
			});
		});

		// Defect 3: CLO only allows chunk type 'F' (not 'A')
		describe('defect 3 — CLO chunk validation', () => {
			it('rejects CLO with abort chunk type', () => {
				const buf = Buffer.alloc(16);
				buf.write('CLO', 0, 3, 'ascii');
				buf[3] = 'A'.charCodeAt(0);
				buf.writeUInt32LE(16, 4);
				const result = decoder.decode(buf, META)!;
				expect(result.status).toBe('error');
				expect(result.details.malformed).toBe(true);
			});

			it('rejects CLO with intermediate chunk type', () => {
				const buf = Buffer.alloc(16);
				buf.write('CLO', 0, 3, 'ascii');
				buf[3] = 'C'.charCodeAt(0);
				buf.writeUInt32LE(16, 4);
				const result = decoder.decode(buf, META)!;
				expect(result.status).toBe('error');
				expect(result.details.malformed).toBe(true);
			});
		});

		// Defect 4: MSG allows F, C, A
		describe('defect 4 — MSG chunk validation', () => {
			it('accepts MSG with F chunk', () => {
				const buf = buildMSG({ chunkType: 'F' });
				const result = decoder.decode(buf, META)!;
				expect(result.status).toBe('ok');
			});

			it('accepts MSG with C chunk', () => {
				const buf = buildMSG({ chunkType: 'C' });
				const result = decoder.decode(buf, META)!;
				expect(result.status).toBe('ok');
			});

			it('accepts MSG with A chunk', () => {
				const buf = buildAbort('MSG', { statusCode: 0x80010000 });
				const result = decoder.decode(buf, META)!;
				expect(result.status).toBe('error');
				expect(result.details.chunkType).toBe('A');
			});

			it('rejects MSG with X chunk', () => {
				const buf = Buffer.alloc(16);
				buf.write('MSG', 0, 3, 'ascii');
				buf[3] = 'X'.charCodeAt(0);
				buf.writeUInt32LE(16, 4);
				const result = decoder.decode(buf, META)!;
				expect(result.status).toBe('error');
				expect(result.details.malformed).toBe(true);
			});
		});

		// Defect 5: Abort layout accounts for SequenceHeader
		describe('defect 5 — abort message layout', () => {
			it('reads abort StatusCode after SequenceHeader', () => {
				const buf = buildAbort('MSG', {
					secureChannelId: 7,
					tokenId: 3,
					sequenceNumber: 50,
					requestId: 99,
					statusCode: 0x80800000,
					reason: 'message too large',
				});
				const result = decoder.decode(buf, META)!;
				expect(result.details.secureChannelId).toBe(7);
				expect(result.details.tokenId).toBe(3);
				expect(result.details.sequenceNumber).toBe(50);
				expect(result.details.requestId).toBe(99);
				expect(result.details.abortStatusCode).toBe(0x80800000);
				expect(result.details.abortStatusName).toBe('BadTcpMessageTooLarge');
				expect(result.details.abortReason).toBe('message too large');
			});

			it('marks abort body as unknown when StatusCode not recognized (encrypted)', () => {
				// Build a buffer where the bytes after tokenId look like random/encrypted data
				const bodySize = 4 + 4 + 4 + 4 + 4; // channelId + tokenId + 3 garbage uint32s
				const totalSize = 8 + bodySize;
				const buf = Buffer.alloc(totalSize);
				buf.write('MSG', 0, 3, 'ascii');
				buf[3] = 'A'.charCodeAt(0);
				buf.writeUInt32LE(totalSize, 4);
				buf.writeUInt32LE(1, 8);           // secureChannelId
				buf.writeUInt32LE(1, 12);          // tokenId
				buf.writeUInt32LE(0xDEAD, 16);     // fake seqNum
				buf.writeUInt32LE(0xBEEF, 20);     // fake reqId
				buf.writeUInt32LE(0xCAFEBABE, 24); // unrecognized StatusCode
				const result = decoder.decode(buf, META)!;
				expect(result.details.bodyVisibility).toBe('unknown');
				expect(result.details.abortStatusCode).toBeUndefined();
			});
		});

		// Defect 6: Message-size-bounded parsing (OpcUaReader length bound)
		describe('defect 6 — message-size-bounded parsing', () => {
			it('does not read past messageSize into coalesced data', () => {
				const hel = buildHEL({ endpointUrl: 'opc.tcp://first:4840' });
				const msg = buildMSG({ secureChannelId: 99 });
				const combined = Buffer.concat([hel, msg]);
				const result = decoder.decode(combined, META)!;
				expect(result.operation).toBe('HEL');
				expect(result.details.endpointUrl).toBe('opc.tcp://first:4840');
				// Must not bleed into second message's data
				expect(result.details.secureChannelId).toBeUndefined();
			});
		});

		// Defect 7: Body visibility — MSG/CLO report 'unknown' not 'encrypted'
		describe('defect 7 — honest body visibility', () => {
			it('MSG reports bodyVisibility=unknown (not encrypted)', () => {
				const buf = buildMSG({ secureChannelId: 1, tokenId: 1 });
				const result = decoder.decode(buf, META)!;
				expect(result.details.bodyVisibility).toBe('unknown');
				// Must NOT have details.encrypted
				expect(result.details.encrypted).toBeUndefined();
			});

			it('CLO reports bodyVisibility=unknown', () => {
				const buf = buildCLO({ secureChannelId: 1, tokenId: 1 });
				const result = decoder.decode(buf, META)!;
				expect(result.details.bodyVisibility).toBe('unknown');
				expect(result.details.encrypted).toBeUndefined();
			});

			it('OPN with #None reports bodyVisibility=plaintext', () => {
				const buf = buildOPN({
					securityPolicy: 'http://opcfoundation.org/UA/SecurityPolicy#None',
				});
				const result = decoder.decode(buf, META)!;
				expect(result.details.bodyVisibility).toBe('plaintext');
			});

			it('OPN with #Basic256Sha256 reports bodyVisibility=encrypted', () => {
				const buf = buildOPN({
					securityPolicy: 'http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256',
				});
				const result = decoder.decode(buf, META)!;
				expect(result.details.bodyVisibility).toBe('encrypted');
			});
		});

		// Defect 8: SecurityPolicy URI uses # not /
		describe('defect 8 — SecurityPolicy URI separator', () => {
			it('recognizes policy ending with #None', () => {
				const buf = buildOPN({
					securityPolicy: 'http://opcfoundation.org/UA/SecurityPolicy#None',
				});
				const result = decoder.decode(buf, META)!;
				expect(result.details.bodyVisibility).toBe('plaintext');
			});

			it('does NOT treat /None suffix as plaintext', () => {
				const buf = buildOPN({
					securityPolicy: 'http://opcfoundation.org/UA/SecurityPolicy/None',
				});
				const result = decoder.decode(buf, META)!;
				// Should be 'encrypted' since it doesn't end with #None
				expect(result.details.bodyVisibility).toBe('encrypted');
			});
		});

		// Defect 9: Incomplete transport vs malformed distinction
		describe('defect 9 — incomplete transport detection', () => {
			it('marks payload shorter than messageSize as incomplete, not malformed', () => {
				const full = buildMSG({ secureChannelId: 5, tokenId: 3 });
				const incomplete = full.subarray(0, 12); // has header + channelId but not tokenId
				incomplete.writeUInt32LE(full.length, 4);
				const result = decoder.decode(incomplete, META)!;
				expect(result.status).toBe('warning');
				expect(result.details.incompleteTransport).toBe(true);
				expect(result.details.malformed).toBeUndefined();
			});
		});

		// Defect 10: Mandatory field failure when not truncated
		describe('defect 10 — mandatory field validation', () => {
			it('flags malformedField when reason string is corrupt in complete ERR', () => {
				// ERR with statusCode but a reason that has a valid-looking length
				// pointing past the end, but messageSize says the packet IS complete
				const buf = Buffer.alloc(16);
				buf.write('ERR', 0, 3, 'ascii');
				buf[3] = 'F'.charCodeAt(0);
				buf.writeUInt32LE(16, 4); // messageSize = 16 (complete)
				buf.writeUInt32LE(0x80010000, 8);
				buf.writeInt32LE(500, 12); // reason claims 500 bytes, only 0 available
				const result = decoder.decode(buf, META)!;
				expect(result.details.statusCode).toBe(0x80010000);
				expect(result.details.malformedField).toBe('reason');
			});
		});

		// Defect 12: Config validation
		describe('defect 12 — config validation', () => {
			it('handles maxMessageSize of 0 by using default', () => {
				const d = new OpcuaDecoder({ maxMessageSize: 0 });
				const buf = buildHEL({});
				const result = d.decode(buf, META)!;
				// 0 < ABS_MIN_MESSAGE_SIZE(8), so defaults should be used
				expect(result.status).toBe('ok');
			});

			it('handles Infinity maxMessageSize by using default', () => {
				const d = new OpcuaDecoder({ maxMessageSize: Infinity });
				const buf = buildHEL({});
				const result = d.decode(buf, META)!;
				expect(result.status).toBe('ok');
			});

			it('handles NaN maxStringLength by using default', () => {
				const d = new OpcuaDecoder({ maxStringLength: NaN });
				const buf = buildHEL({});
				const result = d.decode(buf, META)!;
				expect(result.details.endpointUrl).toBe('opc.tcp://server:4840');
			});
		});
	});
});
