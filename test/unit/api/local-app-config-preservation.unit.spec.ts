import * as actions from '../../../src/api/actions';

describe('local app preservation during configuration updates', () => {
	afterEach(() => {
		actions.setStateManager(undefined);
		actions.initialize(undefined as any, {} as any);
	});

	it('preserves local apps while keeping StateManager apps authoritative', async () => {
		const stateManagedApp = { appId: 1, appName: 'cloud-app', services: [] };
		const staleContainerApp = { appId: 1, appName: 'stale-app', services: [] };
		const localApp = { appId: 2, appName: 'local-app', services: [] };
		const stateManager = {
			getTargetState: jest.fn().mockReturnValue({
				apps: { 1: stateManagedApp },
				config: {},
			}),
			setTarget: jest.fn().mockResolvedValue(undefined),
		};
		const containerManager = {
			getTargetState: jest.fn().mockReturnValue({
				apps: { 1: staleContainerApp, 2: localApp },
			}),
		};

		actions.initialize(containerManager as any, {} as any);
		actions.setStateManager(stateManager as any);

		await actions.updateSettings({ logging: { level: 'debug' } });

		expect(stateManager.setTarget).toHaveBeenCalledWith({
			apps: { 1: stateManagedApp, 2: localApp },
			config: { logging: { level: 'debug' } },
		});
	});
});
