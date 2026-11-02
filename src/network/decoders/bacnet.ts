import type { ProtocolDecoder, PacketMeta, DecodedPacket } from './index.js';

// ── BVLC ──────────────────────────────────────────────────────────────────

const BVLC_FUNCTIONS: Record<number, string> = {
	0x00: 'BVLC-Result',
	0x04: 'Forwarded-NPDU',
	0x05: 'Register-Foreign-Device',
	0x09: 'Distribute-Broadcast-To-Network',
	0x0a: 'Original-Unicast-NPDU',
	0x0b: 'Original-Broadcast-NPDU',
};

// ── APDU confirmed services ───────────────────────────────────────────────

const CONFIRMED_SERVICES: Record<number, string> = {
	0: 'AcknowledgeAlarm', 1: 'COVNotification', 2: 'EventNotification',
	5: 'SubscribeCOV', 6: 'AtomicReadFile', 7: 'AtomicWriteFile',
	12: 'ReadProperty', 14: 'ReadPropertyMultiple',
	15: 'WriteProperty', 16: 'WritePropertyMultiple',
	17: 'DeviceCommunicationControl', 20: 'ReinitializeDevice',
	26: 'ReadRange',
};

const UNCONFIRMED_SERVICES: Record<number, string> = {
	0: 'I-Am', 1: 'I-Have',
	2: 'Unconfirmed-COV-Notification', 3: 'Unconfirmed-Event-Notification',
	4: 'Unconfirmed-Private-Transfer', 5: 'Unconfirmed-Text-Message',
	6: 'Time-Synchronization', 7: 'Who-Has', 8: 'Who-Is',
	9: 'UTC-Time-Synchronization', 10: 'Write-Group',
};

// ── Object types & properties ─────────────────────────────────────────────

const OBJECT_TYPES: Record<number, string> = {
	0: 'analog-input', 1: 'analog-output', 2: 'analog-value',
	3: 'binary-input', 4: 'binary-output', 5: 'binary-value',
	6: 'calendar', 7: 'command', 8: 'device',
	9: 'event-enrollment', 10: 'file', 11: 'group',
	12: 'loop', 13: 'multi-state-input', 14: 'multi-state-output',
	15: 'notification-class', 16: 'program', 17: 'schedule',
	19: 'multi-state-value', 20: 'trend-log',
};

const PROPERTY_IDS: Record<number, string> = {
	28: 'description', 70: 'model-name', 75: 'object-identifier',
	76: 'object-list', 77: 'object-name', 79: 'object-type',
	81: 'out-of-service', 85: 'present-value', 87: 'priority-array',
	103: 'reliability', 104: 'relinquish-default',
	111: 'status-flags', 117: 'units', 121: 'vendor-name',
};

// ── Error tables ──────────────────────────────────────────────────────────

const ERROR_CLASSES: Record<number, string> = {
	0: 'device', 1: 'object', 2: 'property', 3: 'resources',
	4: 'security', 5: 'services', 6: 'virtual-terminal', 7: 'communication',
};

const ERROR_CODES: Record<number, string> = {
	0: 'other', 9: 'device-busy', 31: 'unknown-object',
	32: 'unknown-property', 40: 'write-access-denied',
	42: 'read-access-denied', 47: 'value-out-of-range',
};

const REJECT_REASONS: Record<number, string> = {
	0: 'other', 1: 'buffer-overflow', 2: 'inconsistent-parameters',
	3: 'invalid-parameter-data-type', 4: 'invalid-tag',
	5: 'missing-required-parameter', 6: 'parameter-out-of-range',
	7: 'too-many-arguments', 8: 'undefined-enumeration',
	9: 'unrecognized-service',
};

const ABORT_REASONS: Record<number, string> = {
	0: 'other', 1: 'buffer-overflow', 2: 'invalid-apdu-in-this-state',
	3: 'preempted-by-higher-priority-task', 4: 'segmentation-not-supported',
	5: 'security-error', 6: 'insufficient-security',
	9: 'out-of-resources', 10: 'tsm-timeout', 11: 'apdu-too-long',
};

// ── Helpers ───────────────────────────────────────────────────────────────

function decodeObjectIdentifier(buf: Buffer, offset: number): { type: string; instance: number } | null {
	if (offset + 4 > buf.length) return null;
	const value = buf.readUInt32BE(offset);
	const typeCode = value >>> 22;
	const instance = value & 0x3fffff;
	return { type: OBJECT_TYPES[typeCode] ?? `type-${typeCode}`, instance };
}

