/**
 * Bounded OPC UA Binary decoding utilities.
 * Every read returns null on bounds violation — never throws.
 */

export interface ReadResult<T> {
	value: T;
	bytesRead: number;
}

export class OpcUaReader {
	private pos: number;

	constructor(
		private readonly buf: Buffer,
		offset = 0,
	) {
		this.pos = offset;
	}

	get offset(): number { return this.pos; }
	get remaining(): number { return this.buf.length - this.pos; }

	readUInt8(): number | null {
		if (this.pos + 1 > this.buf.length) return null;
		return this.buf[this.pos++];
	}

	readUInt16LE(): number | null {
		if (this.pos + 2 > this.buf.length) return null;
		const v = this.buf.readUInt16LE(this.pos);
		this.pos += 2;
		return v;
	}

	readUInt32LE(): number | null {
		if (this.pos + 4 > this.buf.length) return null;
		const v = this.buf.readUInt32LE(this.pos);
		this.pos += 4;
		return v;
	}

	readInt32LE(): number | null {
		if (this.pos + 4 > this.buf.length) return null;
		const v = this.buf.readInt32LE(this.pos);
		this.pos += 4;
		return v;
	}

	/**
	 * OPC UA String: Int32LE length prefix, -1 = null.
	 * Returns the string value (or null for null-string).
	 * Returns undefined on bounds/limit violation.
	 */
	readString(maxLength = 4096): string | null | undefined {
		const len = this.readInt32LE();
		if (len === null) return undefined;
		if (len === -1) return null;
		if (len < 0 || len > maxLength) return undefined;
		if (this.pos + len > this.buf.length) return undefined;
		const s = this.buf.toString('utf8', this.pos, this.pos + len);
		this.pos += len;
		return s;
	}

	/**
	 * OPC UA ByteString: Int32LE length prefix, -1 = null.
	 * Skips the content, returns only the length (for certificates we don't dump).
	 */
	skipByteString(maxLength = 1_048_576): number | null | undefined {
		const len = this.readInt32LE();
		if (len === null) return undefined;
		if (len === -1) return null;
		if (len < 0 || len > maxLength) return undefined;
		if (this.pos + len > this.buf.length) return undefined;
		this.pos += len;
		return len;
	}

	skip(n: number): boolean {
		if (this.pos + n > this.buf.length) return false;
		this.pos += n;
		return true;
	}
}
