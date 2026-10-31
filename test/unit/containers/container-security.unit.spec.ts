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
import { RetryManager } from '../../../src/containers/retry-manager';
import { pruneObsoleteServiceRetries } from '../../../src/containers/state-helpers';
import { executeStep } from '../../../src/containers/step-executor';
import { markServiceAsError, serviceRetryKey } from '../../../src/containers/state-helpers';
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
			Privileged: false, SecurityOpt: ['no-new-privileges:true'], PidsLimit: 256,
		});
		expect(p.summary.customized).toBe(false);
	});

	it('allows custom pidsLimit', () => {
		const p = resolveContainerSecurityPolicy({ security: { pidsLimit: 512 } });
		expect(p.hostConfig.PidsLimit).toBe(512);
		expect(p.summary.customized).toBe(true);
	});

	it.each([
		[{ pidsLimit: 0 }],
		[{ pidsLimit: 1.5 }],
		[{ pidsLimit: 100000 }],
		[{ privileged: true }],
		[{ noNewPrivileges: false }],
		['privileged'],
	])('rejects invalid override %j', (security) => {
		expect(() => resolveContainerSecurityPolicy({ security })).toThrow(ContainerSecurityPolicyError);
	});

	it('hostConfigMatchesPolicy detects drift in pids limit', () => {
		const def = resolveContainerSecurityPolicy({});
		expect(hostConfigMatchesPolicy(def.hostConfig, def)).toBe(true);
		expect(hostConfigMatchesPolicy({ ...def.hostConfig, PidsLimit: 1000 }, def)).toBe(false);
	});

	it('gives a non-mutating hint for permission failures', () => {
		expect(permissionFailureHint("mkdir: cannot create directory '/var/lib/influxdb2': Permission denied")).toMatch(/no-new-privileges/);
		expect(permissionFailureHint('image not found')).toBeUndefined();
	});
});

