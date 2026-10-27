jest.mock('dockerode', () => {
	return jest.fn().mockImplementation(() => ({
		createContainer: jest.fn(),
		getNetwork: jest.fn(),
		listContainers: jest.fn().mockResolvedValue([]),
	}));
});

jest.mock('node:fs', () => {
	const actual = jest.requireActual('node:fs');
	return {
		...actual,
		existsSync: jest.fn().mockReturnValue(false),
		promises: {
			mkdir: jest.fn().mockResolvedValue(undefined),
			rm: jest.fn().mockResolvedValue(undefined),
		},
	};
});

import { DockerManager } from '../../../src/containers/docker-manager';
import { SOCKET_CONTAINER_PATH, SOCKET_HOST_BASE } from '../../../src/containers/socket-mount';
import type { ContainerService } from '../../../src/containers/container-manager';
import * as socketMount from '../../../src/containers/socket-mount';
import fs from 'node:fs';

function makeService(overrides: Partial<ContainerService & { config: any }> = {}): ContainerService {
	return {
		serviceId: 1,
		serviceName: 'test-svc',
		imageName: 'test-image:latest',
		appId: 10,
		appName: 'test-app',
		config: {
			image: 'test-image:latest',
			...(overrides.config || {}),
		},
		...overrides,
		// Re-apply config after spread to avoid it being replaced
	} as ContainerService;
}

