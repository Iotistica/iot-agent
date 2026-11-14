jest.mock('dockerode', () => {
	return jest.fn().mockImplementation(() => ({
		createContainer: jest.fn(),
		getNetwork: jest.fn(),
		listContainers: jest.fn().mockResolvedValue([]),
	}));
});

import { ContainerManager } from '../../../src/containers/container-manager';

describe('ContainerManager.applyTargetState', () => {
	it('refreshes Docker state before calculating reconciliation steps', async () => {
		const manager: any = Object.create(ContainerManager.prototype);
		const calls: string[] = [];
		manager.useRealDocker = true;
		manager.isApplyingState = false;
		manager.logger = undefined;
		manager.syncCurrentStateFromDocker = jest.fn(async () => {
			calls.push('sync');
		});
		manager.calculateSteps = jest.fn(() => {
			calls.push('calculate');
			return [];
		});

		await manager.applyTargetState();

		expect(manager.syncCurrentStateFromDocker).toHaveBeenCalled();
		expect(calls).toEqual(['sync', 'calculate']);
	});
});