function readContextUnsigned(buf: Buffer, offset: number, expectedTag: number): { value: number; end: number } | null {
	if (offset >= buf.length) return null;
	const tagByte = buf[offset];
	const tagNumber = tagByte >> 4;
	if (tagNumber !== expectedTag) return null;
	if ((tagByte & 0x08) === 0) return null; // must be context-tagged
	let len = tagByte & 0x07;
	let pos = offset + 1;
	if (len === 5 && pos < buf.length) {
		len = buf[pos++];
	}
	if (pos + len > buf.length) return null;
	let value = 0;
	for (let i = 0; i < len; i++) value = (value << 8) | buf[pos + i];
	return { value, end: pos + len };
}

function readContextObjectId(buf: Buffer, offset: number, expectedTag: number): { type: string; instance: number; end: number } | null {
	if (offset >= buf.length) return null;
	const tagByte = buf[offset];
	const tagNumber = tagByte >> 4;
	if (tagNumber !== expectedTag) return null;
	if ((tagByte & 0x08) === 0) return null;
	let len = tagByte & 0x07;
	let pos = offset + 1;
	if (len === 5 && pos < buf.length) {
		len = buf[pos++];
	}
	if (len !== 4 || pos + 4 > buf.length) return null;
	const obj = decodeObjectIdentifier(buf, pos);
	if (!obj) return null;
	return { ...obj, end: pos + 4 };
}

// ── Decoder ───────────────────────────────────────────────────────────────

export class BacnetDecoder implements ProtocolDecoder {
	readonly protocols = ['BACnet/IP'];

	decode(payload: Buffer, _meta: PacketMeta): DecodedPacket | null {
		if (payload.length < 4) return null;

		// BVLC header
		const bvlcType = payload[0];
		if (bvlcType !== 0x81) return null;

		const bvlcFunction = payload[1];
		const bvlcName = BVLC_FUNCTIONS[bvlcFunction] ?? `Function-0x${bvlcFunction.toString(16)}`;

		const details: Record<string, string | number | boolean> = {
			bvlcFunction: bvlcName,
		};

		// Determine NPDU offset
		let npduOffset = 4;
		if (bvlcFunction === 0x04) {
			// Forwarded-NPDU: 6-byte originating address after BVLC header
			npduOffset = 10;
		}

		if (npduOffset >= payload.length) {
			return { operation: bvlcName, summary: `BACnet ${bvlcName}`, status: 'ok', details };
		}

		// BVLC-only messages (no NPDU/APDU)
		if (bvlcFunction === 0x00 || bvlcFunction === 0x05) {
			return { operation: bvlcName, summary: `BACnet ${bvlcName}`, status: 'ok', details };
		}

		// NPDU
		const npduResult = this.parseNpdu(payload, npduOffset, details);
		if (!npduResult) {
			return { operation: bvlcName, summary: `BACnet ${bvlcName}`, status: 'ok', details };
		}

		if (npduResult.isNetworkMessage) {
			details.networkMessageType = npduResult.networkMessageType ?? 0;
			return { operation: 'NetworkMessage', summary: `BACnet Network msg=${npduResult.networkMessageType}`, status: 'ok', details };
		}

		// APDU
		return this.parseApdu(payload, npduResult.apduOffset, details);
	}

	private parseNpdu(buf: Buffer, offset: number, details: Record<string, string | number | boolean>): {
		apduOffset: number;
		isNetworkMessage: boolean;
		networkMessageType?: number;
	} | null {
		if (offset + 2 > buf.length) return null;
		const version = buf[offset];
		if (version !== 0x01) return null;

		const control = buf[offset + 1];
		const isNetworkMessage = !!(control & 0x80);
		const hasDest = !!(control & 0x20);
		const hasSrc = !!(control & 0x08);
		details.expectingReply = !!(control & 0x04);

		let pos = offset + 2;

		// Skip destination spec
		if (hasDest && pos + 3 <= buf.length) {
			pos += 2; // dest network
			const destLen = buf[pos++];
			pos += destLen; // dest mac
		}

		// Skip source spec
		if (hasSrc && pos + 3 <= buf.length) {
			pos += 2; // src network
			const srcLen = buf[pos++];
			pos += srcLen; // src mac
		}

		// Hop count follows destination
		if (hasDest && pos < buf.length) pos++;

		if (isNetworkMessage) {
			const msgType = pos < buf.length ? buf[pos] : 0;
			return { apduOffset: pos, isNetworkMessage: true, networkMessageType: msgType };
		}

		return { apduOffset: pos, isNetworkMessage: false };
	}

