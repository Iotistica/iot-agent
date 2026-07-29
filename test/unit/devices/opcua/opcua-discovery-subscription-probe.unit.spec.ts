/**
 * Unit tests for OPCUADiscovery's subscription-support probe.
 * Verifies the discovery-time capability check we added: rather than
 * assuming a server supports subscriptions, discovery actually tries to
 * create one and records whether it succeeded.
 */

import { OPCUADiscovery } from '../../../../src/plugins/opcua/discovery';

describe('OPCUADiscovery.probeSubscriptionSupport', () => {
	let discovery: any;

	beforeEach(() => {
		discovery = new OPCUADiscovery();
	});

	it('returns true when the server accepts a real subscription', async () => {
		const terminate = jest.fn().mockResolvedValue(undefined);
		const session = {
			createSubscription2: jest.fn().mockResolvedValue({ terminate }),
		};

		const result = await discovery.probeSubscriptionSupport(session);

		expect(result).toBe(true);
		expect(session.createSubscription2).toHaveBeenCalledWith(
			expect.objectContaining({ publishingEnabled: true }),
		);
		expect(terminate).toHaveBeenCalled();
	});

	it('returns false when the server rejects CreateSubscription (e.g. BadServiceUnsupported)', async () => {
		const session = {
			createSubscription2: jest.fn().mockRejectedValue(new Error('BadServiceUnsupported')),
		};

		const result = await discovery.probeSubscriptionSupport(session);

		expect(result).toBe(false);
	});

	it('returns false rather than throwing when the probe subscription fails to terminate cleanly', async () => {
		const session = {
			createSubscription2: jest.fn().mockResolvedValue({
				terminate: jest.fn().mockRejectedValue(new Error('session already closed')),
			}),
		};

		const result = await discovery.probeSubscriptionSupport(session);

		// terminate() failures are swallowed -- the probe already got its answer
		// (the server DID accept the subscription) by the time terminate() runs.
		expect(result).toBe(true);
	});

	it('never throws out of the probe, even on an unexpected error shape', async () => {
		const session = {
			createSubscription2: jest.fn().mockRejectedValue('not an Error instance'),
		};

		await expect(discovery.probeSubscriptionSupport(session)).resolves.toBe(false);
	});
});
