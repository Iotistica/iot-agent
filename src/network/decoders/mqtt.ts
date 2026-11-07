import type { ProtocolDecoder, PacketMeta, DecodedPacket } from './index.js';

const PACKET_TYPES: Record<number, string> = {
	1: 'CONNECT', 2: 'CONNACK', 3: 'PUBLISH', 4: 'PUBACK',
	5: 'PUBREC', 6: 'PUBREL', 7: 'PUBCOMP', 8: 'SUBSCRIBE',
	9: 'SUBACK', 10: 'UNSUBSCRIBE', 11: 'UNSUBACK',
	12: 'PINGREQ', 13: 'PINGRESP', 14: 'DISCONNECT',
};

const CONNACK_CODES: Record<number, string> = {
	0: 'Accepted', 1: 'Unacceptable Protocol', 2: 'Identifier Rejected',
	3: 'Server Unavailable', 4: 'Bad Credentials', 5: 'Not Authorized',
};

function readRemainingLength(buf: Buffer, offset: number): { value: number; bytes: number } | null {
	let value = 0;
	let multiplier = 1;
	let index = offset;
	for (let i = 0; i < 4; i++) {
		if (index >= buf.length) return null;
		const byte = buf[index++];
		value += (byte & 0x7f) * multiplier;
		if ((byte & 0x80) === 0) return { value, bytes: index - offset };
		multiplier *= 128;
	}
	return null;
}

function readMqttString(buf: Buffer, offset: number): { value: string; bytes: number } | null {
	if (offset + 2 > buf.length) return null;
	const len = buf.readUInt16BE(offset);
	if (offset + 2 + len > buf.length) return null;
	return { value: buf.toString('utf8', offset + 2, offset + 2 + len), bytes: 2 + len };
}

export class MqttDecoder implements ProtocolDecoder {
	readonly protocols = ['MQTT', 'MQTT/TLS'];

	decode(payload: Buffer, _meta: PacketMeta): DecodedPacket | null {
		if (payload.length < 2) return null;

		const byte0 = payload[0];
		const typeCode = (byte0 >> 4) & 0x0f;
		const flags = byte0 & 0x0f;
		const typeName = PACKET_TYPES[typeCode];
		if (!typeName) return null;

		const rl = readRemainingLength(payload, 1);
		if (!rl) return null;

		const varStart = 1 + rl.bytes;

		switch (typeCode) {
			case 1: return this.decodeConnect(payload, varStart);
			case 2: return this.decodeConnack(payload, varStart);
			case 3: return this.decodePublish(payload, varStart, flags, rl.value);
			case 4: case 5: case 6: case 7: return this.decodeAck(typeName, payload, varStart);
			case 8: return this.decodeSubscribe(payload, varStart);
			case 9: return this.decodeSuback(payload, varStart);
			case 10: return this.decodeUnsubscribe(payload, varStart);
			case 12: return { operation: 'PINGREQ', summary: 'PINGREQ', status: 'ok', details: {} };
			case 13: return { operation: 'PINGRESP', summary: 'PINGRESP', status: 'ok', details: {} };
			case 14: return { operation: 'DISCONNECT', summary: 'DISCONNECT', status: 'ok', details: {} };
			default: return { operation: typeName, summary: typeName, status: 'ok', details: {} };
		}
	}

	private decodeConnect(buf: Buffer, offset: number): DecodedPacket {
		const details: Record<string, string | number | boolean> = {};
		const proto = readMqttString(buf, offset);
		if (proto) {
			details.protocol = proto.value;
			offset += proto.bytes;
			if (offset < buf.length) {
				details.version = buf[offset];
				offset++;
			}
			if (offset < buf.length) {
				const connectFlags = buf[offset];
				details.cleanSession = !!(connectFlags & 0x02);
				offset++;
			}
			if (offset + 2 <= buf.length) {
				details.keepAlive = buf.readUInt16BE(offset);
				offset += 2;
			}
			const clientId = readMqttString(buf, offset);
			if (clientId) details.clientId = clientId.value;
		}
		const clientStr = details.clientId ? ` client="${details.clientId}"` : '';
		const cleanStr = details.cleanSession !== undefined ? ` clean=${details.cleanSession}` : '';
		return {
			operation: 'CONNECT',
			summary: `CONNECT${clientStr}${cleanStr}`,
			status: 'ok',
			details,
		};
	}

