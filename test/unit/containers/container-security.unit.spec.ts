jest.mock('dockerode', () => jest.fn().mockImplementation(() => ({})));
jest.mock('node:fs', () => {
	const actual = jest.requireActual('node:fs');
	return { ...actual,
		existsSync: jest.fn().mockReturnValue(false),
		promises: { mkdir: jest.fn().mockResolvedValue(undefined), rm: jest.fn().mockResolvedValue(undefined) },
	};
});

import { DockerManager } from '../../../src/containers/docker-manager';
import {
	resolveContainerSecurityPolicy,
	hostConfigMatchesPolicy,
	permissionFailureHint,
	ContainerSecurityPolicyError,
} from '../../../src/containers/container-security';
import { executeStep } from '../../../src/containers/step-executor';
import { markServiceAsError } from '../../../src/containers/state-helpers';
import type { ContainerService } from '../../../src/containers/container-manager';

function svc(config: any = {}): ContainerService {
	return {
		serviceId: 1, serviceName: 's', imageName: 'img', appId: 10, appName: 'a',
		config: { image: 'img', ...config },
	} as ContainerService;
}

function manager() {
	const mgr: any = Object.create(DockerManager.prototype);
	const container = { id: 'abc123def456', start: jest.fn().mockResolvedValue(undefined) };
	mgr.docker = { createContainer: jest.fn().mockResolvedValue(container), listContainers: jest.fn().mockResolvedValue([]) };
	mgr.logger = { debugSync: jest.fn(), infoSync: jest.fn(), warnSync: jest.fn(), errorSync: jest.fn() };
	mgr.findContainerByName = jest.fn().mockResolvedValue(null);
	mgr.hasImage = jest.fn().mockResolvedValue(true);
	mgr.waitForHealthy = jest.fn().mockResolvedValue(true);
	mgr.renameContainer = jest.fn().mockResolvedValue(undefined);
	mgr.sanitizeNamePart = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
	mgr.parseResourceLimits = jest.fn().mockReturnValue({});
	return mgr;
}

describe('resolveContainerSecurityPolicy', () => {
	it('applies secure defaults to standard images', () => {
		const p = resolveContainerSecurityPolicy({});
		expect(p.hostConfig).toEqual({
			Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], PidsLimit: 256,
		});
		expect(p.summary.customized).toBe(false);
	});

	it('adds only declared, allowlisted capabilities and keeps CapDrop ALL', () => {
		const p = resolveContainerSecurityPolicy({ security: { capabilities: ['setuid', 'CAP_SETGID', 'CHOWN', 'CHOWN'] } });
		expect(p.hostConfig.CapAdd).toEqual(['CHOWN', 'SETGID', 'SETUID']);
		expect(p.hostConfig.CapDrop).toEqual(['ALL']);
		expect(p.hostConfig.Privileged).toBe(false);
		expect(p.summary.customized).toBe(true);
	});

	it.each([
		[{ capabilities: ['ALL'] }],
		[{ capabilities: ['SYS_ADMIN'] }],
		[{ capabilities: ['NET_ADMIN'] }],
		[{ capabilities: 'CHOWN' }],
		[{ capabilities: [1] }],
		[{ pidsLimit: 0 }],
		[{ pidsLimit: 1.5 }],
		[{ pidsLimit: 100000 }],
		[{ privileged: true }],
		[{ noNewPrivileges: false }],
		['privileged'],
	])('rejects invalid override %j', (security) => {
		expect(() => resolveContainerSecurityPolicy({ security })).toThrow(ContainerSecurityPolicyError);
	});

	it('hostConfigMatchesPolicy detects drift in capabilities and pids limit', () => {
		const def = resolveContainerSecurityPolicy({});
		const withCaps = resolveContainerSecurityPolicy({ security: { capabilities: ['CHOWN'] } });
		expect(hostConfigMatchesPolicy(def.hostConfig, def)).toBe(true);
		expect(hostConfigMatchesPolicy(def.hostConfig, withCaps)).toBe(false);
		expect(hostConfigMatchesPolicy({ ...withCaps.hostConfig }, def)).toBe(false);
		expect(hostConfigMatchesPolicy({ ...def.hostConfig, PidsLimit: 1000 }, def)).toBe(false);
		expect(hostConfigMatchesPolicy({ ...def.hostConfig, CapAdd: ['ALL'] }, def)).toBe(false);
	});

	it('gives a non-mutating hint for permission failures', () => {
		expect(permissionFailureHint("mkdir: cannot create directory '/var/lib/influxdb2': Permission denied")).toMatch(/config\.security\.capabilities/);
		expect(permissionFailureHint('image not found')).toBeUndefined();
	});
});

