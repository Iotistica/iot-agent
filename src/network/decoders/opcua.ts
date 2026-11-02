import type { ProtocolDecoder, PacketMeta, DecodedPacket } from './index.js';
import { OpcUaReader } from './opcua-binary.js';

// ── OPC UA Status Codes (common transport-level) ───────────────────────────

const STATUS_CODE_NAMES: Record<number, string> = {
	0x00000000: 'Good',
	0x80010000: 'BadUnexpectedError',
	0x80020000: 'BadInternalError',
	0x80030000: 'BadOutOfMemory',
	0x80060000: 'BadNothingToDo',
	0x80090000: 'BadTooManyOperations',
	0x800B0000: 'BadEncodingError',
	0x800C0000: 'BadDecodingError',
	0x800E0000: 'BadTimeout',
	0x80100000: 'BadServiceUnsupported',
	0x80130000: 'BadSecureChannelIdInvalid',
	0x80170000: 'BadCertificateInvalid',
	0x80180000: 'BadSecurityChecksFailed',
	0x80260000: 'BadRequestHeaderInvalid',
	0x80410000: 'BadTcpServerTooBusy',
	0x80420000: 'BadTcpMessageTypeInvalid',
	0x80430000: 'BadTcpSecureChannelUnknown',
	0x80440000: 'BadTcpMessageTooLarge',
	0x80450000: 'BadTcpNotEnoughResources',
	0x80460000: 'BadTcpInternalError',
	0x80470000: 'BadTcpEndpointUrlInvalid',
	0x80480000: 'BadRequestTimeout',
	0x80490000: 'BadSecurityModeRejected',
	0x804A0000: 'BadSecurityPolicyRejected',
	0x804B0000: 'BadTooManySessions',
	0x80550000: 'BadCertificateTimeInvalid',
	0x80560000: 'BadCertificateIssuerTimeInvalid',
	0x80570000: 'BadCertificateHostNameInvalid',
	0x80580000: 'BadCertificateUriInvalid',
	0x80590000: 'BadCertificateUseNotAllowed',
	0x805A0000: 'BadCertificateIssuerUseNotAllowed',
	0x805B0000: 'BadCertificateUntrusted',
	0x805C0000: 'BadCertificateRevocationUnknown',
	0x805D0000: 'BadCertificateIssuerRevocationUnknown',
	0x805E0000: 'BadCertificateRevoked',
	0x805F0000: 'BadCertificateIssuerRevoked',
	0x80630000: 'BadProtocolVersionUnsupported',
};

function statusCodeName(code: number): string {
	return STATUS_CODE_NAMES[code] ?? `0x${code.toString(16).padStart(8, '0')}`;
}

// ── Message and chunk type sets ────────────────────────────────────────────

const MESSAGE_TYPE_NAMES: Record<string, string> = {
	HEL: 'Hello',
	ACK: 'Acknowledge',
	ERR: 'Error',
	RHE: 'ReverseHello',
	OPN: 'OpenSecureChannel',
	MSG: 'Message',
	CLO: 'CloseSecureChannel',
};

// Connection-level messages: byte 3 is always 'F' (the spec treats it as
// part of the 4-byte message type, not as a chunk indicator).
const CONNECTION_MSG_TYPES = new Set(['HEL', 'ACK', 'ERR', 'RHE']);

// Allowed chunk type characters per secure-conversation message type
const ALLOWED_CHUNKS: Record<string, Set<string>> = {
	OPN: new Set(['F', 'A']),
	MSG: new Set(['F', 'C', 'A']),
	CLO: new Set(['F', 'A']),
};

// Minimum message sizes (header + required body fields)
const MIN_MESSAGE_SIZES: Record<string, number> = {
	HEL: 32,   // 8 header + 5×4 uint32 + 4 string-length (empty url)
	ACK: 28,   // 8 header + 5×4 uint32
	ERR: 16,   // 8 header + 4 statusCode + 4 string-length
	RHE: 16,   // 8 header + 4+4 two string-length prefixes (both empty)
	OPN: 16,   // 8 header + 4 secureChannelId + 4 securityPolicyUri length (minimum)
	MSG: 16,   // 8 header + 4 secureChannelId + 4 tokenId
	CLO: 16,   // 8 header + 4 secureChannelId + 4 tokenId
};

// ── Configurable limits ────────────────────────────────────────────────────

