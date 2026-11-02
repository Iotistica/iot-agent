import express from 'express';
import type { Request, Response } from 'express';
import { exec } from '../lib/fs-utils.js';
import { getFirewall, getDockerPortBindings } from './actions.js';
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
