import type { ProtocolDecoder, PacketMeta, DecodedPacket } from './index.js';

const RECORD_TYPES: Record<number, string> = {
	1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA', 12: 'PTR', 15: 'MX',
	16: 'TXT', 28: 'AAAA', 33: 'SRV', 35: 'NAPTR', 43: 'DS',
	46: 'RRSIG', 48: 'DNSKEY', 65: 'HTTPS', 255: 'ANY',
};

const RCODES: Record<number, string> = {
	0: 'NOERROR', 1: 'FORMERR', 2: 'SERVFAIL', 3: 'NXDOMAIN', 5: 'REFUSED',
};

export class DnsDecoder implements ProtocolDecoder {
	readonly protocols = ['DNS'];

	decode(payload: Buffer, _meta: PacketMeta): DecodedPacket | null {
		if (payload.length < 12) return null;

		const id = payload.readUInt16BE(0);
		const flags = payload.readUInt16BE(2);
		const qr = (flags >> 15) & 1; // 0=query, 1=response
		const opcode = (flags >> 11) & 0x0f;
		const rcode = flags & 0x0f;
		const qdCount = payload.readUInt16BE(4);
		const anCount = payload.readUInt16BE(6);

		const details: Record<string, string | number | boolean> = {
			id,
			type: qr === 0 ? 'Query' : 'Response',
			opcode,
		};

		// Parse first question
		let qname = '';
		let qtype = '';
		if (qdCount > 0) {
			const result = this.readQName(payload, 12);
			if (result) {
				qname = result.name;
				const qtypeOffset = result.offset;
				if (qtypeOffset + 4 <= payload.length) {
					const qtypeNum = payload.readUInt16BE(qtypeOffset);
					qtype = RECORD_TYPES[qtypeNum] ?? `TYPE${qtypeNum}`;
					details.queryType = qtype;
				}
				details.queryName = qname;
			}
		}

		if (qr === 0) {
			// Query
			const qtypeStr = qtype || '?';
			return {
				operation: 'QUERY',
				summary: `Query ${qtypeStr} ${qname || '?'}`,
				status: 'ok',
				details,
			};
		} else {
			// Response
			details.answerCount = anCount;
			details.rcode = rcode;
			const rcodeName = RCODES[rcode] ?? `RCODE${rcode}`;
			details.rcodeName = rcodeName;

			if (rcode !== 0) {
				return {
					operation: 'RESPONSE',
					summary: `Response ${rcodeName} ${qname || '?'}`,
					status: rcode === 3 ? 'warning' : 'error',
					details,
				};
			}
			const qtypeStr = qtype || '?';
			return {
				operation: 'RESPONSE',
				summary: `Response ${qtypeStr} ${qname || '?'} answers=${anCount}`,
				status: 'ok',
				details,
			};
		}
	}

	private readQName(buf: Buffer, offset: number): { name: string; offset: number } | null {
		const labels: string[] = [];
		let pos = offset;
		let jumped = false;
		let jumpedOffset = 0;

		for (let i = 0; i < 64; i++) { // safety limit
			if (pos >= buf.length) return null;
			const len = buf[pos];

			if (len === 0) {
				pos++;
				break;
			}

			// Compression pointer
			if ((len & 0xc0) === 0xc0) {
				if (pos + 1 >= buf.length) return null;
				if (!jumped) jumpedOffset = pos + 2;
				jumped = true;
				pos = ((len & 0x3f) << 8) | buf[pos + 1];
				continue;
			}

			pos++;
			if (pos + len > buf.length) return null;
			labels.push(buf.toString('utf8', pos, pos + len));
			pos += len;
		}

		return {
			name: labels.join('.'),
			offset: jumped ? jumpedOffset : pos,
		};
	}
}
