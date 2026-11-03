import { TcpAssembler, type TcpStreamHandler, type FlowId } from '../../../src/network/tcp-assembler';
import type { CapturedPacket } from '../../../src/network/capture';
import type { DecodedPacket } from '../../../src/network/decoders/index';

const TCP_SYN = 0x02;
const TCP_ACK = 0x10;
const TCP_FIN = 0x01;
const TCP_RST = 0x04;
const TCP_PSH = 0x08;

function makePacket(overrides: Partial<CapturedPacket> & {
	tcpSeq: number;
	tcpFlags: number;
}): CapturedPacket {
	return {
		id: 1,
		timestamp: Date.now(),
		length: 100,
		capturedLength: 100,
		rawPcap: Buffer.alloc(16),
		appPayload: null,
		srcIp: '10.0.0.1',
		dstIp: '10.0.0.2',
		srcPort: 50000,
		dstPort: 4840,
		ipProtocol: 6,
		protocolName: 'OPC-UA',
		direction: 'outbound',
		info: '',
		tcpSeq: overrides.tcpSeq,
		tcpFlags: overrides.tcpFlags,
		...overrides,
	};
}

interface DataEvent { flowId: FlowId; data: Buffer; packetId: number }
interface GapEvent { flowId: FlowId; expectedSeq: number; gotSeq: number }
interface CloseEvent { flowId: FlowId }

function createTracker() {
	const dataEvents: DataEvent[] = [];
	const gapEvents: GapEvent[] = [];
	const closeEvents: CloseEvent[] = [];

	const handler: TcpStreamHandler = {
		onData(flowId, data, packetId) { dataEvents.push({ flowId, data: Buffer.from(data), packetId }); },
		onGap(flowId, expectedSeq, gotSeq) { gapEvents.push({ flowId, expectedSeq, gotSeq }); },
		onClose(flowId) { closeEvents.push({ flowId }); },
	};

	return { handler, dataEvents, gapEvents, closeEvents };
}

