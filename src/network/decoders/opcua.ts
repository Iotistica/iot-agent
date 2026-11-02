import type { ProtocolDecoder, PacketMeta, DecodedPacket } from './index.js';

const MESSAGE_TYPES: Record<string, string> = {
	HEL: 'Hello',
	ACK: 'Acknowledge',
	ERR: 'Error',
	OPN: 'OpenSecureChannel',
	CLO: 'CloseSecureChannel',
	MSG: 'Message',
	RHE: 'ReverseHello',
};

const CHUNK_TYPES: Record<string, string> = {
	F: 'Final',
	C: 'Intermediate',
	A: 'Abort',
};

export class OpcuaDecoder implements ProtocolDecoder {
	readonly protocols = ['OPC-UA'];

	decode(payload: Buffer, _meta: PacketMeta): DecodedPacket | null {
		if (payload.length < 8) return null;

		const msgType = payload.toString('ascii', 0, 3);
		const msgName = MESSAGE_TYPES[msgType];
		if (!msgName) return null;

		const chunkChar = String.fromCharCode(payload[3]);
		const chunkType = CHUNK_TYPES[chunkChar] ?? chunkChar;
		const messageSize = payload.readUInt32LE(4);

		const details: Record<string, string | number | boolean> = {
			messageType: msgType,
			messageTypeName: msgName,
			chunkType,
			messageSize,
		};

		if (msgType === 'MSG' && payload.length >= 12) {
			details.secureChannelId = payload.readUInt32LE(8);
		}

		if (msgType === 'ERR' && payload.length >= 12) {
			details.errorCode = payload.readUInt32LE(8);
		}

		const chunkStr = msgType === 'MSG' ? ` ${chunkType}` : '';
		const sizeStr = ` size=${messageSize}`;
		return {
			operation: msgType,
			summary: `${msgType} ${msgName}${chunkStr}${sizeStr}`,
			status: msgType === 'ERR' ? 'error' : 'ok',
			details,
		};
	}
}