export interface OpcuaDecoderConfig {
	maxMessageSize?: number;
	maxStringLength?: number;
}

const DEFAULT_MAX_MESSAGE_SIZE = 16 * 1024 * 1024; // 16 MB
const DEFAULT_MAX_STRING_LENGTH = 4096;

// ── Decoder ────────────────────────────────────────────────────────────────

export class OpcuaDecoder implements ProtocolDecoder {
	readonly protocols = ['OPC-UA'];

	private maxMessageSize: number;
	private maxStringLength: number;

	constructor(config?: OpcuaDecoderConfig) {
		this.maxMessageSize = config?.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE;
		this.maxStringLength = config?.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
	}

	decode(payload: Buffer, _meta: PacketMeta): DecodedPacket | null {
		if (payload.length < 8) return null;

		const msgType = payload.toString('ascii', 0, 3);
		if (!MESSAGE_TYPE_NAMES[msgType]) return null;

		const byte3 = String.fromCharCode(payload[3]);
		const messageSize = payload.readUInt32LE(4);

		// Structural validation: message size sanity
		const minSize = MIN_MESSAGE_SIZES[msgType] ?? 8;
		if (messageSize < minSize) {
			return this.malformed(msgType, `messageSize ${messageSize} below minimum ${minSize} for ${msgType}`);
		}
		if (messageSize > this.maxMessageSize) {
			return this.malformed(msgType, `messageSize ${messageSize} exceeds limit ${this.maxMessageSize}`);
		}

		const isConnection = CONNECTION_MSG_TYPES.has(msgType);

		// Connection messages: byte 3 must be 'F'
		if (isConnection && byte3 !== 'F') {
			return this.malformed(msgType, `invalid byte3 '${byte3}' for ${msgType} (expected 'F')`);
		}

		// Secure-conversation messages: validate chunk type
		let chunkType: string | undefined;
		if (!isConnection) {
			const allowed = ALLOWED_CHUNKS[msgType];
			if (!allowed || !allowed.has(byte3)) {
				return this.malformed(msgType, `invalid chunk type '${byte3}' for ${msgType}`);
			}
			chunkType = byte3;
		}

		// Check for truncation
		const truncated = payload.length < messageSize;
		const baseDetails: Record<string, string | number | boolean> = {
			messageType: msgType,
			messageTypeName: MESSAGE_TYPE_NAMES[msgType],
			messageSize,
		};
		if (chunkType) {
			baseDetails.chunkType = chunkType;
		}
		if (truncated) {
			baseDetails.truncated = true;
			baseDetails.availableBytes = payload.length;
		}

		// Coalesced detection
		if (payload.length > messageSize) {
			const remaining = payload.length - messageSize;
			baseDetails.additionalBytes = remaining;
			// Estimate how many additional messages
			if (remaining >= 8) {
				const nextType = payload.toString('ascii', messageSize, messageSize + 3);
				if (MESSAGE_TYPE_NAMES[nextType]) {
					baseDetails.coalescedMessages = true;
				}
			}
		}

		// Abort chunks
		if (chunkType === 'A') {
			return this.decodeAbort(msgType, payload, baseDetails);
		}

		switch (msgType) {
			case 'HEL': return this.decodeHello(payload, baseDetails, truncated);
			case 'ACK': return this.decodeAck(payload, baseDetails, truncated);
			case 'ERR': return this.decodeError(payload, baseDetails, truncated);
			case 'RHE': return this.decodeReverseHello(payload, baseDetails, truncated);
			case 'OPN': return this.decodeOpenSecureChannel(payload, baseDetails, truncated);
			case 'MSG': return this.decodeMessage(payload, baseDetails, truncated);
			case 'CLO': return this.decodeMessage(payload, baseDetails, truncated);
			default: return null;
		}
	}

	// ── Connection messages ────────────────────────────────────────────────

