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
