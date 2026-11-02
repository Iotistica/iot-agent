import express from 'express';
import type { Request, Response } from 'express';
import { exec } from '../lib/fs-utils.js';
import { getFirewall, getDockerPortBindings, getCaptureEngine } from './actions.js';
import type { CaptureFilter } from '../network/capture.js';
import { requireRole } from './middleware/roles.js';

export const networkRouter = express.Router();

// ── Firewall ────────────────────────────────────────────────────────────────

networkRouter.get('/v1/network/firewall', async (_req: Request, res: Response) => {
	const fw = getFirewall();
	if (!fw) {
		return res.json({
			available: false,
			status: null,
			rules: [],
			reservedPorts: [],
		});
	}

	res.json({
		available: fw.available,
		status: fw.getStatus(),
		rules: fw.getUserRules(),
		reservedPorts: fw.getReservedPorts(),
	});
});

networkRouter.post('/v1/network/firewall/rules', requireRole('admin'), async (req: Request, res: Response) => {
	const fw = getFirewall();
	if (!fw?.available) {
		return res.status(503).json({ error: 'Firewall not available in this deployment mode' });
	}

	const { port, protocol, interface_name, description } = req.body;
	if (!port || typeof port !== 'string') {
		return res.status(400).json({ error: 'port is required (string: single port or range e.g. "8080" or "8080-8090")' });
	}

	const proto = protocol || 'tcp';
	if (!['tcp', 'udp'].includes(proto)) {
		return res.status(400).json({ error: 'protocol must be "tcp" or "udp"' });
	}

	const reserved = fw.getReservedPorts();
	const portNum = parseInt(port, 10);
	if (!isNaN(portNum) && reserved.some((r) => r.port === portNum)) {
		return res.status(409).json({ error: `Port ${port} is reserved for ${reserved.find((r) => r.port === portNum)!.service}` });
	}

	try {
		const rule = await fw.addUserRule({ port, protocol: proto, interface_name: interface_name || null, description: description || null });
		res.status(201).json(rule);
	} catch (error) {
		res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to add firewall rule' });
	}
});

networkRouter.put('/v1/network/firewall/rules/:id', requireRole('admin'), async (req: Request, res: Response) => {
	const fw = getFirewall();
	if (!fw?.available) {
		return res.status(503).json({ error: 'Firewall not available in this deployment mode' });
	}

	const id = parseInt(req.params.id, 10);
	if (isNaN(id)) {
		return res.status(400).json({ error: 'Invalid rule ID' });
	}

	const { port, protocol, interface_name, description } = req.body;

	if (protocol && !['tcp', 'udp'].includes(protocol)) {
		return res.status(400).json({ error: 'protocol must be "tcp" or "udp"' });
	}

	if (port) {
		const reserved = fw.getReservedPorts();
		const portNum = parseInt(port, 10);
		if (!isNaN(portNum) && reserved.some((r) => r.port === portNum)) {
			return res.status(409).json({ error: `Port ${port} is reserved for ${reserved.find((r) => r.port === portNum)!.service}` });
		}
	}

	try {
		const rule = await fw.updateUserRule(id, { port, protocol, interface_name, description });
		if (!rule) {
			return res.status(404).json({ error: 'Rule not found' });
		}
		res.json(rule);
	} catch (error) {
		res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to update firewall rule' });
	}
});

networkRouter.delete('/v1/network/firewall/rules/:id', requireRole('admin'), async (req: Request, res: Response) => {
	const fw = getFirewall();
	if (!fw?.available) {
		return res.status(503).json({ error: 'Firewall not available in this deployment mode' });
	}

	const id = parseInt(req.params.id, 10);
	if (isNaN(id)) {
		return res.status(400).json({ error: 'Invalid rule ID' });
	}

	try {
		const deleted = await fw.deleteUserRule(id);
		if (!deleted) {
			return res.status(404).json({ error: 'Rule not found' });
		}
		res.json({ success: true });
	} catch (error) {
		res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to delete firewall rule' });
	}
});

// ── Ports ───────────────────────────────────────────────────────────────────

interface PortEntry {
	port: number;
	protocol: string;
	address: string;
	process: string;
	source: 'system' | 'docker';
}

