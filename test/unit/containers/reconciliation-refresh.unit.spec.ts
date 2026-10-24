jest.mock('../../../src/containers/docker-manager', () => ({
	DockerManager: jest.fn(),
}));
jest.mock('../../../src/containers/docker-ops', () => ({}));

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

		await manager.applyTargetState({ saveState: false });

		expect(manager.syncCurrentStateFromDocker).toHaveBeenCalledWith(false);
		expect(calls).toEqual(['sync', 'calculate']);
	});
});