describe('DockerManager lifecycle uses one resolved policy', () => {
	const config = { security: { pidsLimit: 512 }, volumes: ['data:/var/lib/data'], environment: { A: 'b' }, resources: undefined };
	const expected = { Privileged: false, SecurityOpt: ['no-new-privileges:true'], PidsLimit: 512 };

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

	it('recreates an existing container whose policy differs from the resolved policy', async () => {
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
	function makeCtx(startContainer: jest.Mock, runMs: any = jest.fn().mockResolvedValue(1000)) {
		const state = new Map<string, any>();
		const retryManager: any = {
			calls: [] as string[],
			shouldRetry: jest.fn((k: string) => { const s = state.get(k); return !s || (!s.terminal && s.nextRetry.getTime() <= Date.now()); }),
			recordFailure: jest.fn((k: string, msg: string, retryable?: boolean) => {
				const s = state.get(k) || { count: 0 };
				s.count++; s.lastError = msg; s.nextRetry = new Date(0);
				s.terminal = retryable === false || s.count >= 3;
				state.set(k, s);
			}),
			recordSuccess: jest.fn((k: string) => state.delete(k)),
			clearState: jest.fn((k: string) => state.delete(k)),
			clearStatesWithPrefix: jest.fn((prefix: string, keep?: string) => {
				for (const k of [...state.keys()]) if (k.startsWith(prefix) && k !== keep) state.delete(k);
			}),
			getState: jest.fn((k: string) => state.get(k)),
			isTerminal: jest.fn((k: string) => !!state.get(k)?.terminal),
		};
		const appService = svc();
		const app = { appId: 10, appName: 'a', services: [appService] };
		const sctx: any = { currentState: { apps: { 10: app } }, targetState: { apps: {} }, retryManager };
		const ctx: any = {
			retryManager,
			startContainer,
			getContainerRunDurationMs: runMs,
			getServiceFromCurrentState: () => appService,
			removeServiceFromCurrentState: jest.fn(),
			removeContainer: jest.fn().mockResolvedValue(undefined),
			healthCheckManager: { stopMonitoring: jest.fn() },
			markServiceAsError: (appId: number, id: any, type: any, msg: string) => markServiceAsError(sctx, appId, id, type, msg),
			addServiceToCurrentState: jest.fn(), markServiceAsRunning: jest.fn(),
			attachLogsToContainer: jest.fn(), startHealthMonitoring: jest.fn(),
		};
		return { ctx, retryManager, appService };
	}

	it('stops recreating a failing container after the retry budget and reports CrashLoopBackOff with policy', async () => {
		const start = jest.fn().mockRejectedValue(new Error('Permission denied'));
		const { ctx, appService } = makeCtx(start);
		const step: any = { action: 'startContainer', appId: 10, service: svc({ security: { pidsLimit: 512 } }) };
		for (let i = 0; i < 3; i++) await expect(executeStep(step, ctx)).rejects.toThrow('Permission denied');
		expect(appService.error?.type).toBe('CrashLoopBackOff');
		await expect(executeStep(step, ctx)).rejects.toThrow(/Max start retries exceeded/);
		expect(start).toHaveBeenCalledTimes(3);
		expect(appService.error?.message).toMatch(/Giving up after 3/);
		expect(appService.error?.message).toMatch(/no-new-privileges/);
	});

	it('treats invalid security policy as terminal immediately', async () => {
		const start = jest.fn().mockRejectedValue(new ContainerSecurityPolicyError('Invalid security config: bad'));
		const { ctx, appService } = makeCtx(start);
		const step: any = { action: 'startContainer', appId: 10, service: svc() };
		await expect(executeStep(step, ctx)).rejects.toThrow('Invalid security config');
		expect(appService.error?.type).toBe('CrashLoopBackOff');
		expect(appService.error?.securityPolicy?.pidsLimit).toBe(256);
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

	describe('startStoppedContainer accounting', () => {
		const stopped = (): any => ({ action: 'startStoppedContainer', appId: 10, serviceId: 1, containerId: 'old' });

		it('counts one retry unit when the restart succeeds after an unstable run', async () => {
			const { ctx, retryManager } = makeCtx(jest.fn().mockResolvedValue('new'));
			await executeStep(stopped(), ctx);
			expect(retryManager.recordFailure).toHaveBeenCalledTimes(1);
			expect(retryManager.recordFailure.mock.calls[0][1]).toMatch(/before reaching stable uptime/);
		});

		it('counts one retry unit when the restart operation itself fails', async () => {
			const { ctx, retryManager } = makeCtx(jest.fn().mockRejectedValue(new Error('boom')));
			await expect(executeStep(stopped(), ctx)).rejects.toThrow('boom');
			expect(retryManager.recordFailure).toHaveBeenCalledTimes(1);
			expect(retryManager.recordFailure.mock.calls[0][1]).toBe('boom');
		});

		it('resets the budget only after a verified stable run', async () => {
			const stable = makeCtx(jest.fn().mockResolvedValue('new'), jest.fn().mockResolvedValue(10 * 60 * 1000));
			await executeStep(stopped(), stable.ctx);
			expect(stable.retryManager.clearState).toHaveBeenCalledWith(serviceRetryKey(10, stable.appService));
			expect(stable.retryManager.recordFailure).not.toHaveBeenCalled();

			const unknown = makeCtx(jest.fn().mockResolvedValue('new'), jest.fn().mockResolvedValue(undefined));
			await executeStep(stopped(), unknown.ctx);
			expect(unknown.retryManager.clearState).not.toHaveBeenCalledWith(serviceRetryKey(10, unknown.appService));
		});

		it('time passing between attempts never resets the budget', async () => {
			const { ctx, retryManager, appService } = makeCtx(jest.fn().mockResolvedValue('new'));
			jest.useFakeTimers().setSystemTime(0);
			await executeStep(stopped(), ctx);
			jest.setSystemTime(60 * 60 * 1000);
			await executeStep(stopped(), ctx);
			jest.useRealTimers();
			expect(retryManager.clearState).not.toHaveBeenCalledWith(serviceRetryKey(10, appService));
		});
	});
});

describe('getContainerRunDurationMs', () => {
	const run = async (state: any) => {
		const mgr: any = Object.create(DockerManager.prototype);
		mgr.docker = { getContainer: () => ({ inspect: jest.fn().mockResolvedValue({ State: state }) }) };
		return mgr.getContainerRunDurationMs('c');
	};
	const started = new Date(Date.now() - 3600_000).toISOString();

	it('uses StartedAt..FinishedAt for stopped containers', async () => {
		const finished = new Date(Date.parse(started) + 1000).toISOString();
		expect(await run({ Running: false, StartedAt: started, FinishedAt: finished })).toBe(1000);
	});
	it.each([
		['missing', undefined],
		['empty', ''],
		['garbage', 'not-a-date'],
		['docker zero value', '0001-01-01T00:00:00Z'],
		['before start', '2000-01-01T00:00:00Z'],
	])('returns undefined for a stopped container with %s FinishedAt', async (_n, FinishedAt) => {
		expect(await run({ Running: false, StartedAt: started, FinishedAt })).toBeUndefined();
	});
	it('returns undefined when StartedAt is invalid or never started', async () => {
		expect(await run({ Running: false, StartedAt: '0001-01-01T00:00:00Z', FinishedAt: started })).toBeUndefined();
	});
	it('uses now for running containers', async () => {
		expect(await run({ Running: true, StartedAt: started })).toBeGreaterThanOrEqual(3600_000 - 5);
	});
	it('returns undefined when inspect fails', async () => {
		const mgr: any = Object.create(DockerManager.prototype);
		mgr.docker = { getContainer: () => ({ inspect: jest.fn().mockRejectedValue(new Error('no such container')) }) };
		expect(await mgr.getContainerRunDurationMs('c')).toBeUndefined();
	});
});

describe('obsolete retry state cleanup', () => {
	it('removes only superseded keys of the same service', () => {
		const rm = new RetryManager();
		const v1 = svc({ environment: { V: '1' } });
		const v2 = svc({ environment: { V: '2' } });
		const other = { ...svc(), serviceId: 11 } as ContainerService;
		const otherSame = { ...svc(), serviceId: 1, appId: 11 } as ContainerService;
		const keys = [serviceRetryKey(10, v1), serviceRetryKey(10, v2), serviceRetryKey(10, other), serviceRetryKey(11, otherSame), 'service:10:1', 'image:img'];
		keys.forEach((k) => rm.recordFailure(k, 'x', true));

		pruneObsoleteServiceRetries(rm, 10, v2);

		const left = [...rm.getAllStates().keys()];
		expect(left).toContain(serviceRetryKey(10, v2));
		expect(left).toContain(serviceRetryKey(10, other));
		expect(left).toContain(serviceRetryKey(11, otherSame));
		expect(left).toContain('image:img');
		expect(left).not.toContain(serviceRetryKey(10, v1));
		expect(left).not.toContain('service:10:1');
		expect(rm.getState(serviceRetryKey(10, v2))?.count).toBe(1);
	});

	it('executeStep keeps the active budget (still in backoff) and drops the old config record', async () => {
		const rm = new RetryManager();
		const oldSvc = svc({ environment: { V: '1' } });
		const newSvc = svc({ environment: { V: '2' } });
		rm.recordFailure(serviceRetryKey(10, oldSvc), 'x', true);
		rm.recordFailure(serviceRetryKey(10, newSvc), 'y', true);
		const ctx: any = {
			retryManager: rm,
			startContainer: jest.fn().mockRejectedValue(new Error('still failing')),
			markServiceAsError: jest.fn(),
		};
		await expect(executeStep({ action: 'startContainer', appId: 10, service: newSvc } as any, ctx)).rejects.toThrow(/backoff/);
		expect(ctx.startContainer).not.toHaveBeenCalled();
		expect(rm.getState(serviceRetryKey(10, oldSvc))).toBeUndefined();
		expect(rm.getState(serviceRetryKey(10, newSvc))?.count).toBe(1);
	});
});