function makeDockerManager() {
	const mgr: any = Object.create(DockerManager.prototype);
	const mockContainer = {
		id: 'abc123def456',
		start: jest.fn().mockResolvedValue(undefined),
	};
	mgr.docker = {
		createContainer: jest.fn().mockResolvedValue(mockContainer),
		getNetwork: jest.fn(),
		listContainers: jest.fn().mockResolvedValue([]),
	};
	mgr.logger = {
		debugSync: jest.fn(),
		infoSync: jest.fn(),
		warnSync: jest.fn(),
		errorSync: jest.fn(),
	};
	mgr.findContainerByName = jest.fn().mockResolvedValue(null);
	mgr.hasImage = jest.fn().mockResolvedValue(true);
	mgr.pullImageWithRetry = jest.fn().mockResolvedValue(undefined);
	mgr.sanitizeNamePart = jest.fn((s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_'));
	mgr.parseResourceLimits = jest.fn().mockReturnValue({});
	mgr.validateSecurityConfig = jest.fn();
	return { mgr, mockContainer };
}

describe('DockerManager socket destination', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		(fs.existsSync as jest.Mock).mockReturnValue(false);
	});

	describe('startContainer', () => {
		it('appends socket bind to Binds when enableSocketDestination is true', async () => {
			const { mgr } = makeDockerManager();
			const svc = makeService({ config: { image: 'x', enableSocketDestination: true } });

			await mgr.startContainer(svc);

			const createCall = mgr.docker.createContainer.mock.calls[0][0];
			expect(createCall.HostConfig.Binds).toContain(`${SOCKET_HOST_BASE}/10_1:/run/agent-ipc`);
		});

		it('includes iotistic.socket-destination label when enabled', async () => {
			const { mgr } = makeDockerManager();
			const svc = makeService({ config: { image: 'x', enableSocketDestination: true } });

			await mgr.startContainer(svc);

			const createCall = mgr.docker.createContainer.mock.calls[0][0];
			expect(createCall.Labels['iotistic.socket-destination']).toBe('true');
		});

		it('includes iotistic.socket-path label when enabled', async () => {
			const { mgr } = makeDockerManager();
			const svc = makeService({ config: { image: 'x', enableSocketDestination: true } });

			await mgr.startContainer(svc);

			const createCall = mgr.docker.createContainer.mock.calls[0][0];
			expect(createCall.Labels['iotistic.socket-path']).toBe('/run/agent-ipc/app.sock');
		});

		it('includes AGENT_IPC_SOCKET env var when enabled', async () => {
			const { mgr } = makeDockerManager();
			const svc = makeService({ config: { image: 'x', enableSocketDestination: true } });

			await mgr.startContainer(svc);

			const createCall = mgr.docker.createContainer.mock.calls[0][0];
			expect(createCall.Env).toContain('AGENT_IPC_SOCKET=/run/agent-ipc/app.sock');
		});

		it('does not include AGENT_IPC_SOCKET env var when disabled', async () => {
			const { mgr } = makeDockerManager();
			const svc = makeService({ config: { image: 'x', enableSocketDestination: false } });

			await mgr.startContainer(svc);

			const createCall = mgr.docker.createContainer.mock.calls[0][0];
			expect(createCall.Env).not.toContain('AGENT_IPC_SOCKET=/run/agent-ipc/app.sock');
		});

		it('does not add socket bind when enableSocketDestination is false', async () => {
			const { mgr } = makeDockerManager();
			const svc = makeService({ config: { image: 'x', enableSocketDestination: false } });

			await mgr.startContainer(svc);

			const createCall = mgr.docker.createContainer.mock.calls[0][0];
			expect(createCall.HostConfig.Binds).toBeUndefined();
			expect(createCall.Labels['iotistic.socket-destination']).toBeUndefined();
		});

		it('does not add socket bind when enableSocketDestination is undefined', async () => {
			const { mgr } = makeDockerManager();
			const svc = makeService();

			await mgr.startContainer(svc);

			const createCall = mgr.docker.createContainer.mock.calls[0][0];
			expect(createCall.HostConfig.Binds).toBeUndefined();
		});

		it('rejects mount conflict when user volume targets /run/agent-ipc', async () => {
			const { mgr } = makeDockerManager();
			const svc = makeService({
				config: {
					image: 'x',
					enableSocketDestination: true,
					volumes: ['/my/data:/run/agent-ipc'],
				},
			});

			await expect(mgr.startContainer(svc)).rejects.toThrow('Mount conflict');
		});

		it('cleans up newly created directory when createContainer fails', async () => {
			const { mgr } = makeDockerManager();
			mgr.docker.createContainer.mockRejectedValue(new Error('Docker error'));
			const removeSpy = jest.spyOn(socketMount, 'removeSocketDir').mockResolvedValue(undefined);

			const svc = makeService({ config: { image: 'x', enableSocketDestination: true } });

			await expect(mgr.startContainer(svc)).rejects.toThrow('Docker error');
			expect(removeSpy).toHaveBeenCalledWith(10, 1, mgr.logger);
			removeSpy.mockRestore();
		});

		it('cleans up newly created directory when container.start() fails', async () => {
			const { mgr, mockContainer } = makeDockerManager();
			mockContainer.start.mockRejectedValue(new Error('start failed'));
			const removeSpy = jest.spyOn(socketMount, 'removeSocketDir').mockResolvedValue(undefined);

			const svc = makeService({ config: { image: 'x', enableSocketDestination: true } });

			await expect(mgr.startContainer(svc)).rejects.toThrow('start failed');
			expect(removeSpy).toHaveBeenCalledWith(10, 1, mgr.logger);
			removeSpy.mockRestore();
		});

		it('preserves pre-existing directory when createContainer fails', async () => {
			(fs.existsSync as jest.Mock).mockReturnValue(true);
			const { mgr } = makeDockerManager();
			mgr.docker.createContainer.mockRejectedValue(new Error('Docker error'));
			const removeSpy = jest.spyOn(socketMount, 'removeSocketDir').mockResolvedValue(undefined);

			const svc = makeService({ config: { image: 'x', enableSocketDestination: true } });

			await expect(mgr.startContainer(svc)).rejects.toThrow('Docker error');
			expect(removeSpy).not.toHaveBeenCalled();
			removeSpy.mockRestore();
		});

		it('includes user volumes alongside socket bind', async () => {
			const { mgr } = makeDockerManager();
			const svc = makeService({
				config: {
					image: 'x',
					enableSocketDestination: true,
					volumes: ['data:/app/data'],
				},
			});

			await mgr.startContainer(svc);

			const createCall = mgr.docker.createContainer.mock.calls[0][0];
			expect(createCall.HostConfig.Binds).toContain('data:/app/data');
			expect(createCall.HostConfig.Binds).toContain(`${SOCKET_HOST_BASE}/10_1:/run/agent-ipc`);
		});
	});

	describe('updateContainer (socket-enabled stop-before-start)', () => {
		it('uses stop-before-start when enableSocketDestination is true', async () => {
			const { mgr } = makeDockerManager();
			const svc = makeService({ config: { image: 'x', enableSocketDestination: true } });

			const id = await mgr.updateContainer(svc);

			expect(id).toBe('abc123def456');
			const createCall = mgr.docker.createContainer.mock.calls[0][0];
			expect(createCall.HostConfig.Binds).toContain(`${SOCKET_HOST_BASE}/10_1:/run/agent-ipc`);
			expect(createCall.Labels['iotistic.socket-destination']).toBe('true');
		});

		it('stops and removes old container before creating new one', async () => {
			const { mgr } = makeDockerManager();
			const oldContainer = {
				inspect: jest.fn().mockResolvedValue({ Id: 'old123', State: { Status: 'running' } }),
			};
			mgr.findContainerByName = jest.fn().mockResolvedValue(oldContainer);
			mgr.stopContainer = jest.fn().mockResolvedValue(undefined);
			mgr.removeContainer = jest.fn().mockResolvedValue(undefined);

			const svc = makeService({ config: { image: 'x', enableSocketDestination: true } });
			await mgr.updateContainer(svc);

			expect(mgr.stopContainer).toHaveBeenCalledWith('old123', 10);
			expect(mgr.removeContainer).toHaveBeenCalledWith('old123', true);
		});

		it('does not remove socket directory on creation failure', async () => {
			const { mgr } = makeDockerManager();
			mgr.docker.createContainer.mockRejectedValue(new Error('create failed'));
			const removeSpy = jest.spyOn(socketMount, 'removeSocketDir');

			const svc = makeService({ config: { image: 'x', enableSocketDestination: true } });

			await expect(mgr.updateContainer(svc)).rejects.toThrow('create failed');
			expect(removeSpy).not.toHaveBeenCalled();
			removeSpy.mockRestore();
		});
	});
});

