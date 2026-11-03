export interface PacketMeta {
	srcIp: string;
	dstIp: string;
	srcPort: number | null;
	dstPort: number | null;
	ipProtocol: number;
	protocolName: string;
}

export interface DecodedPacket {
	operation: string;
	summary: string;
	status: 'ok' | 'error' | 'warning';
	details: Record<string, string | number | boolean>;
}

export interface ProtocolDecoder {
	readonly protocols: string[];
	decode(payload: Buffer, meta: PacketMeta): DecodedPacket | null;
}

export class DecoderRegistry {
	private decoders = new Map<string, ProtocolDecoder>();

	register(decoder: ProtocolDecoder): void {
		for (const name of decoder.protocols) {
			this.decoders.set(name, decoder);
		}
	}

	has(protocolName: string): boolean {
		return this.decoders.has(protocolName);
	}

	decode(protocolName: string, payload: Buffer, meta: PacketMeta): DecodedPacket | null {
		const decoder = this.decoders.get(protocolName);
		if (!decoder) return null;
		try {
			return decoder.decode(payload, meta);
		} catch {
			return null;
		}
	}
}

import { MqttDecoder } from './mqtt.js';
import { ModbusDecoder } from './modbus.js';
import { HttpDecoder } from './http.js';
import { DnsDecoder } from './dns.js';
import { OpcuaDecoder } from './opcua.js';
import { BacnetDecoder } from './bacnet.js';

let registry: DecoderRegistry | null = null;

export function getDecoderRegistry(): DecoderRegistry {
	if (!registry) {
		registry = new DecoderRegistry();
		registry.register(new MqttDecoder());
		registry.register(new ModbusDecoder());
		registry.register(new HttpDecoder());
		registry.register(new DnsDecoder());
		registry.register(new OpcuaDecoder());
		registry.register(new BacnetDecoder());
	}
	return registry;
}
