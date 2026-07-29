/**
 * Example: Complete Refactored Test Pattern
 * ==========================================
 *
 * Shows how to write testable code using dependency injection
 * and the MockHttpClient pattern.
 *
 * Target-state polling lives on StatePoller (src/sync/state-poller.ts),
 * which CloudSync delegates to via pullTargetStateNow() -> poller.pollNow().
 * These examples construct StatePoller directly since that's where the
 * actual, testable logic is.
 */

import { MockHttpClient } from '../../helpers/mock-http-client';
import { StatePoller } from '../../../src/sync/state-poller';
import { createMockAgentInfo, createMockTargetStateResponse } from '../../helpers/fixtures';
import { stub } from 'sinon';

describe('Example: Refactored Testing Pattern', () => {
	it('should demonstrate clean, testable code', async () => {
		// 1. Create mock dependencies
		const mockHttpClient = new MockHttpClient();
		const mockAgentInfo = createMockAgentInfo();
		const mockStateManager = {
			setTarget: stub().resolves(),
			getTargetState: stub().returns({ apps: {}, config: {} }),
		};

		// 2. Create system under test with injected mocks
		const statePoller: any = new StatePoller(
			mockHttpClient as any,
			mockStateManager,
			'http://api:3002',
			() => ({ pollInterval: 60000, apiTimeout: 30000 }),
			() => mockAgentInfo,
			undefined, // logger
		);
		// pollTargetState() only applies state when isRunning is true (normally
		// set by start()); these examples drive pollNow() directly.
		statePoller.isRunning = true;

		// 3. Configure mock behavior
		const targetState = createMockTargetStateResponse(mockAgentInfo.uuid);
		mockHttpClient.mockGetSuccess(targetState, { etag: 'abc123' });

		// 4. Execute test
		await statePoller.pollNow();

		// 5. Verify behavior
		expect(mockHttpClient.getStub.callCount).toBe(1);
		expect(mockStateManager.setTarget.callCount).toBe(1);

		// 6. Verify HTTP request details
		const [url, options] = mockHttpClient.getStub.firstCall.args;
		expect(url).toContain('/api/v1/device');
		expect(url).toContain(mockAgentInfo.uuid);
		expect(options.headers['X-Device-API-Key']).toBe(mockAgentInfo.apiKey);
		// Note: timeout is passed to HttpClient but not visible in stubbed args
	});

	it('should demonstrate error handling', async () => {
		// Setup
		const mockHttpClient = new MockHttpClient();
		const statePoller: any = new StatePoller(
			mockHttpClient as any,
			{ setTarget: stub().resolves(), getTargetState: stub().returns({ apps: {}, config: {} }) },
			'http://api:3002',
			() => ({ pollInterval: 60000, apiTimeout: 30000 }),
			() => createMockAgentInfo(),
			undefined,
		);

		// Configure mock to return 500 error
		mockHttpClient.mockGetError(500, 'Internal Server Error');

		// Execute & Verify
		await expect(statePoller.pollNow()).rejects.toThrow('HTTP 500');
	});

	it('should demonstrate timeout handling', async () => {
		// Setup
		const mockHttpClient = new MockHttpClient();
		const statePoller: any = new StatePoller(
			mockHttpClient as any,
			{ setTarget: stub().resolves(), getTargetState: stub().returns({ apps: {}, config: {} }) },
			'http://api:3002',
			() => ({ pollInterval: 60000, apiTimeout: 30000 }),
			() => createMockAgentInfo(),
			undefined,
		);

		// Configure mock to simulate timeout
		mockHttpClient.mockTimeout();

		// Execute & Verify
		await expect(statePoller.pollNow()).rejects.toThrow();
	});
});
