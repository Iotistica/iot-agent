import * as crypto from 'crypto';
import { bootstrapLicense } from '../../../src/licensing/bootstrap';
import { LicenseService } from '../../../src/licensing/service';
import { signLicensePayload } from '../../../src/licensing/token';
import type { LicensePayload, LicenseStore, StoredLicense } from '../../../src/licensing/types';
import { MockHttpClient } from '../../helpers/mock-http-client';

const DAY = 86_400_000;
const keys = () => {
	const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
	return {
		pub: publicKey.export({ type: 'spki', format: 'pem' }) as string,
		priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
	};
};

class MemoryStore implements LicenseStore {
	value: StoredLicense | null = null;
	load() { return this.value; }
	save(l: StoredLicense) { this.value = l; }
	clear() { this.value = null; }
}

describe('LicenseService', () => {
	const vendor = keys();
	const other = keys();
	let now: number;
	let store: MemoryStore;
	let http: MockHttpClient;
	let svc: LicenseService;
	const agent = { uuid: 'agent-1', apiKey: 'key', apiEndpoint: 'http://api.test' };

	const token = (p: Partial<LicensePayload>, priv = vendor.priv) =>
		signLicensePayload(
			{ licenseId: 'L1', agentUuid: 'agent-1', tier: 'trial', issuedAt: now, expiresAt: now + 14 * DAY, ...p },
			priv,
		);
	const serverReturns = (t: string) =>
		http.postStub.resolves({ ok: true, status: 200, statusText: 'OK', json: async () => ({ token: t }) });

	beforeEach(() => {
		now = 1_800_000_000_000;
		store = new MemoryStore();
		http = new MockHttpClient();
		svc = new LicenseService(store, http, vendor.pub, () => agent, undefined, () => now);
	});

	it('is unlicensed by default', () => {
		expect(svc.getStatus().state).toBe('unlicensed');
	});

	it('activates a trial via the backend using the agent key and persists it', async () => {
		serverReturns(token({}));
		const status = await svc.activateTrial();
		expect(status).toMatchObject({ state: 'trial', tier: 'trial', daysRemaining: 14 });
		const [url, , opts] = http.postStub.firstCall.args;
		expect(url).toContain('/api/v1/agent/agent-1/license/trial');
		expect(opts.headers['x-agent-key']).toBe('key');
		expect(store.value).not.toBeNull();
	});

	it('refuses to re-activate a trial when a license exists', async () => {
		serverReturns(token({}));
		await svc.activateTrial();
		await expect(svc.activateTrial()).rejects.toThrow(/already present/);
	});

	it('expires the trial locally with no network (offline restart)', async () => {
		serverReturns(token({}));
		await svc.activateTrial();
		http.postStub.resetHistory();
		now += 15 * DAY;
		const restarted = new LicenseService(store, http, vendor.pub, () => agent, undefined, () => now);
		expect(restarted.getStatus()).toMatchObject({ state: 'trial_expired', daysRemaining: 0 });
		expect(http.postStub.called).toBe(false);
	});

	it('activates a paid license, including perpetual and expired variants', async () => {
		serverReturns(token({ tier: 'paid', expiresAt: now + 365 * DAY }));
		expect((await svc.activatePaid('KEY-1')).state).toBe('paid');
		expect(http.postStub.firstCall.args[1]).toEqual({ licenseKey: 'KEY-1' });

		store.value = { token: token({ tier: 'paid', expiresAt: null }), activatedAt: now };
		expect(svc.getStatus()).toMatchObject({ state: 'paid', daysRemaining: undefined });

		now += 366 * DAY;
		store.value = { token: token({ tier: 'paid', expiresAt: now - DAY }), activatedAt: now };
		expect(svc.getStatus().state).toBe('paid_expired');
	});

	it('converts a trial (even expired) to paid in place', async () => {
		serverReturns(token({}));
		await svc.activateTrial();
		now += 30 * DAY;
		expect(svc.getStatus().state).toBe('trial_expired');

		serverReturns(token({ licenseId: 'L2', tier: 'paid', expiresAt: now + 365 * DAY }));
		const status = await svc.activatePaid('KEY-2');
		expect(status).toMatchObject({ state: 'paid', licenseId: 'L2' });
	});

	it('does not let a paid license be overwritten by a trial token', () => {
		svc.applyToken(token({ tier: 'paid', expiresAt: now + DAY }));
		expect(() => svc.applyToken(token({}))).toThrow(/paid/);
		expect(svc.getStatus().state).toBe('paid');
	});

	it('rejects bad signatures, other agents, wrong tier, and surfaces tampered stored tokens', async () => {
		expect(() => svc.applyToken(token({}, other.priv))).toThrow(/signature/i);
		expect(() => svc.applyToken(token({ agentUuid: 'someone-else' }))).toThrow(/different agent/);
		serverReturns(token({}));
		await expect(svc.activatePaid('K')).rejects.toThrow(/Expected a paid/);

		store.value = { token: token({}, other.priv), activatedAt: now };
		expect(svc.getStatus()).toMatchObject({ state: 'unlicensed', invalidReason: expect.any(String) });
	});

	it('propagates backend errors without changing state', async () => {
		http.postStub.resolves({ ok: false, status: 403, statusText: 'Forbidden', json: async () => ({ message: 'no' }) });
		await expect(svc.activatePaid('K')).rejects.toThrow(/403/);
		expect(svc.getStatus().state).toBe('unlicensed');
	});

	describe('standalone (unprovisioned) agent', () => {
		const standalone = {
			uuid: 'agent-1',
			licenseApiEndpoint: 'http://lic.test',
			popPublicKey: 'PEM-PUBLIC',
			popSign: jest.fn((c: string, u: string) => `sig(${u}:${c})`),
		};

		it('authenticates with PoP headers against the license server', async () => {
			svc = new LicenseService(store, http, vendor.pub, () => standalone, undefined, () => now);
			serverReturns(token({}));
			expect((await svc.activateTrial()).state).toBe('trial');
			const [url, , opts] = http.postStub.firstCall.args;
			expect(url).toBe('http://lic.test/api/v1/agent/agent-1/license/trial');
			expect(opts.headers['x-agent-key']).toBeUndefined();
			expect(opts.headers['x-agent-timestamp']).toBe(String(now));
			expect(opts.headers['x-agent-signature']).toBe(`sig(agent-1:license:license/trial:${now})`);
			expect(Buffer.from(opts.headers['x-agent-public-key'], 'base64url').toString()).toBe('PEM-PUBLIC');
		});

		it('fails clearly without a license server or identity', async () => {
			svc = new LicenseService(store, http, vendor.pub, () => ({ uuid: 'agent-1' }), undefined, () => now);
			await expect(svc.activateTrial()).rejects.toThrow(/LICENSE_API/);
			svc = new LicenseService(store, http, vendor.pub, () => ({ uuid: 'agent-1', licenseApiEndpoint: 'http://x' }), undefined, () => now);
			await expect(svc.activateTrial()).rejects.toThrow(/PoP/);
		});
	});

	describe('bootstrapLicense', () => {
		const flush = () => new Promise((r) => setImmediate(r));

		it('auto-starts a trial when unlicensed', async () => {
			serverReturns(token({}));
			const stop = bootstrapLicense(svc, { autoTrial: true });
			await flush();
			stop();
			expect(svc.getStatus().state).toBe('trial');
		});

		it('does nothing when auto-trial is disabled or a license exists', async () => {
			bootstrapLicense(svc, { autoTrial: false })();
			await flush();
			expect(http.postStub.called).toBe(false);

			store.value = { token: token({ tier: 'paid', expiresAt: null }), activatedAt: now };
			bootstrapLicense(svc, { autoTrial: true })();
			await flush();
			expect(http.postStub.called).toBe(false);
		});

		it('uses LICENSE_KEY to convert an existing trial to paid', async () => {
			store.value = { token: token({}), activatedAt: now };
			serverReturns(token({ tier: 'paid', expiresAt: now + DAY }));
			bootstrapLicense(svc, { autoTrial: true, licenseKey: 'KEY' })();
			await flush();
			expect(svc.getStatus().state).toBe('paid');
			expect(http.postStub.firstCall.args[0]).toContain('license/activate');
		});

		it('is non-fatal offline and retries later', async () => {
			http.postStub.onFirstCall().rejects(new Error('offline'));
			serverReturns(token({}));
			http.postStub.onFirstCall().rejects(new Error('offline'));
			const stop = bootstrapLicense(svc, { autoTrial: true, retryIntervalMs: 10 });
			await flush();
			expect(svc.getStatus().state).toBe('unlicensed');
			await new Promise((r) => setTimeout(r, 50));
			stop();
			expect(svc.getStatus().state).toBe('trial');
		});
	});
});
