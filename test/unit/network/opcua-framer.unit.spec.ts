import { OpcUaFramer } from '../../../src/network/framers/opcua';

function buildChunk(msgType: string, bodySize: number): Buffer {
	const totalSize = 8 + bodySize;
	const buf = Buffer.alloc(totalSize);
	buf.write(msgType, 0, 3, 'ascii');
	buf[3] = 'F'.charCodeAt(0);
	buf.writeUInt32LE(totalSize, 4);
	return buf;
}

describe('OpcUaFramer', () => {
	it('extracts a single complete message', () => {
		const framer = new OpcUaFramer();
		const chunk = buildChunk('HEL', 24); // 32 bytes total
		const messages = framer.push(chunk, 1);
		expect(messages).toHaveLength(1);
		expect(messages[0].payload.length).toBe(32);
		expect(messages[0].completingPacketId).toBe(1);
	});

	it('extracts message split across two pushes', () => {
		const framer = new OpcUaFramer();
		const chunk = buildChunk('MSG', 100); // 108 bytes total
		const part1 = chunk.subarray(0, 50);
		const part2 = chunk.subarray(50);

		const r1 = framer.push(Buffer.from(part1), 1);
		expect(r1).toHaveLength(0); // incomplete

		const r2 = framer.push(Buffer.from(part2), 2);
		expect(r2).toHaveLength(1);
		expect(r2[0].payload.length).toBe(108);
		expect(r2[0].completingPacketId).toBe(2);
	});

	it('extracts two messages from one push', () => {
		const framer = new OpcUaFramer();
		const c1 = buildChunk('HEL', 24); // 32
		const c2 = buildChunk('ACK', 20); // 28
		const combined = Buffer.concat([c1, c2]);

		const messages = framer.push(combined, 5);
		expect(messages).toHaveLength(2);
		expect(messages[0].payload.length).toBe(32);
		expect(messages[1].payload.length).toBe(28);
	});

	it('extracts message spanning three pushes', () => {
		const framer = new OpcUaFramer();
		const chunk = buildChunk('OPN', 200); // 208 bytes
		const p1 = chunk.subarray(0, 4);   // partial header
		const p2 = chunk.subarray(4, 100);
		const p3 = chunk.subarray(100);

		expect(framer.push(Buffer.from(p1), 1)).toHaveLength(0);
		expect(framer.push(Buffer.from(p2), 2)).toHaveLength(0);
		const r = framer.push(Buffer.from(p3), 3);
		expect(r).toHaveLength(1);
		expect(r[0].payload.length).toBe(208);
		expect(r[0].completingPacketId).toBe(3);
	});

	it('resets on invalid message type (lost sync)', () => {
		const framer = new OpcUaFramer();
		const garbage = Buffer.from('XYZF\x10\x00\x00\x00abcdefgh');
		const messages = framer.push(garbage, 1);
		expect(messages).toHaveLength(0);

		// Subsequent valid message should work after sync loss
		const chunk = buildChunk('HEL', 24);
		const r = framer.push(chunk, 2);
		expect(r).toHaveLength(1);
	});

	it('resets on oversized messageSize', () => {
		const framer = new OpcUaFramer(1024); // 1KB limit
		const buf = Buffer.alloc(8);
		buf.write('MSG', 0, 3, 'ascii');
		buf[3] = 'F'.charCodeAt(0);
		buf.writeUInt32LE(2000, 4); // exceeds 1024 limit
		const messages = framer.push(buf, 1);
		expect(messages).toHaveLength(0);
	});

	it('waits when incomplete header (< 8 bytes)', () => {
		const framer = new OpcUaFramer();
		const partial = Buffer.from('MSGF'); // only 4 bytes
		expect(framer.push(partial, 1)).toHaveLength(0);

		// Complete the header + body
		const chunk = buildChunk('MSG', 8); // 16 bytes total
		const rest = chunk.subarray(4);
		const r = framer.push(Buffer.from(rest), 2);
		expect(r).toHaveLength(1);
		expect(r[0].payload.length).toBe(16);
	});

	it('handles messageSize of exactly 8 (header only)', () => {
		const framer = new OpcUaFramer();
		const chunk = buildChunk('ERR', 0); // 8 bytes, no body
		const r = framer.push(chunk, 1);
		expect(r).toHaveLength(1);
		expect(r[0].payload.length).toBe(8);
	});

	it('reset clears buffered state', () => {
		const framer = new OpcUaFramer();
		const chunk = buildChunk('MSG', 100);
		framer.push(Buffer.from(chunk.subarray(0, 50)), 1);
		framer.reset();

		// The partial data should be gone; a new valid message works
		const fresh = buildChunk('HEL', 24);
		const r = framer.push(fresh, 2);
		expect(r).toHaveLength(1);
	});

	it('handles empty push', () => {
		const framer = new OpcUaFramer();
		expect(framer.push(Buffer.alloc(0), 1)).toHaveLength(0);
	});

	it('coalesced + split: two messages where second spans two pushes', () => {
		const framer = new OpcUaFramer();
		const c1 = buildChunk('HEL', 24); // 32 bytes
		const c2 = buildChunk('MSG', 100); // 108 bytes
		const combined = Buffer.concat([c1, c2]);
		const part1 = combined.subarray(0, 60); // all of c1 + partial c2
		const part2 = combined.subarray(60);     // rest of c2

		const r1 = framer.push(Buffer.from(part1), 1);
		expect(r1).toHaveLength(1); // c1 extracted
		expect(r1[0].payload.length).toBe(32);

		const r2 = framer.push(Buffer.from(part2), 2);
		expect(r2).toHaveLength(1); // c2 extracted
		expect(r2[0].payload.length).toBe(108);
		expect(r2[0].completingPacketId).toBe(2);
	});
});