describe('DockerManager lifecycle uses one resolved policy', () => {
	const config = { security: { capabilities: ['CHOWN', 'SETUID', 'SETGID'], pidsLimit: 512 }, volumes: ['data:/var/lib/data'], environment: { A: 'b' }, resources: undefined };
	const expected = { Privileged: false, CapDrop: ['ALL'], CapAdd: ['CHOWN', 'SETGID', 'SETUID'], SecurityOpt: ['no-new-privileges:true'], PidsLimit: 512 };

	it('startContainer', async () => {
		const mgr = manager();
		await mgr.startContainer(svc(config));
		const hc = mgr.docker.createContainer.mock.calls[0][0].HostConfig;
		expect(hc).toMatchObject(expected);
		expect(hc.Binds).toContain('data:/var/lib/data');
	});

	it('updateContainer (blue-green)', async () => {
		const mgr = manager();
		await mgr.updateContainer(svc(config));
		expect(mgr.docker.createContainer.mock.calls[0][0].HostConfig).toMatchObject(expected);
	});

	it('updateContainerStopStart (socket destination)', async () => {
		const mgr = manager();
		await mgr.updateContainer(svc({ ...config, enableSocketDestination: true }));
		expect(mgr.docker.createContainer.mock.calls[0][0].HostConfig).toMatchObject(expected);
	});

	it('rejects invalid overrides before creating a container', async () => {
		const mgr = manager();
		await expect(mgr.startContainer(svc({ security: { capabilities: ['SYS_ADMIN'] } }))).rejects.toThrow(/not permitted/);
		expect(mgr.docker.createContainer).not.toHaveBeenCalled();
	});

	it('recreates an existing container whose capabilities differ from the resolved policy', async () => {
		const mgr = manager();
		const old = {
			inspect: jest.fn().mockResolvedValue({ Id: 'old', State: { Running: false }, HostConfig: resolveContainerSecurityPolicy({}).hostConfig }),
			remove: jest.fn().mockResolvedValue(undefined),
			start: jest.fn(),
		};
		mgr.findContainerByName = jest.fn().mockResolvedValue(old);
		await mgr.startContainer(svc(config));
		expect(old.remove).toHaveBeenCalled();
		expect(old.start).not.toHaveBeenCalled();
	});

	it('reuses a previously hardened container for a config without overrides', async () => {
		const mgr = manager();
		const old = {
			inspect: jest.fn().mockResolvedValue({ Id: 'old', State: { Running: true }, HostConfig: resolveContainerSecurityPolicy({}).hostConfig }),
			remove: jest.fn(),
		};
		mgr.findContainerByName = jest.fn().mockResolvedValue(old);
		expect(await mgr.startContainer(svc())).toBe('old');
		expect(old.remove).not.toHaveBeenCalled();
	});
});

describe('bounded restart retries', () => {
	function makeCtx(startContainer: jest.Mock) {
		const state = new Map<string, any>();
		const retryManager: any = {
			shouldRetry: jest.fn((k: string) => { const s = state.get(k); return !s || (!s.terminal && s.nextRetry.getTime() <= Date.now()); }),
			recordFailure: jest.fn((k: string, msg: string, retryable?: boolean) => {
				const s = state.get(k) || { count: 0 };
				s.count++; s.lastError = msg; s.nextRetry = new Date(0);
				s.terminal = retryable === false || s.count >= 3;
				state.set(k, s);
			}),
			recordSuccess: jest.fn((k: string) => state.delete(k)),
			clearState: jest.fn((k: string) => state.delete(k)),
			getState: jest.fn((k: string) => state.get(k)),
			isTerminal: jest.fn((k: string) => !!state.get(k)?.terminal),
		};
		const appService = svc();
		const app = { appId: 10, appName: 'a', services: [appService] };
		const sctx: any = { currentState: { apps: { 10: app } }, targetState: { apps: {} }, retryManager };
		const ctx: any = {
			retryManager,
			startContainer,
			markServiceAsError: (appId: number, id: any, type: any, msg: string) => markServiceAsError(sctx, appId, id, type, msg),
			addServiceToCurrentState: jest.fn(), markServiceAsRunning: jest.fn(),
			attachLogsToContainer: jest.fn(), startHealthMonitoring: jest.fn(),
		};
		return { ctx, retryManager, appService };
	}

	it('stops recreating a failing container after the retry budget and reports CrashLoopBackOff with policy', async () => {
		const start = jest.fn().mockRejectedValue(new Error('Permission denied'));
		const { ctx, appService } = makeCtx(start);
		const step: any = { action: 'startContainer', appId: 10, service: svc({ security: { capabilities: ['CHOWN'] } }) };
		for (let i = 0; i < 3; i++) await expect(executeStep(step, ctx)).rejects.toThrow('Permission denied');
		expect(appService.error?.type).toBe('CrashLoopBackOff');
		await expect(executeStep(step, ctx)).rejects.toThrow(/Max start retries exceeded/);
		expect(start).toHaveBeenCalledTimes(3);
		expect(appService.error?.message).toMatch(/Giving up after 3/);
		expect(appService.error?.message).toMatch(/config\.security\.capabilities/);
	});

	it('treats invalid security policy as terminal immediately', async () => {
		const start = jest.fn().mockRejectedValue(new ContainerSecurityPolicyError('Invalid security config: bad'));
		const { ctx, appService } = makeCtx(start);
		const step: any = { action: 'startContainer', appId: 10, service: svc() };
		await expect(executeStep(step, ctx)).rejects.toThrow('Invalid security config');
		expect(appService.error?.type).toBe('CrashLoopBackOff');
		expect(appService.error?.securityPolicy?.capDrop).toEqual(['ALL']);
		await expect(executeStep(step, ctx)).rejects.toThrow(/Max start retries/);
		expect(start).toHaveBeenCalledTimes(1);
	});

	it('gives a fresh retry budget when the deployment config changes', async () => {
		const start = jest.fn().mockRejectedValue(new ContainerSecurityPolicyError('bad'));
		const { ctx } = makeCtx(start);
		const bad: any = { action: 'startContainer', appId: 10, service: svc({ environment: { V: '1' } }) };
		await expect(executeStep(bad, ctx)).rejects.toThrow('bad');
		await expect(executeStep(bad, ctx)).rejects.toThrow(/Max start retries/);
		start.mockResolvedValue('newid');
		const fixed: any = { action: 'startContainer', appId: 10, service: svc({ environment: { V: '2' } }) };
		await executeStep(fixed, ctx);
		expect(start).toHaveBeenCalledTimes(2);
	});
});
