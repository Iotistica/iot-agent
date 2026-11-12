import { closeSync, existsSync, fsyncSync, linkSync, openSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { randomUUID } from 'crypto';

export const UPDATE_REQUEST_FILE = '/var/lib/iotistic/agent/update.lock';
export const UPDATE_RUNNING_FILE = `${UPDATE_REQUEST_FILE}.running`;

const VALID_UPDATE_TARGET = /^(?:latest|\d+\.\d+\.\d+(?:-[\w.]+)?)$/;

export function queueAgentUpdateRequest(version: string, force = false, requestFile = UPDATE_REQUEST_FILE): void {
	const targetVersion = version.trim();
	if (!VALID_UPDATE_TARGET.test(targetVersion)) {
		throw new Error('Invalid update version');
	}
	if (existsSync(`${requestFile}.running`)) {
		throw new Error('An agent update is already pending or running');
	}

	const temporaryFile = join(
		dirname(requestFile),
		`.${basename(requestFile)}.${process.pid}.${randomUUID()}.tmp`,
	);
	let fileDescriptor: number | undefined;

	try {
		fileDescriptor = openSync(temporaryFile, 'wx', 0o600);
		writeFileSync(fileDescriptor, `${targetVersion}\n${force ? 'true' : 'false'}\n`, 'utf8');
		fsyncSync(fileDescriptor);
		closeSync(fileDescriptor);
		fileDescriptor = undefined;

		// Linking publishes the complete request atomically and fails if another update is pending.
		linkSync(temporaryFile, requestFile);
	} catch (error) {
		if (fileDescriptor !== undefined) {
			try { closeSync(fileDescriptor); } catch { /* best-effort cleanup */ }
		}
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
			throw new Error('An agent update is already pending or running');
		}
		throw error;
	} finally {
		if (existsSync(temporaryFile)) unlinkSync(temporaryFile);
	}
}