	private decodeHello(
		buf: Buffer,
		details: Record<string, string | number | boolean>,
		truncated: boolean,
	): DecodedPacket {
		const r = new OpcUaReader(buf, 8);

		const protocolVersion = r.readUInt32LE();
		const receiveBufferSize = r.readUInt32LE();
		const sendBufferSize = r.readUInt32LE();
		const maxMessageSize = r.readUInt32LE();
		const maxChunkCount = r.readUInt32LE();

		if (protocolVersion !== null) details.protocolVersion = protocolVersion;
		if (receiveBufferSize !== null) details.receiveBufferSize = receiveBufferSize;
		if (sendBufferSize !== null) details.sendBufferSize = sendBufferSize;
		if (maxMessageSize !== null) details.maxMessageSize = maxMessageSize;
		if (maxChunkCount !== null) details.maxChunkCount = maxChunkCount;

		const endpointUrl = r.readString(this.maxStringLength);
		if (endpointUrl !== undefined && endpointUrl !== null) {
			details.endpointUrl = endpointUrl;
		}

		const urlPart = typeof details.endpointUrl === 'string'
			? ` endpoint=${details.endpointUrl}`
			: '';
		const suffix = truncated ? ' [truncated]' : '';
		return {
			operation: 'HEL',
			summary: `HEL Hello${urlPart}${suffix}`,
			status: truncated ? 'warning' : 'ok',
			details,
		};
	}

	private decodeAck(
		buf: Buffer,
		details: Record<string, string | number | boolean>,
		truncated: boolean,
	): DecodedPacket {
		const r = new OpcUaReader(buf, 8);

		const protocolVersion = r.readUInt32LE();
		const receiveBufferSize = r.readUInt32LE();
		const sendBufferSize = r.readUInt32LE();
		const maxMessageSize = r.readUInt32LE();
		const maxChunkCount = r.readUInt32LE();

		if (protocolVersion !== null) details.protocolVersion = protocolVersion;
		if (receiveBufferSize !== null) details.receiveBufferSize = receiveBufferSize;
		if (sendBufferSize !== null) details.sendBufferSize = sendBufferSize;
		if (maxMessageSize !== null) details.maxMessageSize = maxMessageSize;
		if (maxChunkCount !== null) details.maxChunkCount = maxChunkCount;

		const recvStr = receiveBufferSize !== null ? ` recvBuf=${receiveBufferSize}` : '';
		const sendStr = sendBufferSize !== null ? ` sendBuf=${sendBufferSize}` : '';
		const suffix = truncated ? ' [truncated]' : '';
		return {
			operation: 'ACK',
			summary: `ACK Acknowledge${recvStr}${sendStr}${suffix}`,
			status: truncated ? 'warning' : 'ok',
			details,
		};
	}

	private decodeError(
		buf: Buffer,
		details: Record<string, string | number | boolean>,
		truncated: boolean,
	): DecodedPacket {
		const r = new OpcUaReader(buf, 8);

		const statusCode = r.readUInt32LE();
		if (statusCode !== null) {
			details.statusCode = statusCode;
			details.statusName = statusCodeName(statusCode);
		}

		const reason = r.readString(this.maxStringLength);
		if (reason !== undefined && reason !== null) {
			details.reason = reason;
		}

		const statusStr = details.statusName ?? (statusCode !== null ? `0x${statusCode.toString(16)}` : 'unknown');
		const reasonStr = typeof details.reason === 'string' ? ` "${details.reason}"` : '';
		const suffix = truncated ? ' [truncated]' : '';
		return {
			operation: 'ERR',
			summary: `ERR ${statusStr}${reasonStr}${suffix}`,
			status: 'error',
			details,
		};
	}

	private decodeReverseHello(
		buf: Buffer,
		details: Record<string, string | number | boolean>,
		truncated: boolean,
	): DecodedPacket {
		const r = new OpcUaReader(buf, 8);

		const serverUri = r.readString(this.maxStringLength);
		if (serverUri !== undefined && serverUri !== null) {
			details.serverUri = serverUri;
		}

		const endpointUrl = r.readString(this.maxStringLength);
		if (endpointUrl !== undefined && endpointUrl !== null) {
			details.endpointUrl = endpointUrl;
		}

		const urlPart = typeof details.endpointUrl === 'string'
			? ` endpoint=${details.endpointUrl}`
			: '';
		const suffix = truncated ? ' [truncated]' : '';
		return {
			operation: 'RHE',
			summary: `RHE ReverseHello${urlPart}${suffix}`,
			status: truncated ? 'warning' : 'ok',
			details,
		};
	}

	// ── Secure conversation messages ───────────────────────────────────────

