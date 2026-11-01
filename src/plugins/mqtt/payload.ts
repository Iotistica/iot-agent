/**
 * MQTT Payload Parser Utilities
 *
 * Pure functions for parsing and type-coercing MQTT payloads.
 *
 * @module mqtt/payload-parser
 */

/**
 * Parse MQTT payload buffer into a usable value.
 *
 * Strategy:
 * 1. Detect binary (non-UTF-8) payloads and return a marker object
 * 2. Try JSON parse
 * 3. Fall back to plain text string
 */
export function parsePayload(payload: Buffer): unknown {
	if (!isUtf8(payload)) {
		return { _raw: payload.toString('base64'), _binary: true };
	}

	const str = payload.toString();

	try {
		return JSON.parse(str);
	} catch {
		return str;
	}
}

function isUtf8(buf: Buffer): boolean {
	if (buf.length === 0) return true;

	for (let i = 0; i < Math.min(buf.length, 256); i++) {
		if (buf[i] === 0 && i < buf.length - 1) return false;
	}

	try {
		const decoder = new TextDecoder('utf-8', { fatal: true });
		decoder.decode(buf.subarray(0, Math.min(buf.length, 1024)));
		return true;
	} catch {
		return false;
	}
}

export function isBinaryPayload(parsed: unknown): parsed is { _raw: string; _binary: true } {
	return (
		typeof parsed === 'object' &&
		parsed !== null &&
		(parsed as any)._binary === true &&
		typeof (parsed as any)._raw === 'string'
	);
}

/**
 * Coerce value to expected dataType
 *
 * Supports both:
 * - Broad types from discovery: 'number', 'boolean', 'string', 'json'
 * - Specific types from manual config: 'int32', 'float32', 'uint32'
 *
 * @throws Error if coercion results in NaN for numeric types
 */
export function coerceType(
	value: any,
	dataType: string,
): number | boolean | string {
	const valueForError =
		typeof value === "object" && value !== null
			? JSON.stringify(value)
			: String(value);

	switch (dataType) {
		case "number":
		case "float":
		case "float32":
		case "double": {
			const n = parseFloat(value);
			if (Number.isNaN(n)) {
				throw new Error(
					`Numeric coercion resulted in NaN for value: "${valueForError}"`,
				);
			}
			return n;
		}
		case "int":
		case "int16":
		case "int32":
		case "integer": {
			const n = parseInt(value, 10);
			if (Number.isNaN(n)) {
				throw new Error(
					`Numeric coercion resulted in NaN for value: "${valueForError}"`,
				);
			}
			return n;
		}
		case "uint16":
		case "uint32": {
			const n = Math.abs(parseInt(value, 10));
			if (Number.isNaN(n)) {
				throw new Error(
					`Numeric coercion resulted in NaN for value: "${valueForError}"`,
				);
			}
			return n;
		}
		case "boolean":
			return value === "true" || value === "1" || value === 1 || value === true;
		case "json":
			return typeof value === "object" && value !== null
				? JSON.stringify(value)
				: String(value);
		case "string":
			return String(value);
		default:
			return String(value);
	}
}
