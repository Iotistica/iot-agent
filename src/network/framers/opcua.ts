import type { ProtocolFramer, FramedMessage } from './index.js';

const VALID_MSG_TYPES = new Set(['HEL', 'ACK', 'ERR', 'RHE', 'OPN', 'MSG', 'CLO']);

export class OpcUaFramer implements ProtocolFramer {
	readonly protocol = 'OPC-UA';
	private buffer = Buffer.alloc(0);
	private lastPacketId = 0;

	constructor(private readonly maxChunkSize = 16 * 1024 * 1024) {}

	push(data: Buffer, packetId: number): FramedMessage[] {
		this.lastPacketId = packetId;
		if (data.length === 0) return [];

		this.buffer = this.buffer.length === 0
			? Buffer.from(data)
			: Buffer.concat([this.buffer, data]);

		const messages: FramedMessage[] = [];

		while (this.buffer.length >= 8) {
			const msgType = this.buffer.toString('ascii', 0, 3);
			if (!VALID_MSG_TYPES.has(msgType)) {
				this.buffer = Buffer.alloc(0);
				break;
			}

			const size = this.buffer.readUInt32LE(4);
			if (size < 8 || size > this.maxChunkSize) {
				this.buffer = Buffer.alloc(0);
				break;
			}

			if (this.buffer.length < size) break;

			messages.push({
				payload: Buffer.from(this.buffer.subarray(0, size)),
				completingPacketId: this.lastPacketId,
			});
			this.buffer = this.buffer.length === size
				? Buffer.alloc(0)
				: Buffer.from(this.buffer.subarray(size));
		}

		return messages;
	}

	reset(): void {
		this.buffer = Buffer.alloc(0);
	}
}