describe('TcpAssembler', () => {
	it('emits data for in-order segments after SYN', () => {
		const { handler, dataEvents } = createTracker();
		const asm = new TcpAssembler(handler);

		asm.feed(makePacket({ id: 1, tcpSeq: 1000, tcpFlags: TCP_SYN | TCP_ACK }));
		expect(dataEvents).toHaveLength(0);

		const payload1 = Buffer.from('hello');
		asm.feed(makePacket({ id: 2, tcpSeq: 1001, tcpFlags: TCP_ACK | TCP_PSH, appPayload: payload1 }));
		expect(dataEvents).toHaveLength(1);
		expect(dataEvents[0].data.toString()).toBe('hello');
		expect(dataEvents[0].packetId).toBe(2);

		const payload2 = Buffer.from(' world');
		asm.feed(makePacket({ id: 3, tcpSeq: 1006, tcpFlags: TCP_ACK | TCP_PSH, appPayload: payload2 }));
		expect(dataEvents).toHaveLength(2);
		expect(dataEvents[1].data.toString()).toBe(' world');
	});

	it('detects gaps and continues', () => {
		const { handler, dataEvents, gapEvents } = createTracker();
		const asm = new TcpAssembler(handler);

		const p1 = Buffer.alloc(100);
		asm.feed(makePacket({ id: 1, tcpSeq: 1000, tcpFlags: TCP_ACK, appPayload: p1 }));
		expect(dataEvents).toHaveLength(1);

		// Gap: expected 1100 but got 1200
		const p2 = Buffer.alloc(50);
		asm.feed(makePacket({ id: 2, tcpSeq: 1200, tcpFlags: TCP_ACK, appPayload: p2 }));
		expect(gapEvents).toHaveLength(1);
		expect(gapEvents[0].expectedSeq).toBe(1100);
		expect(gapEvents[0].gotSeq).toBe(1200);
		expect(dataEvents).toHaveLength(2);
	});

	it('ignores retransmits/duplicates', () => {
		const { handler, dataEvents } = createTracker();
		const asm = new TcpAssembler(handler);

		const p1 = Buffer.alloc(100);
		asm.feed(makePacket({ id: 1, tcpSeq: 1000, tcpFlags: TCP_ACK, appPayload: p1 }));
		expect(dataEvents).toHaveLength(1);

		// Retransmit: seq 1000 again
		asm.feed(makePacket({ id: 2, tcpSeq: 1000, tcpFlags: TCP_ACK, appPayload: p1 }));
		expect(dataEvents).toHaveLength(1); // not emitted again
	});

	it('handles mid-stream join (no SYN)', () => {
		const { handler, dataEvents } = createTracker();
		const asm = new TcpAssembler(handler);

		const p1 = Buffer.from('first');
		asm.feed(makePacket({ id: 1, tcpSeq: 5000, tcpFlags: TCP_ACK, appPayload: p1 }));
		expect(dataEvents).toHaveLength(1);
		expect(dataEvents[0].data.toString()).toBe('first');

		const p2 = Buffer.from('second');
		asm.feed(makePacket({ id: 2, tcpSeq: 5005, tcpFlags: TCP_ACK, appPayload: p2 }));
		expect(dataEvents).toHaveLength(2);
		expect(dataEvents[1].data.toString()).toBe('second');
	});

	it('ignores ACK-only packets (no payload)', () => {
		const { handler, dataEvents } = createTracker();
		const asm = new TcpAssembler(handler);

		asm.feed(makePacket({ id: 1, tcpSeq: 1000, tcpFlags: TCP_ACK, appPayload: null }));
		expect(dataEvents).toHaveLength(0);

		asm.feed(makePacket({ id: 2, tcpSeq: 1000, tcpFlags: TCP_ACK, appPayload: Buffer.alloc(0) }));
		expect(dataEvents).toHaveLength(0);
	});

	it('handles FIN with data', () => {
		const { handler, dataEvents, closeEvents } = createTracker();
		const asm = new TcpAssembler(handler);

		const p1 = Buffer.from('init');
		asm.feed(makePacket({ id: 1, tcpSeq: 1000, tcpFlags: TCP_ACK, appPayload: p1 }));

		const p2 = Buffer.from('final');
		asm.feed(makePacket({ id: 2, tcpSeq: 1004, tcpFlags: TCP_FIN | TCP_ACK, appPayload: p2 }));
		expect(dataEvents).toHaveLength(2);
		expect(dataEvents[1].data.toString()).toBe('final');
		expect(closeEvents).toHaveLength(1);
	});

	it('handles RST', () => {
		const { handler, closeEvents } = createTracker();
		const asm = new TcpAssembler(handler);

		asm.feed(makePacket({ id: 1, tcpSeq: 1000, tcpFlags: TCP_SYN }));
		asm.feed(makePacket({ id: 2, tcpSeq: 0, tcpFlags: TCP_RST }));
		expect(closeEvents).toHaveLength(1);
		expect(asm.flowCount).toBe(0);
	});

	it('tracks flows independently by direction', () => {
		const { handler, dataEvents } = createTracker();
		const asm = new TcpAssembler(handler);

		// Client → Server
		asm.feed(makePacket({
			id: 1, srcIp: '10.0.0.1', srcPort: 50000, dstIp: '10.0.0.2', dstPort: 4840,
			tcpSeq: 1000, tcpFlags: TCP_ACK, appPayload: Buffer.from('req'),
		}));
		// Server → Client
		asm.feed(makePacket({
			id: 2, srcIp: '10.0.0.2', srcPort: 4840, dstIp: '10.0.0.1', dstPort: 50000,
			tcpSeq: 2000, tcpFlags: TCP_ACK, appPayload: Buffer.from('resp'),
		}));

		expect(dataEvents).toHaveLength(2);
		expect(dataEvents[0].flowId).not.toBe(dataEvents[1].flowId);
		expect(asm.flowCount).toBe(2);
	});

	it('evicts stale flows on cleanup', () => {
		const { handler, closeEvents } = createTracker();
		const asm = new TcpAssembler(handler, { inactivityTimeout: 1000 });

		asm.feed(makePacket({ id: 1, tcpSeq: 1000, tcpFlags: TCP_ACK, appPayload: Buffer.from('x'), timestamp: 10000 }));
		expect(asm.flowCount).toBe(1);

		asm.cleanup(12000); // 2s later, past the 1s timeout
		expect(asm.flowCount).toBe(0);
		expect(closeEvents).toHaveLength(1);
	});

	it('evicts oldest flow when max flows reached', () => {
		const { handler, closeEvents } = createTracker();
		const asm = new TcpAssembler(handler, { maxFlows: 2 });

		asm.feed(makePacket({ id: 1, srcPort: 1001, tcpSeq: 100, tcpFlags: TCP_ACK, appPayload: Buffer.from('a'), timestamp: 1000 }));
		asm.feed(makePacket({ id: 2, srcPort: 1002, tcpSeq: 200, tcpFlags: TCP_ACK, appPayload: Buffer.from('b'), timestamp: 2000 }));
		expect(asm.flowCount).toBe(2);

		// Third flow should evict the oldest (port 1001)
		asm.feed(makePacket({ id: 3, srcPort: 1003, tcpSeq: 300, tcpFlags: TCP_ACK, appPayload: Buffer.from('c'), timestamp: 3000 }));
		expect(asm.flowCount).toBe(2);
		expect(closeEvents).toHaveLength(1);
	});

	it('reset clears all state', () => {
		const { handler } = createTracker();
		const asm = new TcpAssembler(handler);

		asm.feed(makePacket({ id: 1, tcpSeq: 1000, tcpFlags: TCP_ACK, appPayload: Buffer.from('x') }));
		expect(asm.flowCount).toBe(1);

		asm.reset();
		expect(asm.flowCount).toBe(0);
	});

	it('skips non-TCP packets', () => {
		const { handler, dataEvents } = createTracker();
		const asm = new TcpAssembler(handler);

		asm.feed(makePacket({ id: 1, ipProtocol: 17, tcpSeq: 1000, tcpFlags: 0, appPayload: Buffer.from('udp') }));
		expect(dataEvents).toHaveLength(0);
	});
});
