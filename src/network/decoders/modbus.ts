import type { ProtocolDecoder, PacketMeta, DecodedPacket } from './index.js';

const FC_NAMES: Record<number, string> = {
	1: 'Read Coils',
	2: 'Read Discrete Inputs',
	3: 'Read Holding Registers',
	4: 'Read Input Registers',
	5: 'Write Single Coil',
	6: 'Write Single Register',
	15: 'Write Multiple Coils',
	16: 'Write Multiple Registers',
};

const EXCEPTION_CODES: Record<number, string> = {
	1: 'Illegal Function',
	2: 'Illegal Data Address',
	3: 'Illegal Data Value',
	4: 'Server Device Failure',
	5: 'Acknowledge',
	6: 'Server Device Busy',
	8: 'Memory Parity Error',
};

export class ModbusDecoder implements ProtocolDecoder {
	readonly protocols = ['Modbus/TCP'];

	decode(payload: Buffer, _meta: PacketMeta): DecodedPacket | null {
		// MBAP header is 7 bytes + at least 1 byte FC
		if (payload.length < 8) return null;

		const transactionId = payload.readUInt16BE(0);
		const protocolId = payload.readUInt16BE(2);
		if (protocolId !== 0) return null; // Not Modbus

		const mbapLength = payload.readUInt16BE(4);
		const unitId = payload[6];
		const fc = payload[7];

		const details: Record<string, string | number | boolean> = {
			transactionId,
			unitId,
		};

		// Exception response: FC >= 0x80
		if (fc >= 0x80) {
			const origFc = fc - 0x80;
			const fcName = FC_NAMES[origFc] ?? `FC${origFc}`;
			details.functionCode = origFc;
			details.functionName = fcName;
			const excCode = payload.length > 8 ? payload[8] : 0;
			details.exceptionCode = excCode;
			details.exception = EXCEPTION_CODES[excCode] ?? `Unknown (${excCode})`;
			return {
				operation: 'EXCEPTION',
				summary: `Exception FC${origFc} ${fcName} — ${details.exception} unit=${unitId}`,
				status: 'error',
				details,
			};
		}

		const fcName = FC_NAMES[fc] ?? `FC${fc}`;
		details.functionCode = fc;
		details.functionName = fcName;

		// Determine if request or response based on MBAP length
		// Request for FC 1-4: length = 6 (unitId + FC + startAddr[2] + qty[2])
		// Response for FC 1-4: length = 3 + byteCount (unitId + FC + byteCount + data...)
		if (fc >= 1 && fc <= 4) {
			if (mbapLength === 6 && payload.length >= 12) {
				// Request: start address + quantity
				const addr = payload.readUInt16BE(8);
				const qty = payload.readUInt16BE(10);
				details.direction = 'request';
				details.startAddress = addr;
				details.quantity = qty;
				return {
					operation: fcName,
					summary: `Request FC${fc} ${fcName} addr=${addr} qty=${qty} unit=${unitId}`,
					status: 'ok',
					details,
				};
			} else {
				// Response: byte count + data
				const byteCount = payload.length > 8 ? payload[8] : 0;
				details.direction = 'response';
				details.byteCount = byteCount;
				return {
					operation: fcName,
					summary: `Response FC${fc} ${fcName} ${byteCount} bytes unit=${unitId}`,
					status: 'ok',
					details,
				};
			}
		}

		if (fc === 5 && payload.length >= 12) {
			const addr = payload.readUInt16BE(8);
			const value = payload.readUInt16BE(10);
			const coilState = value === 0xff00;
			details.address = addr;
			details.value = coilState ? 'ON' : 'OFF';
			return {
				operation: fcName,
				summary: `FC${fc} ${fcName} addr=${addr} value=${details.value} unit=${unitId}`,
				status: 'ok',
				details,
			};
		}

		if (fc === 6 && payload.length >= 12) {
			const addr = payload.readUInt16BE(8);
			const value = payload.readUInt16BE(10);
			details.address = addr;
			details.value = value;
			return {
				operation: fcName,
				summary: `FC${fc} ${fcName} addr=${addr} value=${value} unit=${unitId}`,
				status: 'ok',
				details,
			};
		}

		if ((fc === 15 || fc === 16) && payload.length >= 12) {
			if (mbapLength === 6) {
				// Echo response
				const addr = payload.readUInt16BE(8);
				const qty = payload.readUInt16BE(10);
				details.direction = 'response';
				details.startAddress = addr;
				details.quantity = qty;
				return {
					operation: fcName,
					summary: `Response FC${fc} ${fcName} addr=${addr} qty=${qty} unit=${unitId}`,
					status: 'ok',
					details,
				};
			} else {
				// Request with data
				const addr = payload.readUInt16BE(8);
				const qty = payload.readUInt16BE(10);
				details.direction = 'request';
				details.startAddress = addr;
				details.quantity = qty;
				return {
					operation: fcName,
					summary: `Request FC${fc} ${fcName} addr=${addr} qty=${qty} unit=${unitId}`,
					status: 'ok',
					details,
				};
			}
		}

		return {
			operation: fcName,
			summary: `FC${fc} ${fcName} unit=${unitId}`,
			status: 'ok',
			details,
		};
	}
}
