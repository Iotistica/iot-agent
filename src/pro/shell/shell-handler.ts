import * as pty from 'node-pty';
import * as os from 'os';
import { createHmac, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import type { AgentLogger, ShellMqttClient, MqttPayload } from '../shared/types.js';

const LOG_COMPONENT = 'Shell';

interface ShellCommand {
  action: 'start' | 'stop' | 'input' | 'resize';
  sessionId?: string;
  data?: string;
  cols?: number;
  rows?: number;
  signature?: string;
  issued_at?: number;
  expires_at?: number;
}

function verifyCommandSignature(command: ShellCommand, secret: string, agentUuid: string): boolean {
	if (!command.signature || !command.issued_at) return false;

	const canonicalPayload = {
		deviceUuid: agentUuid,
		action: command.action,
		sessionId: command.sessionId || '',
		data: command.data || '',
		cols: command.cols || null,
		rows: command.rows || null,
		issued_at: command.issued_at,
		expires_at: command.expires_at || null,
	};

	const expectedSignature = createHmac('sha256', secret)
		.update(JSON.stringify(canonicalPayload))
		.digest('hex');

	try {
		return timingSafeEqual(
			Buffer.from(command.signature, 'hex'),
			Buffer.from(expectedSignature, 'hex'),
		);
	} catch {
		return false;
	}
}

export interface ShellHandlerOptions {
  commandTopic: string;
  outputTopic: string;
}

export class ShellHandler {
	private static activeInstance: ShellHandler | null = null;

	private ptyProcess: pty.IPty | null = null;
	private sessionActive = false;
	private currentSessionId: string | null = null;
	private outputBuffer = '';
	private flushTimer: NodeJS.Timeout | null = null;
	private idleTimer: NodeJS.Timeout | null = null;
	private sessionStartTime: number | null = null;
	private initialized = false;

	private readonly commandTopic: string;
	private readonly outputTopic: string;
	private readonly hmacSecret: string | undefined;
	private readonly shellEnabled: boolean;
	private readonly IDLE_TIMEOUT_MS = 5 * 60 * 1000;
	private readonly MAX_SESSION_MS: number;
	private readonly MAX_BUFFER_SIZE = 200000;

	private readonly ALLOWED_SHELLS = [
		'/bin/bash', '/bin/sh', '/bin/zsh', '/bin/dash',
		'/usr/bin/bash', '/usr/bin/sh',
		'powershell.exe', 'pwsh.exe', 'cmd.exe',
	];

	constructor(
		private readonly deviceUuid: string,
		private readonly mqtt: ShellMqttClient,
		private readonly logger: AgentLogger,
		options: ShellHandlerOptions,
	) {
		this.commandTopic = options.commandTopic;
		this.outputTopic = options.outputTopic;

		this.hmacSecret = process.env.AGENT_SHELL_HMAC_KEY;
		this.shellEnabled = !!this.hmacSecret;

		if (!this.hmacSecret) {
			this.logger.errorSync(
				'AGENT_SHELL_HMAC_KEY not set - shell access DISABLED',
				new Error('Missing HMAC secret'),
				{
					component: LOG_COMPONENT,
					security_risk: 'critical',
					recommendation: 'Set AGENT_SHELL_HMAC_KEY environment variable to enable shell access',
				},
			);
		}

		const maxSessionEnv = process.env.AGENT_SHELL_MAX_SESSION_MS;
		this.MAX_SESSION_MS = maxSessionEnv ? Number(maxSessionEnv) : 60 * 60 * 1000;
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;

		if (ShellHandler.activeInstance && ShellHandler.activeInstance !== this) {
			this.logger.warnSync('Replacing existing active shell handler instance', {
				component: LOG_COMPONENT,
			});
			await ShellHandler.activeInstance.cleanup();
		}

		ShellHandler.activeInstance = this;

		try {
			await this.mqtt.subscribe(
				this.commandTopic,
				{ qos: 1 },
				(_topic, payload) => this.handleCommand(payload),
			);
			this.initialized = true;
		} catch (error) {
			if (ShellHandler.activeInstance === this) ShellHandler.activeInstance = null;
			throw error;
		}
	}

	private async handleCommand(payload: Buffer): Promise<void> {
		try {
			const command: ShellCommand = JSON.parse(payload.toString());

			if (!this.shellEnabled) {
				this.logger.errorSync(
					'Shell command rejected - shell disabled (no HMAC secret)',
					new Error('Shell access disabled'),
					{ component: LOG_COMPONENT, action: command.action },
				);
				return;
			}

			this.logger.debugSync('Received shell command', {
				component: LOG_COMPONENT, action: command.action, sessionActive: this.sessionActive,
			});

			if (this.hmacSecret) {
				if (!verifyCommandSignature(command, this.hmacSecret, this.deviceUuid)) {
					this.logger.errorSync(
						'Shell command rejected - invalid signature',
						new Error('HMAC verification failed'),
						{ component: LOG_COMPONENT, action: command.action },
					);
					return;
				}

				const MAX_COMMAND_AGE_MS = 30000;
				if (command.issued_at && Date.now() - command.issued_at > MAX_COMMAND_AGE_MS) {
					this.logger.warnSync('Shell command too old', {
						component: LOG_COMPONENT,
						age_seconds: Math.floor((Date.now() - command.issued_at) / 1000),
					});
					return;
				}

				if (command.expires_at && Date.now() > command.expires_at) {
					this.logger.warnSync('Shell command expired', { component: LOG_COMPONENT });
					return;
				}
			}

			switch (command.action) {
				case 'start': await this.startSession(command.sessionId); break;
				case 'stop': this.stopSession(); break;
				case 'input':
					if (command.sessionId && command.sessionId !== this.currentSessionId) {
						this.logger.warnSync('Input rejected - sessionId mismatch', { component: LOG_COMPONENT });
						break;
					}
					if (command.data && this.ptyProcess) {
						this.ptyProcess.write(command.data);
						this.resetIdleTimer();
					}
					break;
				case 'resize':
					if (command.cols && command.rows && this.ptyProcess) {
						this.ptyProcess.resize(command.cols, command.rows);
						this.resetIdleTimer();
					}
					break;
				default:
					this.logger.warnSync('Unknown shell action', { component: LOG_COMPONENT, action: command.action });
			}
		} catch (error) {
			this.logger.errorSync('Error handling shell command', error as Error, { component: LOG_COMPONENT });
		}
	}

	private async startSession(sessionId?: string): Promise<void> {
		if (this.sessionActive) {
			if (this.currentSessionId && sessionId && this.currentSessionId !== sessionId) {
				this.stopSession();
			} else {
				this.logger.warnSync('Shell session already active', { component: LOG_COMPONENT });
				return;
			}
		}

		this.currentSessionId = sessionId || null;
		this.sessionStartTime = Date.now();
		this.outputBuffer = '';

		try {
			const shell = this.resolveShell();
			const willDropPrivileges = !!(process.getuid?.() === 0 && os.platform() !== 'win32');
			const cwd = this.resolveWorkingDirectory();

			if (!this.shellExists(shell)) {
				throw new Error(`Configured shell '${shell}' not found or not executable`);
			}

			const safeEnv: Record<string, string> = {
				HOME: cwd,
				TERM: 'xterm-256color',
				PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
				USER: process.env.USER || 'agent',
				SHELL: shell,
				LANG: process.env.LANG || 'en_US.UTF-8',
			};
			if (process.env.DEVICE_API_PORT) safeEnv.DEVICE_API_PORT = process.env.DEVICE_API_PORT;
			if (process.env.DEVICE_API_URL) safeEnv.DEVICE_API_URL = process.env.DEVICE_API_URL;
			if (process.env.IOTISTICA_API) safeEnv.IOTISTICA_API = process.env.IOTISTICA_API;

			const spawnOptions: any = { name: 'xterm-256color', cols: 80, rows: 24, cwd, env: safeEnv };

			if (willDropPrivileges) {
				spawnOptions.uid = Number(process.env.AGENT_UID || 1000);
				spawnOptions.gid = Number(process.env.AGENT_GID || 1000);
			}

			this.logger.infoSync('Starting PTY process', {
				component: LOG_COMPONENT, shell, cwd, platform: os.platform(),
			});

			this.ptyProcess = pty.spawn(shell, [], spawnOptions);
			this.sessionActive = true;
			this.ptyProcess.write('\x1b[?1049l\x1b[2J\x1b[H');

			this.ptyProcess.onData((data: string) => {
				this.outputBuffer += data;
				if (this.outputBuffer.length > this.MAX_BUFFER_SIZE) {
					this.outputBuffer = this.outputBuffer.slice(-this.MAX_BUFFER_SIZE);
				}
				if (!this.flushTimer) {
					this.flushTimer = setTimeout(() => this.flushOutput(), 30);
				}
				this.resetIdleTimer();
			});

			this.ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
				this.logger.infoSync('PTY process exited', { component: LOG_COMPONENT, exitCode, signal });
				this.stopSession();
			});

			this.resetIdleTimer();
			this.logger.infoSync('Shell session started', { component: LOG_COMPONENT });
		} catch (error) {
			this.logger.errorSync('Failed to start shell session', error as Error, { component: LOG_COMPONENT });
			this.sessionActive = false;
			this.sendOutput(`\r\n\x1b[31m✗ Failed to start shell: ${(error as Error).message}\x1b[0m\r\n`);
		}
	}

	private stopSession(): void {
		if (!this.sessionActive) return;
		if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }

		this.logger.infoSync('Stopping shell session', { component: LOG_COMPONENT });
		if (this.ptyProcess) {
			try { this.ptyProcess.kill(); } catch (e) {
				this.logger.errorSync('Error killing PTY process', e as Error, { component: LOG_COMPONENT });
			}
			this.ptyProcess = null;
			this.currentSessionId = null;
		}
		this.sessionActive = false;
		this.sessionStartTime = null;
		this.logger.infoSync('Shell session stopped', { component: LOG_COMPONENT });
	}

	private resetIdleTimer(): void {
		if (this.MAX_SESSION_MS > 0 && this.sessionStartTime) {
			const sessionAge = Date.now() - this.sessionStartTime;
			if (sessionAge >= this.MAX_SESSION_MS) {
				this.sendOutput('\r\n\x1b[31m⚠ Session closed: maximum duration exceeded\x1b[0m\r\n');
				this.stopSession();
				return;
			}
		}
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			this.sendOutput('\r\n\x1b[33m⚠ Session closed due to inactivity\x1b[0m\r\n');
			this.stopSession();
		}, this.IDLE_TIMEOUT_MS);
	}

	private sendOutput(data: string): void {
		this.outputBuffer += data;
		this.flushOutput();
	}

	private flushOutput(): void {
		if (!this.outputBuffer) { this.flushTimer = null; return; }
		const chunk = this.outputBuffer;
		this.outputBuffer = '';
		this.flushTimer = null;
		const payload: MqttPayload = {
			format: 'json',
			data: { sessionId: this.currentSessionId, output: chunk, timestamp: new Date().toISOString() },
		};
		this.mqtt.publish(this.outputTopic, payload, { qos: 0, retain: false }).catch((error) => {
			this.logger.errorSync('Failed to publish shell output', error as Error, { component: LOG_COMPONENT });
		});
	}

	async cleanup(): Promise<void> {
		if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
		if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
		if (this.outputBuffer) this.flushOutput();
		this.stopSession();
		if (this.initialized) {
			try { await this.mqtt.unsubscribe(this.commandTopic); } catch (e) {
				this.logger.errorSync('Error unsubscribing from shell topic', e as Error, { component: LOG_COMPONENT });
			}
			this.initialized = false;
		}
		if (ShellHandler.activeInstance === this) ShellHandler.activeInstance = null;
		this.logger.infoSync('Shell handler cleaned up', { component: LOG_COMPONENT });
	}

	private resolveShell(): string {
		const platformDefault = os.platform() === 'win32' ? 'powershell.exe' : '/bin/sh';
		const requested = process.env.AGENT_SHELL;
		if (!requested) return platformDefault;
		if (!this.ALLOWED_SHELLS.includes(requested)) {
			throw new Error(`AGENT_SHELL '${requested}' is not allowlisted. Allowed: ${this.ALLOWED_SHELLS.join(', ')}`);
		}
		return requested;
	}

	private shellExists(shellPath: string): boolean {
		if (os.platform() === 'win32') return true;
		try { fs.accessSync(shellPath, fs.constants.X_OK); return true; } catch { return false; }
	}

	private resolveWorkingDirectory(): string {
		const configured = process.env.AGENT_SHELL_CWD || process.env.CONFIG_DIR || '/app/data';
		try {
			fs.accessSync(configured, fs.constants.R_OK | fs.constants.X_OK);
			return configured;
		} catch {
			throw new Error(`Shell working directory '${configured}' is not accessible.`);
		}
	}
}
