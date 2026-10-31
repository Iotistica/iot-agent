import type Docker from 'dockerode';

export function buildContainerSecurityOptions(): Pick<
	Docker.HostConfig,
	'Privileged' | 'SecurityOpt' | 'PidsLimit'
	> {
	return {
		Privileged: false,
		SecurityOpt: ['no-new-privileges:true'],
		PidsLimit: 256,
	};
}

export const DEFAULT_PIDS_LIMIT = 256;
export const MAX_PIDS_LIMIT = 4096;

/** Per-application security requirements declared in the deployment config. */
export interface ServiceSecurityConfig {
	pidsLimit?: number;
}

export interface SecurityPolicySummary {
	privileged: false;
	noNewPrivileges: true;
	pidsLimit: number;
	/** True when the app declared exceptions to the secure defaults. */
	customized: boolean;
}

export interface ResolvedSecurityPolicy {
	hostConfig: Pick<Docker.HostConfig, 'Privileged' | 'SecurityOpt' | 'PidsLimit'>;
	summary: SecurityPolicySummary;
}

/** Thrown for invalid security overrides; never retryable (needs a config fix). */
export class ContainerSecurityPolicyError extends Error {
	readonly retryable = false;
	constructor(message: string) {
		super(message);
		this.name = 'ContainerSecurityPolicyError';
	}
}

/**
 * Single source of truth for container security. Used by create, both update
 * strategies, reconciliation (existing-container checks) and status reporting.
 * Secure defaults always apply; only validated, allowlisted exceptions are added.
 */
export function resolveContainerSecurityPolicy(
	config: { security?: unknown } | undefined,
): ResolvedSecurityPolicy {
	const base = buildContainerSecurityOptions();
	const raw = config?.security;
	let pidsLimit = DEFAULT_PIDS_LIMIT;

	if (raw !== undefined && raw !== null) {
		if (typeof raw !== 'object' || Array.isArray(raw)) {
			throw new ContainerSecurityPolicyError('Invalid security config: "security" must be an object');
		}
		const security = raw as Record<string, unknown>;
		const unknownKeys = Object.keys(security).filter((k) => k !== 'pidsLimit');
		if (unknownKeys.length) {
			throw new ContainerSecurityPolicyError(
				`Invalid security config: unsupported option(s) ${unknownKeys.join(', ')}`,
			);
		}

		if (security.pidsLimit !== undefined) {
			const limit = security.pidsLimit;
			if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_PIDS_LIMIT) {
				throw new ContainerSecurityPolicyError(
					`Invalid security config: pidsLimit must be an integer between 1 and ${MAX_PIDS_LIMIT}`,
				);
			}
			pidsLimit = limit;
		}
	}

	return {
		hostConfig: {
			...base,
			PidsLimit: pidsLimit,
		},
		summary: {
			privileged: false,
			noNewPrivileges: true,
			pidsLimit,
			customized: pidsLimit !== DEFAULT_PIDS_LIMIT,
		},
	};
}

/** True when an existing container's HostConfig matches the resolved policy exactly. */
export function hostConfigMatchesPolicy(
	hostConfig: Docker.HostConfig | undefined,
	policy: ResolvedSecurityPolicy,
): boolean {
	if (!hostConfig) return false;
	return hostConfig.Privileged === false
		&& hostConfig.SecurityOpt?.includes('no-new-privileges:true') === true
		&& hostConfig.PidsLimit === policy.hostConfig.PidsLimit
		&& hostConfig.PidMode !== 'host'
		&& hostConfig.IpcMode !== 'host'
		&& hostConfig.UsernsMode !== 'host'
		&& hostConfig.NetworkMode !== 'host'
		&& !hostConfig.NetworkMode?.startsWith('container:');
}

/**
 * Hint appended to startup failures that look like permission problems.
 * Never mutates anything: ownership of existing data is left to the operator.
 */
export function permissionFailureHint(message: string): string | undefined {
	if (!/permission denied|operation not permitted|eacces|eperm/i.test(message)) return undefined;
	return 'Hint: the container runs with no-new-privileges. If the entrypoint needs to chown or switch user, '
		+ 'set config.user to a UID that owns the volume, or fix ownership of the volume/bind mount on the host.';
}
