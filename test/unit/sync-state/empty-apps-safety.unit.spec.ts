import { stub } from 'sinon';
import { StatePoller } from '../../../src/sync/state-poller';
import { reconcileVolumesForApp } from '../../../src/containers/reconciliation-planner';
import { MockHttpClient } from '../../helpers/mock-http-client';
import { createMockAgentInfo } from '../../helpers/fixtures';

describe('Reconciliation safety for empty/missing apps', () => {
	const existingApps = { 1: { appId: 1, services: [] } };
	let http: MockHttpClient;
	let sm: any;
	let info: ReturnType<typeof createMockAgentInfo>;

	function poller() {
		const p: any = new StatePoller(http as any, sm, 'http://api:3002',
			() => ({ pollInterval: 60000, apiTimeout: 30000 }), () => info, undefined);
		p.isRunning = true;
		return p;
	}

	beforeEach(() => {
		http = new MockHttpClient();
		info = createMockAgentInfo();
		sm = {
			setTarget: stub().resolves(),
			getTargetState: stub().returns({ apps: existingApps, config: {} }),
		};
	});

	it('preserves existing apps when apps is missing', async () => {
		http.mockGetSuccess({ [info.uuid]: { version: 2, config: { x: 1 } } });
		await poller().pollNow();
		expect(sm.setTarget.calledOnce).toBe(true);
		expect(sm.setTarget.firstCall.args[0].apps).toEqual(existingApps);
	});

	it('preserves existing apps when apps is invalid (array)', async () => {
		http.mockGetSuccess({ [info.uuid]: { version: 2, apps: [], config: { x: 1 } } });
		await poller().pollNow();
		expect(sm.setTarget.firstCall.args[0].apps).toEqual(existingApps);
	});

	it('applies explicitly empty apps', async () => {
		http.mockGetSuccess({ [info.uuid]: { version: 2, apps: {}, config: {} } });
		await poller().pollNow();
		expect(sm.setTarget.firstCall.args[0].apps).toEqual({});
	});

	it('does not touch state when retrieval fails', async () => {
		http.mockGetError(500, 'Server Error');
		await poller().pollNow().catch(() => undefined);
		expect(sm.setTarget.called).toBe(false);
	});

	it('keeps volumes when whole app is absent from target', () => {
		const app: any = { appId: 1, services: [{ serviceName: 'n', volumes: ['node-red-data:/data'] }] };
		expect(reconcileVolumesForApp(1, app, undefined)).toEqual([]);
	});

	it('still removes volumes dropped from a retained app', () => {
		const cur: any = { appId: 1, services: [{ serviceName: 'n', volumes: ['a:/a', 'b:/b'] }] };
		const tgt: any = { appId: 1, services: [{ serviceName: 'n', volumes: ['a:/a'] }] };
		expect(reconcileVolumesForApp(1, cur, tgt)).toEqual([{ action: 'removeVolume', appId: 1, volumeName: 'b' }]);
	});
});