	private parseApdu(buf: Buffer, offset: number, details: Record<string, string | number | boolean>): DecodedPacket {
		if (offset >= buf.length) {
			return { operation: 'BACnet', summary: 'BACnet (truncated APDU)', status: 'warning', details };
		}

		const apduType = (buf[offset] >> 4) & 0x0f;

		switch (apduType) {
			case 0: return this.decodeConfirmedRequest(buf, offset, details);
			case 1: return this.decodeUnconfirmedRequest(buf, offset, details);
			case 2: return this.decodeSimpleAck(buf, offset, details);
			case 3: return this.decodeComplexAck(buf, offset, details);
			case 5: return this.decodeError(buf, offset, details);
			case 6: return this.decodeReject(buf, offset, details);
			case 7: return this.decodeAbort(buf, offset, details);
			default:
				return { operation: `APDU-${apduType}`, summary: `BACnet APDU type=${apduType}`, status: 'ok', details };
		}
	}

	private decodeConfirmedRequest(buf: Buffer, offset: number, details: Record<string, string | number | boolean>): DecodedPacket {
		if (offset + 3 >= buf.length) {
			return { operation: 'ConfirmedRequest', summary: 'BACnet Confirmed-Request', status: 'ok', details };
		}

		const byte0 = buf[offset];
		const segmented = !!(byte0 & 0x08);
		let pos = offset + 1;

		// max-segments + max-APDU
		pos++; // skip max-segments/max-APDU byte
		const invokeId = buf[pos++];
		details.invokeId = invokeId;

		if (segmented && pos + 2 <= buf.length) {
			pos += 2; // skip sequence-number + proposed-window-size
		}

		if (pos >= buf.length) {
			return { operation: 'ConfirmedRequest', summary: 'BACnet Confirmed-Request', status: 'ok', details };
		}

		const serviceChoice = buf[pos++];
		const serviceName = CONFIRMED_SERVICES[serviceChoice] ?? `Service-${serviceChoice}`;
		details.service = serviceName;

		// Decode service-specific data
		if (serviceChoice === 12 || serviceChoice === 15) {
			// ReadProperty / WriteProperty: tag 0 = objectIdentifier, tag 1 = propertyIdentifier
			const objId = readContextObjectId(buf, pos, 0);
			if (objId) {
				details.objectType = objId.type;
				details.objectInstance = objId.instance;
				pos = objId.end;

				const propId = readContextUnsigned(buf, pos, 1);
				if (propId) {
					details.property = PROPERTY_IDS[propId.value] ?? `prop-${propId.value}`;
					details.propertyId = propId.value;
				}
			}
		}

		const objStr = details.objectType ? ` ${details.objectType}:${details.objectInstance}` : '';
		const propStr = details.property ? ` ${details.property}` : '';
		return {
			operation: serviceName,
			summary: `BACnet ${serviceName}${objStr}${propStr}`,
			status: 'ok',
			details,
		};
	}

	private decodeUnconfirmedRequest(buf: Buffer, offset: number, details: Record<string, string | number | boolean>): DecodedPacket {
		if (offset + 2 > buf.length) {
			return { operation: 'UnconfirmedRequest', summary: 'BACnet Unconfirmed-Request', status: 'ok', details };
		}

		const serviceChoice = buf[offset + 1];
		const serviceName = UNCONFIRMED_SERVICES[serviceChoice] ?? `Unconfirmed-${serviceChoice}`;
		details.service = serviceName;
		const pos = offset + 2;

		if (serviceChoice === 0) {
			// I-Am: application-tagged objectIdentifier (app tag 12, 4 bytes)
			if (pos + 6 <= buf.length) {
				const tagByte = buf[pos];
				if ((tagByte >> 4) === 12 && (tagByte & 0x07) === 4) {
					const obj = decodeObjectIdentifier(buf, pos + 1);
					if (obj) {
						details.objectType = obj.type;
						details.objectInstance = obj.instance;
					}
				}
			}
			const instStr = details.objectInstance !== undefined ? ` device:${details.objectInstance}` : '';
			return { operation: 'I-Am', summary: `BACnet I-Am${instStr}`, status: 'ok', details };
		}

		if (serviceChoice === 8) {
			// Who-Is: optional range limits
			return { operation: 'Who-Is', summary: 'BACnet Who-Is', status: 'ok', details };
		}

		return { operation: serviceName, summary: `BACnet ${serviceName}`, status: 'ok', details };
	}

	private decodeSimpleAck(buf: Buffer, offset: number, details: Record<string, string | number | boolean>): DecodedPacket {
		if (offset + 3 > buf.length) {
			return { operation: 'SimpleACK', summary: 'BACnet Simple-ACK', status: 'ok', details };
		}
		const invokeId = buf[offset + 1];
		const serviceChoice = buf[offset + 2];
		const serviceName = CONFIRMED_SERVICES[serviceChoice] ?? `Service-${serviceChoice}`;
		details.invokeId = invokeId;
		details.service = serviceName;
		return { operation: 'SimpleACK', summary: `BACnet Simple-ACK ${serviceName}`, status: 'ok', details };
	}

