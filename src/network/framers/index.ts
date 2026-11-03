export interface FramedMessage {
	payload: Buffer;
	completingPacketId: number;
}

export interface ProtocolFramer {
	readonly protocol: string;
	push(data: Buffer, packetId: number): FramedMessage[];
	reset(): void;
}
