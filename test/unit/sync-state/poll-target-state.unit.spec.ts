/**
 * Unit Tests: StatePoller.pollNow
 * ======================================
 *
 * Tests the target state polling logic in isolation using dependency injection.
 * Mocks: HttpClient, StateManager (setTarget/getTargetState)
 *
 * pollTargetState() used to live directly on CloudSync; it now lives on the
 * separate StatePoller class that CloudSync delegates to via
 * `pullTargetStateNow()` -> `this.poller.pollNow()`. These tests exercise
 * StatePoller directly since that's where the actual logic is.
 *
 * Test Categories:
 * 1. Network Communication (HTTP responses)
 * 2. State Transformation (API response -> AgentState)
 * 3. State Reconciliation (calling setTarget)
 * 4. Error Handling (timeouts, server errors)
 * 5. ETag Caching (304 Not Modified)
 * 6. Version Tracking
 */

import { stub, restore } from 'sinon';
import { StatePoller } from '../../../src/sync/state-poller';
import type { AgentState } from '../../../src/core/state';
import { MockHttpClient } from '../../helpers/mock-http-client';
import {
	createMockTargetStateResponse,
	createMockAgentInfo,
	createTargetStateWithSensors,
	createTargetStateWithPartialConfig,
	createUnprovisionedAgentInfo,
	createCompleteConfigScenario,
	createPartialConfigScenario
} from '../../helpers/fixtures';

