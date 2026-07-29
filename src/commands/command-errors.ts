import type { CommandErrorCode } from './types.js';

/** Carries a stable, machine-readable error code alongside a human-readable message. */
export class CommandError extends Error {
	constructor(public readonly code: CommandErrorCode, message: string) {
		super(message);
		this.name = 'CommandError';
	}
}
