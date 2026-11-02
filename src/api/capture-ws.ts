import type { Server, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { AdminSessionModel } from '../db/models/admin-session.model.js';
import { getCaptureEngine } from './actions.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';
import type { CapturedPacket } from '../network/capture.js';

const SESSION_COOKIE = 'admin_session';

function parseCookie(header: string | undefined, name: string): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(';')) {
		const eq = part.indexOf('=');
		if (eq < 0) continue;
		if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return undefined;
}

function authenticate(req: IncomingMessage): boolean {
	const token = parseCookie(req.headers.cookie, SESSION_COOKIE);
	if (!token) return false;
	return !!AdminSessionModel.find(token);
}

function serializePacket(p: CapturedPacket) {
	const { rawPcap, ...rest } = p;
	return { ...rest, size: rawPcap.length };
}

export function attachCaptureHandler(server: Server, logger?: AgentLogger): void {
	const wss = new WebSocketServer({ noServer: true });

	server.on('upgrade', (req, socket, head) => {
		const url = req.url?.split('?')[0];
		if (url !== '/v1/capture') return;

		if (!authenticate(req)) {
			socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
			socket.destroy();
			logger?.warnSync('Capture WebSocket rejected — invalid session', {
				component: LogComponents.capture,
			});
			return;
		}

		wss.handleUpgrade(req, socket, head, (ws) => {
			wss.emit('connection', ws, req);
		});
	});

	wss.on('connection', (ws) => {
		const engine = getCaptureEngine();
		if (!engine) {
			ws.close(1011, 'Capture engine not available');
			return;
		}

		const onPacket = (packet: CapturedPacket) => {
			if (ws.readyState === WebSocket.OPEN) {
				try {
					ws.send(JSON.stringify(serializePacket(packet)));
				} catch {
					cleanup();
				}
			}
		};

		const cleanup = () => {
			engine.off('packet', onPacket);
		};

		engine.on('packet', onPacket);
		ws.on('close', cleanup);
		ws.on('error', cleanup);

		ws.on('message', (raw) => {
			try {
				const msg = JSON.parse(raw.toString());
				if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
			} catch { /* ignore */ }
		});
	});
}