describe('StatePoller.pollNow', () => {
	// Test doubles
	let statePoller: any; // Use 'any' to access private members where useful
	let mockHttpClient: MockHttpClient;
	let mockStateManager: any;
	let agentInfo: ReturnType<typeof createMockAgentInfo>;

	function makePoller(info = agentInfo) {
		const poller: any = new StatePoller(
			mockHttpClient as any,
			mockStateManager,
			'http://api:3002',
			() => ({ pollInterval: 60000, apiTimeout: 30000 }),
			() => info,
			undefined, // logger
		);
		// pollTargetState() guards its state-apply step on isRunning (to avoid
		// mutating state if stop() fired mid-poll) -- normally set true by
		// start(), which these tests never call since they drive pollNow()
		// directly. Set it so the guard doesn't short-circuit setTarget.
		poller.isRunning = true;
		return poller;
	}

	beforeEach(() => {
		mockHttpClient = new MockHttpClient();
		agentInfo = createMockAgentInfo();

		mockStateManager = {
			setTarget: stub().resolves(),
			getTargetState: stub().returns({ apps: {}, config: {} }),
		};

		statePoller = makePoller();
	});

	afterEach(() => {
		restore();
		mockHttpClient.reset();
	});

	// ============================================================================
	// CATEGORY 1: Network Communication
	// ============================================================================

	describe('Network Communication', () => {
		it('should send GET request with correct headers', async () => {
			const targetState = createMockTargetStateResponse(agentInfo.uuid);

			mockHttpClient.mockGetSuccess(targetState);

			await statePoller.pollNow();

			expect(mockHttpClient.getStub.callCount).toBe(1);
			const [url, options] = mockHttpClient.getStub.firstCall.args;
			expect(url).toContain('/api/v1/device');
			expect(url).toContain(agentInfo.uuid);
			expect(options.headers['X-Device-API-Key']).toBe(agentInfo.apiKey);
		});

		it('should handle HTTP 200 response with state update', async () => {
			const targetState = createMockTargetStateResponse(agentInfo.uuid);

			mockHttpClient.mockGetSuccess(targetState);

			await statePoller.pollNow();

			expect(mockStateManager.setTarget.callCount).toBe(1);
		});

		it('should handle HTTP 304 Not Modified', async () => {
			mockHttpClient.mockGetNotModified();

			await statePoller.pollNow();

			// Should not call setTarget on 304
			expect(mockStateManager.setTarget.called).toBe(false);
		});

		it('should reject on HTTP 500 Server Error', async () => {
			mockHttpClient.mockGetError(500, 'Internal Server Error');

			await expect(statePoller.pollNow()).rejects.toThrow('HTTP 500');
		});

		it('should timeout after 30 seconds', async () => {
			mockHttpClient.mockTimeout();

			await expect(statePoller.pollNow()).rejects.toThrow();
		});

		it('should send If-None-Match header after first response with ETag', async () => {
			const targetState = createMockTargetStateResponse(agentInfo.uuid);

			// First request with ETag
			mockHttpClient.mockGetSuccess(targetState, { etag: 'abc123' });
			await statePoller.pollNow();

			// Second request should include ETag
			mockHttpClient.mockGetNotModified();
			await statePoller.pollNow();

			const [, secondOptions] = mockHttpClient.getStub.secondCall.args;
			expect(secondOptions.headers['if-none-match']).toBe('abc123');
		});

		it('should extract device UUID from getAgentInfo', async () => {
			const targetState = createMockTargetStateResponse(agentInfo.uuid);

			mockHttpClient.mockGetSuccess(targetState);

			await statePoller.pollNow();

			const [url] = mockHttpClient.getStub.firstCall.args;
			expect(url).toContain(agentInfo.uuid);
		});
	});

	// ============================================================================
	// CATEGORY 2: State Transformation
	// ============================================================================

	describe('State Transformation', () => {
		it('should extract config fields from API response', async () => {
			const { targetState } = createCompleteConfigScenario();

			mockHttpClient.mockGetSuccess(targetState);

			await statePoller.pollNow();

			const passedState: AgentState = mockStateManager.setTarget.firstCall.args[0];
			expect(passedState.config).toBeTruthy();
			expect(Object.keys(passedState.config || {}).length).toBeGreaterThan(0);
		});

		it('should preserve all 4 config fields', async () => {
			const { targetState } = createCompleteConfigScenario();

			mockHttpClient.mockGetSuccess(targetState);

			await statePoller.pollNow();

			const passedState: AgentState = mockStateManager.setTarget.firstCall.args[0];
			expect(passedState.config).toHaveProperty('logging');
			expect(passedState.config).toHaveProperty('sensors');
			expect(passedState.config).toHaveProperty('features');
			expect(passedState.config).toHaveProperty('settings');
		});

		it('should handle API returning only 2 config fields (bug scenario)', async () => {
			const { targetState } = createPartialConfigScenario();

			mockHttpClient.mockGetSuccess(targetState);

			await statePoller.pollNow();

			const passedState: AgentState = mockStateManager.setTarget.firstCall.args[0];
			// Should preserve whatever the API sends
			expect(passedState.config).toHaveProperty('logging');
			expect(passedState.config).toHaveProperty('sensors');
			// These might be missing in the bug scenario
			expect(Object.keys(passedState.config || {})).toBeTruthy();
		});

		it('should extract apps from target state', async () => {
			const targetState = createMockTargetStateResponse(agentInfo.uuid, {
				apps: {
					'1001': {
						appId: '1001',
						appName: 'test-app',
						services: []
					}
				}
			});

			mockHttpClient.mockGetSuccess(targetState);

			await statePoller.pollNow();

			const passedState: AgentState = mockStateManager.setTarget.firstCall.args[0];
			expect(passedState.apps).toHaveProperty('1001');
		});

		it('should extract sensors array from config', async () => {
			const targetState = createTargetStateWithSensors(agentInfo.uuid, 3);

			mockHttpClient.mockGetSuccess(targetState);

			await statePoller.pollNow();

			const passedState: AgentState = mockStateManager.setTarget.firstCall.args[0];
			expect((passedState.config as any).sensors).toHaveLength(3);
		});

		it('should handle minimal target state (no apps, minimal config)', async () => {
			const targetState = {
				[agentInfo.uuid]: {
					apps: {},
					config: {
						logging: { level: 'info' } // Minimal but non-empty
					},
					version: 1
				}
			};

			mockHttpClient.mockGetSuccess(targetState);

			await statePoller.pollNow();

			const passedState: AgentState = mockStateManager.setTarget.firstCall.args[0];
			expect(passedState.apps).toEqual({});
			expect(passedState.config).toMatchObject({
				logging: expect.anything()
			});
		});

		it('should handle partial config (missing some fields)', async () => {
			const targetState = createTargetStateWithPartialConfig(agentInfo.uuid);

			mockHttpClient.mockGetSuccess(targetState);

			await statePoller.pollNow();

			const passedState: AgentState = mockStateManager.setTarget.firstCall.args[0];
			expect(passedState.config).toBeTruthy();
		});
	});

	// ============================================================================
	// CATEGORY 3: State Reconciliation
	// ============================================================================

	describe('State Reconciliation', () => {
		it('should call stateManager.setTarget with extracted state', async () => {
			const targetState = createMockTargetStateResponse(agentInfo.uuid);

			mockHttpClient.mockGetSuccess(targetState);

			await statePoller.pollNow();

			expect(mockStateManager.setTarget.callCount).toBe(1);
			expect(mockStateManager.setTarget.firstCall.args[0]).toHaveProperty('config');
			expect(mockStateManager.setTarget.firstCall.args[0]).toHaveProperty('apps');
		});

		it('should emit "target-state-changed" event after applying a new state', async () => {
			const eventSpy = jest.fn();
			statePoller.on('target-state-changed', eventSpy);

			const targetState = createMockTargetStateResponse(agentInfo.uuid);

			mockHttpClient.mockGetSuccess(targetState);

			await statePoller.pollNow();

			expect(eventSpy).toHaveBeenCalled();
		});

		it('should not call setTarget when device is not provisioned', async () => {
			const unprovisionedPoller: any = new StatePoller(
				mockHttpClient as any,
				mockStateManager,
				'http://api:3002',
				() => ({ pollInterval: 60000, apiTimeout: 30000 }),
				() => createUnprovisionedAgentInfo(),
				undefined,
			);

			const targetState = createMockTargetStateResponse('some-uuid');
			mockHttpClient.mockGetSuccess(targetState);

			await unprovisionedPoller.pollNow();

			expect(mockStateManager.setTarget.called).toBe(false);
			// Not provisioned -> must skip before ever calling the API.
			expect(mockHttpClient.getStub.called).toBe(false);
		});

		it('should track version number after polling', async () => {
			const targetState = createMockTargetStateResponse(agentInfo.uuid, { version: 5 });

			mockHttpClient.mockGetSuccess(targetState);

			const result = await statePoller.pollNow();

			expect(mockStateManager.setTarget.callCount).toBe(1);
			expect(result.version).toBe(5);
		});

		it('should update state even when config partially matches current', async () => {
			// First update
			let targetState = createMockTargetStateResponse(agentInfo.uuid);
			mockHttpClient.mockGetSuccess(targetState);
			await statePoller.pollNow();

			mockStateManager.setTarget.resetHistory();
			mockHttpClient.reset();

			// Second update with different config (change logging level)
			targetState = createMockTargetStateResponse(agentInfo.uuid, {
				version: 2,
				config: {
					logging: { level: 'debug', enabled: true },
					sensors: [],
					features: { enableModbus: false, enableMqtt: true },
					settings: { timezone: 'UTC', language: 'en' }
				}
			});
			mockHttpClient.mockGetSuccess(targetState);
			await statePoller.pollNow();

			expect(mockStateManager.setTarget.callCount).toBe(1);
		});
	});

	// ============================================================================
	// CATEGORY 4: Error Handling
	// ============================================================================

	describe('Error Handling', () => {
		it('should handle network request failure', async () => {
			mockHttpClient.mockNetworkError('Network request failed');

			await expect(statePoller.pollNow()).rejects.toThrow('Network request failed');
		});

		it('should handle timeout error', async () => {
			mockHttpClient.mockTimeout();

			await expect(statePoller.pollNow()).rejects.toThrow();
		});

		it('should handle server error (HTTP 500)', async () => {
			mockHttpClient.mockGetError(500, 'Internal Server Error');

			await expect(statePoller.pollNow()).rejects.toThrow();
		});

		it('should handle malformed JSON response', async () => {
			const response = {
				ok: true,
				status: 200,
				headers: { get: () => null },
				json: async () => { throw new Error('Invalid JSON'); }
			};

			mockHttpClient.getStub.resolves(response as any);

			await expect(statePoller.pollNow()).rejects.toThrow('Invalid JSON');
		});

		it('should warn when device UUID not in response', async () => {
			const targetState = {
				'different-uuid': {
					apps: {},
					config: {},
					version: 1
				}
			};

			mockHttpClient.mockGetSuccess(targetState);

			await statePoller.pollNow();

			// Should not call setTarget when UUID doesn't match
			expect(mockStateManager.setTarget.called).toBe(false);
		});
	});

	// ============================================================================
	// CATEGORY 5: ETag Caching
	// ============================================================================

	describe('ETag Caching', () => {
		it('should store ETag from first response', async () => {
			const targetState = createMockTargetStateResponse(agentInfo.uuid);
			const etag = 'abc123';

			mockHttpClient.mockGetSuccess(targetState, { etag });

			await statePoller.pollNow();

			// DON'T reset - we need to keep call history
			// Next request should include the ETag
			mockHttpClient.mockGetNotModified();
			await statePoller.pollNow();

			// Check the second call includes If-None-Match header
			expect(mockHttpClient.getStub.callCount).toBe(2);
			const headers = mockHttpClient.getStub.secondCall.args[1]?.headers;
			expect(headers?.['if-none-match']).toBe(etag);
		});

		it('should not call setTarget on 304 response', async () => {
			const targetState = createMockTargetStateResponse(agentInfo.uuid);

			// First poll with ETag
			mockHttpClient.mockGetSuccess(targetState, { etag: 'abc123' });
			await statePoller.pollNow();
			expect(mockStateManager.setTarget.callCount).toBe(1);

			mockStateManager.setTarget.resetHistory();
			mockHttpClient.reset();

			// Second poll returns 304
			mockHttpClient.mockGetNotModified();
			await statePoller.pollNow();
			expect(mockStateManager.setTarget.called).toBe(false);
		});

		it('should handle response without ETag header', async () => {
			const targetState = createMockTargetStateResponse(agentInfo.uuid);

			// Response without ETag
			mockHttpClient.mockGetSuccess(targetState);

			await statePoller.pollNow();

			// Should still work
			expect(mockStateManager.setTarget.callCount).toBe(1);
		});
	});

	// ============================================================================
	// CATEGORY 6: Version Tracking
	// ============================================================================

	describe('Version Tracking', () => {
		it('should extract version from response', async () => {
			const targetState = createMockTargetStateResponse(agentInfo.uuid, { version: 3 });

			mockHttpClient.mockGetSuccess(targetState);

			const result = await statePoller.pollNow();

			expect(mockStateManager.setTarget.callCount).toBe(1);
			expect(result.version).toBe(3);
		});

		it('should default to version 1 if not provided', async () => {
			const targetState = {
				[agentInfo.uuid]: {
					apps: {},
					config: {
						logging: { level: 'info', enabled: true },
						sensors: [],
						features: { enableModbus: false },
						settings: { timezone: 'UTC' }
					}
					// version missing
				}
			};

			mockHttpClient.mockGetSuccess(targetState);

			const result = await statePoller.pollNow();

			expect(mockStateManager.setTarget.callCount).toBe(1);
			expect(result.version).toBe(1);
		});

		it('should handle version increment', async () => {
			// Version 1
			let targetState = createMockTargetStateResponse(agentInfo.uuid, { version: 1 });
			mockHttpClient.mockGetSuccess(targetState);
			await statePoller.pollNow();

			mockStateManager.setTarget.resetHistory();
			mockHttpClient.reset();

			// Version 2 with different config (to trigger state change)
			targetState = createMockTargetStateResponse(agentInfo.uuid, {
				version: 2,
				config: {
					logging: { level: 'debug', enabled: true },
					sensors: [],
					features: { enableModbus: true, enableMqtt: true },
					settings: { timezone: 'UTC', language: 'en' }
				}
			});
			mockHttpClient.mockGetSuccess(targetState);
			const result = await statePoller.pollNow();

			expect(mockStateManager.setTarget.callCount).toBe(1);
			expect(result.version).toBe(2);
		});
	});

	// ============================================================================
	// EDGE CASES
	// ============================================================================

	describe('Edge Cases', () => {
		it('should handle empty apps object', async () => {
			const targetState = createMockTargetStateResponse(agentInfo.uuid, { apps: {} });

			mockHttpClient.mockGetSuccess(targetState);

			await statePoller.pollNow();

			const passedState: AgentState = mockStateManager.setTarget.firstCall.args[0];
			expect(passedState.apps).toEqual({});
		});

		it('should handle null config gracefully', async () => {
			const targetState = {
				[agentInfo.uuid]: {
					apps: { '1001': { appId: '1001', appName: 'test', services: [] } }, // Add an app to trigger state change
					config: null as any, // Simulate bad API response
					version: 1
				}
			};

			mockHttpClient.mockGetSuccess(targetState);

			await statePoller.pollNow();

			// Should still call setTarget, but with empty config object
			expect(mockStateManager.setTarget.callCount).toBe(1);
			const passedState: AgentState = mockStateManager.setTarget.firstCall.args[0];
			expect(passedState.config).toEqual({});
		});

		it('should handle large sensor arrays', async () => {
			const targetState = createTargetStateWithSensors(agentInfo.uuid, 100);

			mockHttpClient.mockGetSuccess(targetState);

			await statePoller.pollNow();

			const passedState: AgentState = mockStateManager.setTarget.firstCall.args[0];
			expect((passedState.config as any).sensors).toHaveLength(100);
		});
	});
});
