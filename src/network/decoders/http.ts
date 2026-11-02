import type { ProtocolDecoder, PacketMeta, DecodedPacket } from './index.js';

const REQUEST_RE = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT|TRACE)\s+(\S+)\s+HTTP\/(\d\.\d)/;
const RESPONSE_RE = /^HTTP\/(\d\.\d)\s+(\d{3})\s*(.*)/;

export class HttpDecoder implements ProtocolDecoder {
	readonly protocols = ['HTTP', 'HTTP-Alt'];

	decode(payload: Buffer, _meta: PacketMeta): DecodedPacket | null {
		if (payload.length < 10) return null;

		// HTTP is text — read first line
		const headerEnd = Math.min(payload.length, 512);
		const text = payload.subarray(0, headerEnd).toString('utf8');
		const firstLineEnd = text.indexOf('\r\n');
		if (firstLineEnd < 0) return null;
		const firstLine = text.substring(0, firstLineEnd);

		const reqMatch = firstLine.match(REQUEST_RE);
		if (reqMatch) return this.decodeRequest(reqMatch, text);

		const resMatch = firstLine.match(RESPONSE_RE);
		if (resMatch) return this.decodeResponse(resMatch, text);

		return null;
	}

	private decodeRequest(match: RegExpMatchArray, headerText: string): DecodedPacket {
		const method = match[1];
		const path = match[2].length > 80 ? match[2].substring(0, 77) + '...' : match[2];
		const version = match[3];
		const details: Record<string, string | number | boolean> = {
			method, path, httpVersion: version,
		};

		const contentType = this.extractHeader(headerText, 'content-type');
		if (contentType) details.contentType = contentType;
		const contentLength = this.extractHeader(headerText, 'content-length');
		if (contentLength) details.contentLength = parseInt(contentLength, 10);
		const host = this.extractHeader(headerText, 'host');
		if (host) details.host = host;

		const ctStr = contentType ? ` ${contentType}` : '';
		return {
			operation: method,
			summary: `${method} ${path}${ctStr}`,
			status: 'ok',
			details,
		};
	}

	private decodeResponse(match: RegExpMatchArray, headerText: string): DecodedPacket {
		const version = match[1];
		const statusCode = parseInt(match[2], 10);
		const reason = match[3].trim();
		const details: Record<string, string | number | boolean> = {
			httpVersion: version, statusCode, reason,
		};

		const contentType = this.extractHeader(headerText, 'content-type');
		if (contentType) details.contentType = contentType;
		const contentLength = this.extractHeader(headerText, 'content-length');
		if (contentLength) details.contentLength = parseInt(contentLength, 10);

		const status: 'ok' | 'error' | 'warning' = statusCode >= 500 ? 'error'
			: statusCode >= 400 ? 'warning' : 'ok';

		const clStr = contentLength ? ` len=${contentLength}` : '';
		return {
			operation: `${statusCode}`,
			summary: `HTTP/${version} ${statusCode} ${reason}${clStr}`,
			status,
			details,
		};
	}

	private extractHeader(text: string, name: string): string | null {
		const re = new RegExp(`^${name}:\\s*(.+)$`, 'im');
		const m = text.match(re);
		return m ? m[1].trim() : null;
	}
}