	private decodeConnack(buf: Buffer, offset: number): DecodedPacket {
		const details: Record<string, string | number | boolean> = {};
		if (offset + 2 <= buf.length) {
			details.sessionPresent = !!(buf[offset] & 0x01);
			const code = buf[offset + 1];
			details.returnCode = code;
			details.returnText = CONNACK_CODES[code] ?? `Unknown (${code})`;
		}
		const status = details.returnCode === 0 ? 'ok' : 'error';
		const text = details.returnText ?? 'unknown';
		return { operation: 'CONNACK', summary: `CONNACK ${text}`, status, details };
	}

	private decodePublish(buf: Buffer, offset: number, flags: number, remainingLen: number): DecodedPacket {
		const qos = (flags >> 1) & 0x03;
		const dup = !!(flags & 0x08);
		const retain = !!(flags & 0x01);
		const details: Record<string, string | number | boolean> = { qos, dup, retain };

		const topic = readMqttString(buf, offset);
		let payloadLen = 0;
		if (topic) {
			details.topic = topic.value;
			let cursor = offset + topic.bytes;
			if (qos > 0 && cursor + 2 <= buf.length) {
				details.packetId = buf.readUInt16BE(cursor);
				cursor += 2;
			}
			payloadLen = remainingLen - (cursor - offset);
			if (payloadLen > 0) {
				details.payloadLength = payloadLen;
				const previewEnd = Math.min(cursor + 60, buf.length);
				const previewBuf = buf.subarray(cursor, previewEnd);
				const isUtf8 = previewBuf.every(b => b >= 0x20 && b < 0x7f || b === 0x0a || b === 0x0d || b === 0x09);
				if (isUtf8 && previewBuf.length > 0) {
					details.payloadPreview = previewBuf.toString('utf8');
				}
			}
		}

		const topicStr = details.topic ? ` topic=${details.topic}` : '';
		const qosStr = ` QoS=${qos}`;
		const retainStr = retain ? ' RETAIN' : '';
		const lenStr = payloadLen > 0 ? ` len=${payloadLen}` : '';
		return {
			operation: 'PUBLISH',
			summary: `PUBLISH${topicStr}${qosStr}${retainStr}${lenStr}`,
			status: 'ok',
			details,
		};
	}

	private decodeAck(type: string, buf: Buffer, offset: number): DecodedPacket {
		const details: Record<string, string | number | boolean> = {};
		if (offset + 2 <= buf.length) details.packetId = buf.readUInt16BE(offset);
		return { operation: type, summary: `${type} id=${details.packetId ?? '?'}`, status: 'ok', details };
	}

	private decodeSubscribe(buf: Buffer, offset: number): DecodedPacket {
		const details: Record<string, string | number | boolean> = {};
		if (offset + 2 <= buf.length) {
			details.packetId = buf.readUInt16BE(offset);
			offset += 2;
		}
		const topic = readMqttString(buf, offset);
		if (topic) {
			details.topic = topic.value;
			offset += topic.bytes;
			if (offset < buf.length) details.qos = buf[offset] & 0x03;
		}
		const topicStr = details.topic ? ` topic=${details.topic}` : '';
		const qosStr = details.qos !== undefined ? ` QoS=${details.qos}` : '';
		return { operation: 'SUBSCRIBE', summary: `SUBSCRIBE${topicStr}${qosStr}`, status: 'ok', details };
	}

	private decodeSuback(buf: Buffer, offset: number): DecodedPacket {
		const details: Record<string, string | number | boolean> = {};
		if (offset + 2 <= buf.length) {
			details.packetId = buf.readUInt16BE(offset);
			offset += 2;
		}
		const codes: number[] = [];
		while (offset < buf.length) {
			codes.push(buf[offset++]);
		}
		if (codes.length > 0) details.returnCodes = codes.join(',');
		return { operation: 'SUBACK', summary: `SUBACK id=${details.packetId ?? '?'}`, status: 'ok', details };
	}

	private decodeUnsubscribe(buf: Buffer, offset: number): DecodedPacket {
		const details: Record<string, string | number | boolean> = {};
		if (offset + 2 <= buf.length) {
			details.packetId = buf.readUInt16BE(offset);
			offset += 2;
		}
		const topic = readMqttString(buf, offset);
		if (topic) details.topic = topic.value;
		const topicStr = details.topic ? ` topic=${details.topic}` : '';
		return { operation: 'UNSUBSCRIBE', summary: `UNSUBSCRIBE${topicStr}`, status: 'ok', details };
	}
}
