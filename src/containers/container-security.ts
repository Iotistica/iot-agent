import type Docker from 'dockerode';

export function buildContainerSecurityOptions(): Pick<
	Docker.HostConfig,
	'Privileged' | 'CapDrop' | 'SecurityOpt' | 'PidsLimit'
	> {
	return {
		Privileged: false,
		CapDrop: ['ALL'],
		SecurityOpt: ['no-new-privileges:true'],
		PidsLimit: 256,
	};
}

/**
 * Capabilities an application may request through `config.security.capabilities`.
 * Deliberately narrow: no SYS_ADMIN, NET_ADMIN, NET_RAW, SYS_PTRACE, SYS_MODULE, etc.
 */
export const ALLOWED_CAPABILITY_EXCEPTIONS: readonly string[] = [
	'CHOWN',
	'DAC_OVERRIDE',
	'FOWNER',
	'FSETID',
	'KILL',
	'SETGID',
	'SETUID',
	'SETPCAP',
	'SETFCAP',
	'NET_BIND_SERVICE',
	'SYS_CHROOT',
	'MKNOD',
	'AUDIT_WRITE',
];

export const DEFAULT_PIDS_LIMIT = 256;
export const MAX_PIDS_LIMIT = 4096;

/** Per-application security requirements declared in the deployment config. */
export interface ServiceSecurityConfig {
	capabilities?: string[];
	pidsLimit?: number;
}

export interface SecurityPolicySummary {
	privileged: false;
	capDrop: string[];
	capAdd: string[];
	noNewPrivileges: true;
	pidsLimit: number;
	/** True when the app declared exceptions to the secure defaults. */
	customized: boolean;
}

export interface ResolvedSecurityPolicy {
	hostConfig: Pick<Docker.HostConfig, 'Privileged' | 'CapDrop' | 'SecurityOpt' | 'PidsLimit'> & {
		CapAdd?: string[];
	};
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
	let capAdd: string[] = [];
	let pidsLimit = DEFAULT_PIDS_LIMIT;

	if (raw !== undefined && raw !== null) {
		if (typeof raw !== 'object' || Array.isArray(raw)) {
			throw new ContainerSecurityPolicyError('Invalid security config: "security" must be an object');
		}
		const security = raw as Record<string, unknown>;
		const unknownKeys = Object.keys(security).filter((k) => k !== 'capabilities' && k !== 'pidsLimit');
		if (unknownKeys.length) {
			throw new ContainerSecurityPolicyError(
				`Invalid security config: unsupported option(s) ${unknownKeys.join(', ')}`,
			);
		}

		if (security.capabilities !== undefined) {
			if (!Array.isArray(security.capabilities)) {
				throw new ContainerSecurityPolicyError('Invalid security config: "capabilities" must be an array');
			}
			const normalized = new Set<string>();
			for (const cap of security.capabilities) {
				if (typeof cap !== 'string') {
					throw new ContainerSecurityPolicyError('Invalid security config: capability names must be strings');
				}
				const name = cap.trim().toUpperCase().replace(/^CAP_/, '');
				if (!ALLOWED_CAPABILITY_EXCEPTIONS.includes(name)) {
					throw new ContainerSecurityPolicyError(
						`Invalid security config: capability "${cap}" is not permitted (allowed: ${ALLOWED_CAPABILITY_EXCEPTIONS.join(', ')})`,
					);
				}
				normalized.add(name);
			}
			capAdd = [...normalized].sort();
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
			...(capAdd.length ? { CapAdd: capAdd } : {}),
		},
		summary: {
			privileged: false,
			capDrop: ['ALL'],
			capAdd,
			noNewPrivileges: true,
			pidsLimit,
			customized: capAdd.length > 0 || pidsLimit !== DEFAULT_PIDS_LIMIT,
		},
	};
}

/** True when an existing container's HostConfig matches the resolved policy exactly. */
export function hostConfigMatchesPolicy(
	hostConfig: Docker.HostConfig | undefined,
	policy: ResolvedSecurityPolicy,
): boolean {
	if (!hostConfig) return false;
	const actualCaps = [...(hostConfig.CapAdd || [])].map((c) => c.toUpperCase().replace(/^CAP_/, '')).sort();
	const expectedCaps = [...(policy.hostConfig.CapAdd || [])].sort();
	return hostConfig.Privileged === false
		&& hostConfig.CapDrop?.includes('ALL') === true
		&& actualCaps.length === expectedCaps.length
		&& actualCaps.every((c, i) => c === expectedCaps[i])
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
	return 'Hint: the container runs with all capabilities dropped. If the image entrypoint must chown/switch user, '
		+ 'declare narrowly scoped capabilities in config.security.capabilities (e.g. CHOWN, SETUID, SETGID, DAC_OVERRIDE), '
		+ 'set config.user to a UID that owns the volume, or fix ownership of the volume/bind mount manually.';
}
