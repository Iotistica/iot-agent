/**
 * Bounded OPC UA Binary decoding utilities.
 * Every read returns null on bounds violation — never throws.
 * On a failed string/bytestring read, the cursor rewinds to before
 * the length prefix so subsequent reads remain aligned.
 */

export class OpcUaReader {
	private pos: number;
	private readonly end: number;

	constructor(
		private readonly buf: Buffer,
		offset = 0,
		length?: number,
	) {
		this.pos = offset;
		this.end = length !== undefined
			? Math.min(offset + length, buf.length)
			: buf.length;
	}

	get offset(): number { return this.pos; }
	get remaining(): number { return this.end - this.pos; }

	readUInt8(): number | null {
		if (this.pos + 1 > this.end) return null;
		return this.buf[this.pos++];
	}

	readUInt16LE(): number | null {
		if (this.pos + 2 > this.end) return null;
		const v = this.buf.readUInt16LE(this.pos);
		this.pos += 2;
		return v;
	}

	readUInt32LE(): number | null {
		if (this.pos + 4 > this.end) return null;
		const v = this.buf.readUInt32LE(this.pos);
		this.pos += 4;
		return v;
	}

	readInt32LE(): number | null {
		if (this.pos + 4 > this.end) return null;
		const v = this.buf.readInt32LE(this.pos);
		this.pos += 4;
		return v;
	}

	/**
	 * OPC UA String: Int32LE length prefix, -1 = null.
	 * Returns the string value (or null for null-string).
	 * Returns undefined on bounds/limit violation; cursor rewinds
	 * to before the length prefix so later reads stay aligned.
	 */
	readString(maxLength = 4096): string | null | undefined {
		const saved = this.pos;
		const len = this.readInt32LE();
		if (len === null) return undefined;
		if (len === -1) return null;
		if (len < 0 || len > maxLength || this.pos + len > this.end) {
			this.pos = saved;
			return undefined;
		}
		const s = this.buf.toString('utf8', this.pos, this.pos + len);
		this.pos += len;
		return s;
	}

	/**
	 * OPC UA ByteString: Int32LE length prefix, -1 = null.
	 * Skips the content, returns only the length.
	 * Rewinds cursor on failure.
	 */
	skipByteString(maxLength = 1_048_576): number | null | undefined {
		const saved = this.pos;
		const len = this.readInt32LE();
		if (len === null) return undefined;
		if (len === -1) return null;
		if (len < 0 || len > maxLength || this.pos + len > this.end) {
			this.pos = saved;
			return undefined;
		}
		this.pos += len;
		return len;
	}

	skip(n: number): boolean {
		if (n < 0 || this.pos + n > this.end) return false;
		this.pos += n;
		return true;
	}
}