async function getSystemPorts(): Promise<PortEntry[]> {
	try {
		const { stdout } = await exec('ss -tlnp 2>/dev/null || true');
		const lines = stdout.split('\n').slice(1).filter((l) => l.trim());
		return lines.map((line) => {
			const parts = line.trim().split(/\s+/);
			const localAddr = parts[3] || '';
			const lastColon = localAddr.lastIndexOf(':');
			const address = localAddr.substring(0, lastColon) || '*';
			const port = parseInt(localAddr.substring(lastColon + 1), 10);
			const processInfo = parts[5] || '';
			const processMatch = processInfo.match(/users:\(\("([^"]+)"/);
			return {
				port: isNaN(port) ? 0 : port,
				protocol: 'tcp',
				address,
				process: processMatch?.[1] || processInfo,
				source: 'system' as const,
			};
		}).filter((e) => e.port > 0);
	} catch {
		return [];
	}
}

function getDockerPorts(): PortEntry[] {
	try {
		return getDockerPortBindings().map((b) => ({
			port: b.port,
			protocol: b.protocol,
			address: b.address,
			process: `${b.appName}/${b.serviceName}`,
			source: 'docker' as const,
		}));
	} catch {
		return [];
	}
}

networkRouter.get('/v1/network/ports', async (_req: Request, res: Response) => {
	const [systemPorts, dockerPorts] = await Promise.all([
		getSystemPorts(),
		Promise.resolve(getDockerPorts()),
	]);

	const seen = new Set<string>();
	const merged: PortEntry[] = [];

	for (const entry of [...dockerPorts, ...systemPorts]) {
		const key = `${entry.port}:${entry.protocol}`;
		if (!seen.has(key)) {
			seen.add(key);
			merged.push(entry);
		}
	}

	merged.sort((a, b) => a.port - b.port);

	const fw = getFirewall();
	const reservedPorts = fw ? fw.getReservedPorts() : [];

	res.json({ ports: merged, reservedPorts });
});

// ── Capture ────────────────────────────────────────────────────────────────

function serializePacket(p: { id: number; timestamp: number; length: number; capturedLength: number; srcIp: string; dstIp: string; srcPort: number | null; dstPort: number | null; ipProtocol: number; protocolName: string; direction: string; info: string; rawPcap: Buffer }) {
	const { rawPcap, ...rest } = p;
	return { ...rest, size: rawPcap.length };
}

networkRouter.get('/v1/network/capture/status', (_req: Request, res: Response) => {
	const engine = getCaptureEngine();
	if (!engine) {
		return res.json({ available: false, status: null });
	}
	res.json({ available: engine.available, status: engine.getStatus() });
});

networkRouter.post('/v1/network/capture/start', requireRole('admin'), async (req: Request, res: Response) => {
	const engine = getCaptureEngine();
	if (!engine?.available) {
		return res.status(503).json({ error: 'Packet capture not available' });
	}

	try {
		const status = await engine.start({
			filter: req.body.filter,
			maxPackets: req.body.maxPackets,
			iface: req.body.iface,
		});
		res.json({ sessionId: status.sessionId, status });
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Failed to start capture';
		const code = msg.includes('already running') ? 409 : 500;
		res.status(code).json({ error: msg });
	}
});

networkRouter.post('/v1/network/capture/stop', requireRole('admin'), (_req: Request, res: Response) => {
	const engine = getCaptureEngine();
	if (!engine?.available) {
		return res.status(503).json({ error: 'Packet capture not available' });
	}
	res.json(engine.stop());
});

networkRouter.post('/v1/network/capture/clear', requireRole('admin'), (_req: Request, res: Response) => {
	const engine = getCaptureEngine();
	if (!engine?.available) {
		return res.status(503).json({ error: 'Packet capture not available' });
	}
	engine.clear();
	res.json({ success: true });
});

networkRouter.get('/v1/network/capture/packets', (_req: Request, res: Response) => {
	const engine = getCaptureEngine();
	if (!engine?.available) {
		return res.json({ packets: [], total: 0, offset: 0, limit: 50 });
	}

	const filter: CaptureFilter = {};
	if (_req.query.direction) filter.direction = _req.query.direction as 'inbound' | 'outbound';
	if (_req.query.protocol) filter.protocol = _req.query.protocol as string;
	if (_req.query.srcIp) filter.srcIp = _req.query.srcIp as string;
	if (_req.query.dstIp) filter.dstIp = _req.query.dstIp as string;
	if (_req.query.port) filter.port = parseInt(_req.query.port as string, 10);
	if (_req.query.search) filter.search = _req.query.search as string;

	const offset = parseInt((_req.query.offset as string) || '0', 10);
	const limit = parseInt((_req.query.limit as string) || '50', 10);

	const result = engine.getPackets(
		Object.keys(filter).length ? filter : undefined,
		isNaN(offset) ? 0 : offset,
		isNaN(limit) ? 50 : limit,
	);

	res.json({
		packets: result.packets.map(serializePacket),
		total: result.total,
		offset,
		limit,
	});
});

networkRouter.get('/v1/network/capture/packets/:id', (_req: Request, res: Response) => {
	const engine = getCaptureEngine();
	if (!engine?.available) {
		return res.status(404).json({ error: 'Capture not available' });
	}

	const id = parseInt(_req.params.id, 10);
	const packet = engine.getPacket(id);
	if (!packet) {
		return res.status(404).json({ error: 'Packet not found' });
	}

	const { rawPcap, ...rest } = packet;
	const hexLines: string[] = [];
	const previewBytes = rawPcap.subarray(16, 16 + Math.min(rawPcap.length - 16, 256));
	for (let i = 0; i < previewBytes.length; i += 16) {
		const slice = previewBytes.subarray(i, i + 16);
		const hex = Array.from(slice).map((b) => b.toString(16).padStart(2, '0')).join(' ');
		const ascii = Array.from(slice).map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
		hexLines.push(`${i.toString(16).padStart(4, '0')}  ${hex.padEnd(48)}  ${ascii}`);
	}

	res.json({ ...rest, size: rawPcap.length, hexDump: hexLines.join('\n') });
});

networkRouter.get('/v1/network/capture/export', (_req: Request, res: Response) => {
	const engine = getCaptureEngine();
	if (!engine?.available) {
		return res.status(503).json({ error: 'Capture not available' });
	}

	const pcapData = engine.exportPcap();
	const sessionId = engine.getStatus().sessionId || 'capture';
	res.setHeader('Content-Type', 'application/vnd.tcpdump.pcap');
	res.setHeader('Content-Disposition', `attachment; filename="capture-${sessionId}.pcap"`);
	res.send(pcapData);
});
