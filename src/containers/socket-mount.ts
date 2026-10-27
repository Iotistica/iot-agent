import fs from 'node:fs';
import path from 'node:path';
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';

export const SOCKET_HOST_BASE = `${process.env.DATA_DIR || '/app/data'}/sockets`;
export const SOCKET_CONTAINER_PATH = '/run/edge-ipc';

function validateId(value: number, name: string): void {
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
		throw new Error(`${name} must be a non-negative integer, got ${value}`);
	}
}

export function socketHostDir(appId: number, serviceId: number): string {
	validateId(appId, 'appId');
	validateId(serviceId, 'serviceId');
	return path.posix.join(SOCKET_HOST_BASE, `${appId}_${serviceId}`);
}

export function socketBindString(appId: number, serviceId: number): string {
	return `${socketHostDir(appId, serviceId)}:${SOCKET_CONTAINER_PATH}`;
}

export async function ensureSocketDir(
	appId: number,
	serviceId: number,
): Promise<{ path: string; created: boolean }> {
	const dir = socketHostDir(appId, serviceId);
	const existed = fs.existsSync(dir);
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o770 });
	return { path: dir, created: !existed };
}

export async function removeSocketDir(
	appId: number,
	serviceId: number,
	logger?: AgentLogger,
): Promise<void> {
	const dir = socketHostDir(appId, serviceId);
	try {
		await fs.promises.rm(dir, { recursive: true, force: true });
	} catch (error) {
		logger?.warnSync('Failed to clean up socket directory', {
			component: LogComponents.dockerManager,
			operation: 'removeSocketDir',
			dir,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export function isSocketMount(mountSource: string, mountDestination: string): boolean {
	return (
		mountDestination === SOCKET_CONTAINER_PATH &&
		mountSource.startsWith(SOCKET_HOST_BASE + '/')
	);
}