	private decodeOpenSecureChannel(
		buf: Buffer,
		details: Record<string, string | number | boolean>,
		truncated: boolean,
	): DecodedPacket {
		const r = new OpcUaReader(buf, 8);

		const secureChannelId = r.readUInt32LE();
		if (secureChannelId !== null) details.secureChannelId = secureChannelId;

		// Asymmetric security header (all plaintext)
		const securityPolicyUri = r.readString(this.maxStringLength);
		if (securityPolicyUri !== undefined && securityPolicyUri !== null) {
			details.securityPolicy = securityPolicyUri;
		}

		// Sender certificate — skip content, record length
		const senderCertLen = r.skipByteString();
		if (senderCertLen !== undefined && senderCertLen !== null) {
			details.senderCertificateLength = senderCertLen;
		}

		// Receiver certificate thumbprint — skip content, record length
		const thumbprintLen = r.skipByteString();
		if (thumbprintLen !== undefined && thumbprintLen !== null) {
			details.receiverThumbprintLength = thumbprintLen;
		}

		const isNoneSecurity = typeof details.securityPolicy === 'string'
			&& details.securityPolicy.endsWith('#None');
		if (!isNoneSecurity) {
			details.encrypted = true;
		}

		const policyPart = typeof details.securityPolicy === 'string'
			? ` policy=${details.securityPolicy}`
			: '';
		const channelPart = secureChannelId !== null ? ` channel=${secureChannelId}` : '';
		const suffix = truncated ? ' [truncated]' : '';
		return {
			operation: 'OPN',
			summary: `OPN OpenSecureChannel${channelPart}${policyPart}${suffix}`,
			status: truncated ? 'warning' : 'ok',
			details,
		};
	}

	private decodeMessage(
		buf: Buffer,
		details: Record<string, string | number | boolean>,
		truncated: boolean,
	): DecodedPacket {
		const msgType = details.messageType as string;
		const chunkType = details.chunkType as string | undefined;
		const r = new OpcUaReader(buf, 8);

		const secureChannelId = r.readUInt32LE();
		if (secureChannelId !== null) details.secureChannelId = secureChannelId;

		// Symmetric security header: just tokenId
		const tokenId = r.readUInt32LE();
		if (tokenId !== null) details.tokenId = tokenId;

		// Everything after tokenId is encrypted (unless SecurityPolicy.None,
		// which we can't determine from this single packet without connection state)
		details.encrypted = true;

		const typeName = msgType === 'CLO' ? 'CloseSecureChannel' : 'Message';
		const chunkStr = chunkType === 'C' ? ' intermediate' : chunkType === 'F' ? '' : '';
		const channelPart = secureChannelId !== null ? ` channel=${secureChannelId}` : '';
		const tokenPart = tokenId !== null ? ` token=${tokenId}` : '';
		const suffix = truncated ? ' [truncated]' : '';
		return {
			operation: msgType,
			summary: `${msgType} ${typeName}${chunkStr}${channelPart}${tokenPart} encrypted${suffix}`,
			status: truncated ? 'warning' : 'ok',
			details,
		};
	}

	// ── Abort ──────────────────────────────────────────────────────────────

	private decodeAbort(
		msgType: string,
		buf: Buffer,
		details: Record<string, string | number | boolean>,
	): DecodedPacket {
		// Abort body: secureChannelId(4) + tokenId(4) + statusCode(4) + reason(string)
		const r = new OpcUaReader(buf, 8);

		const secureChannelId = r.readUInt32LE();
		if (secureChannelId !== null) details.secureChannelId = secureChannelId;

		const tokenId = r.readUInt32LE();
		if (tokenId !== null) details.tokenId = tokenId;

		const statusCode = r.readUInt32LE();
		if (statusCode !== null) {
			details.abortStatusCode = statusCode;
			details.abortStatusName = statusCodeName(statusCode);
		}

		const reason = r.readString(this.maxStringLength);
		if (reason !== undefined && reason !== null) {
			details.abortReason = reason;
		}

		const statusStr = details.abortStatusName
			?? (statusCode !== null ? `0x${statusCode.toString(16)}` : 'unknown');
		const channelPart = secureChannelId !== null ? ` channel=${secureChannelId}` : '';
		return {
			operation: msgType,
			summary: `${msgType} Abort${channelPart} ${statusStr}`,
			status: 'error',
			details,
		};
	}

	// ── Helpers ─────────────────────────────────────────────────────────────

	private malformed(msgType: string, reason: string): DecodedPacket {
		return {
			operation: msgType,
			summary: `${msgType} malformed: ${reason}`,
			status: 'error',
			details: {
				messageType: msgType,
				malformed: true,
				malformedReason: reason,
			},
		};
	}
}