	private decodeComplexAck(buf: Buffer, offset: number, details: Record<string, string | number | boolean>): DecodedPacket {
		if (offset + 3 > buf.length) {
			return { operation: 'ComplexACK', summary: 'BACnet Complex-ACK', status: 'ok', details };
		}

		const byte0 = buf[offset];
		const segmented = !!(byte0 & 0x08);
		let pos = offset + 1;

		const invokeId = buf[pos++];
		details.invokeId = invokeId;

		if (segmented && pos + 2 <= buf.length) {
			pos += 2; // skip sequence-number + proposed-window-size
		}

		if (pos >= buf.length) {
			return { operation: 'ComplexACK', summary: 'BACnet Complex-ACK', status: 'ok', details };
		}

		const serviceChoice = buf[pos++];
		const serviceName = CONFIRMED_SERVICES[serviceChoice] ?? `Service-${serviceChoice}`;
		details.service = serviceName;

		// For ReadPropertyACK, try to extract object and property
		if (serviceChoice === 12) {
			const objId = readContextObjectId(buf, pos, 0);
			if (objId) {
				details.objectType = objId.type;
				details.objectInstance = objId.instance;
				pos = objId.end;
				const propId = readContextUnsigned(buf, pos, 1);
				if (propId) {
					details.property = PROPERTY_IDS[propId.value] ?? `prop-${propId.value}`;
				}
			}
		}

		const objStr = details.objectType ? ` ${details.objectType}:${details.objectInstance}` : '';
		const propStr = details.property ? ` ${details.property}` : '';
		return {
			operation: `${serviceName}ACK`,
			summary: `BACnet ${serviceName}ACK${objStr}${propStr}`,
			status: 'ok',
			details,
		};
	}

	private decodeError(buf: Buffer, offset: number, details: Record<string, string | number | boolean>): DecodedPacket {
		if (offset + 3 > buf.length) {
			return { operation: 'Error', summary: 'BACnet Error', status: 'error', details };
		}
		const invokeId = buf[offset + 1];
		const serviceChoice = buf[offset + 2];
		const serviceName = CONFIRMED_SERVICES[serviceChoice] ?? `Service-${serviceChoice}`;
		details.invokeId = invokeId;
		details.service = serviceName;

		// Try to read error class and code (application-tagged enumerateds)
		let pos = offset + 3;
		if (pos + 2 <= buf.length) {
			const classTag = buf[pos];
			if ((classTag >> 4) === 9) { // app tag 9 = enumerated
				const classLen = classTag & 0x07;
				if (classLen >= 1 && pos + 1 + classLen <= buf.length) {
					let errorClass = 0;
					for (let i = 0; i < classLen; i++) errorClass = (errorClass << 8) | buf[pos + 1 + i];
					details.errorClass = ERROR_CLASSES[errorClass] ?? `class-${errorClass}`;
					pos += 1 + classLen;
				}
			}
		}
		if (pos + 2 <= buf.length) {
			const codeTag = buf[pos];
			if ((codeTag >> 4) === 9) {
				const codeLen = codeTag & 0x07;
				if (codeLen >= 1 && pos + 1 + codeLen <= buf.length) {
					let errorCode = 0;
					for (let i = 0; i < codeLen; i++) errorCode = (errorCode << 8) | buf[pos + 1 + i];
					details.errorCode = ERROR_CODES[errorCode] ?? `code-${errorCode}`;
				}
			}
		}

		const errStr = details.errorCode ? ` ${details.errorClass}/${details.errorCode}` : '';
		return {
			operation: 'Error',
			summary: `BACnet Error ${serviceName}${errStr}`,
			status: 'error',
			details,
		};
	}

	private decodeReject(buf: Buffer, offset: number, details: Record<string, string | number | boolean>): DecodedPacket {
		if (offset + 3 > buf.length) {
			return { operation: 'Reject', summary: 'BACnet Reject', status: 'error', details };
		}
		const invokeId = buf[offset + 1];
		const reason = buf[offset + 2];
		details.invokeId = invokeId;
		details.reason = REJECT_REASONS[reason] ?? `reason-${reason}`;
		return {
			operation: 'Reject',
			summary: `BACnet Reject ${details.reason}`,
			status: 'error',
			details,
		};
	}

	private decodeAbort(buf: Buffer, offset: number, details: Record<string, string | number | boolean>): DecodedPacket {
		if (offset + 3 > buf.length) {
			return { operation: 'Abort', summary: 'BACnet Abort', status: 'error', details };
		}
		const invokeId = buf[offset + 1];
		const reason = buf[offset + 2];
		details.invokeId = invokeId;
		details.reason = ABORT_REASONS[reason] ?? `reason-${reason}`;
		return {
			operation: 'Abort',
			summary: `BACnet Abort ${details.reason}`,
			status: 'error',
			details,
		};
	}
}