describe('docker-state-sync socket reconstruction', () => {
	it('reconstructs enableSocketDestination from valid mount', async () => {
		const { syncStateFromDocker } = require('../../../src/containers/docker-state-sync');

		const mockContainer = {
			id: 'c1',
			image: 'test:latest',
			state: 'running',
			ports: [],
			labels: {
				'iotistic.app-id': '1',
				'iotistic.app-name': 'app',
				'iotistic.service-id': '2',
				'iotistic.service-name': 'svc',
			},
		};

		const ctx = {
			dockerManager: {
				listManagedContainers: jest.fn().mockResolvedValue([mockContainer]),
				inspectContainer: jest.fn().mockResolvedValue({
					Mounts: [
						{
							Type: 'bind',
							Source: `${SOCKET_HOST_BASE}/1_2`,
							Destination: '/run/agent-ipc',
						},
					],
					Config: { Env: [], Labels: {}, Cmd: null, Entrypoint: null, User: '' },
					HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: 'bridge' },
					NetworkSettings: { Networks: {} },
				}),
			},
			logger: { warnSync: jest.fn(), debugSync: jest.fn() },
		};

		const state = await syncStateFromDocker(ctx);
		const svc = state.apps[1].services[0];
		expect(svc.config.enableSocketDestination).toBe(true);
		expect(svc.config.volumes).toEqual([]);
	});

	it('ignores mount to /run/agent-ipc with non-agent source', async () => {
		const { syncStateFromDocker } = require('../../../src/containers/docker-state-sync');

		const mockContainer = {
			id: 'c2',
			image: 'test:latest',
			state: 'running',
			ports: [],
			labels: {
				'iotistic.app-id': '1',
				'iotistic.app-name': 'app',
				'iotistic.service-id': '2',
				'iotistic.service-name': 'svc',
			},
		};

		const ctx = {
			dockerManager: {
				listManagedContainers: jest.fn().mockResolvedValue([mockContainer]),
				inspectContainer: jest.fn().mockResolvedValue({
					Mounts: [
						{
							Type: 'bind',
							Source: '/home/user/custom',
							Destination: '/run/agent-ipc',
						},
					],
					Config: { Env: [], Labels: {}, Cmd: null, Entrypoint: null, User: '' },
					HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: 'bridge' },
					NetworkSettings: { Networks: {} },
				}),
			},
			logger: { warnSync: jest.fn(), debugSync: jest.fn() },
		};

		const state = await syncStateFromDocker(ctx);
		const svc = state.apps[1].services[0];
		expect(svc.config.enableSocketDestination).toBeUndefined();
		expect(svc.config.volumes).toContain('/home/user/custom:/run/agent-ipc');
	});
});

describe('reconciliation-planner socket change detection', () => {
	it('detects enableSocketDestination change', () => {
		const { planStepsToUpdateApp } = require('../../../src/containers/reconciliation-planner');

		const current = {
			appId: 1,
			appName: 'app',
			services: [{
				serviceId: 1,
				serviceName: 'svc',
				imageName: 'img:1',
				appId: 1,
				appName: 'app',
				containerId: 'c1',
				status: 'running',
				config: { image: 'img:1', enableSocketDestination: false },
			}],
		};

		const target = {
			appId: 1,
			appName: 'app',
			services: [{
				serviceId: 1,
				serviceName: 'svc',
				imageName: 'img:1',
				appId: 1,
				appName: 'app',
				config: { image: 'img:1', enableSocketDestination: true },
			}],
		};

		const steps = planStepsToUpdateApp(current, target);
		expect(steps.length).toBeGreaterThan(0);
		const hasStopOrStart = steps.some(
			(s: any) => s.action === 'stopContainer' || s.action === 'startContainer',
		);
		expect(hasStopOrStart).toBe(true);
	});
});
