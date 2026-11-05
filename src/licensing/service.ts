import type { HttpClient } from '../lib/http-client.js';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import { buildApiEndpoint } from '../utils/api-utils';
import { LicenseTokenError, verifyLicenseToken } from './token';
import type {
	LicensePayload,
	LicenseServerResponse,
	LicenseState,
	LicenseStatus,
	LicenseStore,
} from './types';

const DAY_MS = 86_400_000;

export interface LicenseAgentContext {
	uuid: string;
	/** Present only on cloud-provisioned agents. */
	apiKey?: string;
	apiEndpoint?: string;
	/** License server base URL used by standalone (unprovisioned) agents. */
	licenseApiEndpoint?: string;
	/** PoP identity available on every agent, provisioned or not. */
	popPublicKey?: string;
	popSign?: (challenge: string, uuid: string) => string;
}

/**
 * Licensing is independent of provisioning: it only reuses the agent's
 * identity (uuid + apiKey) to talk to the backend, and never touches agent config.
 *
 * Required backend endpoints (NOT yet implemented server-side):
 *   POST /agent/:uuid/license/trial     body {}                -> { token }
 *   POST /agent/:uuid/license/activate  body { licenseKey }    -> { token }
 * Provisioned agents authenticate with `x-agent-key` against their apiEndpoint.
 * Standalone agents authenticate with their PoP Ed25519 key against
 * licenseApiEndpoint (see buildAuth). Tokens are Ed25519-signed (token.ts) and
 * bound to the agent uuid.
 */
export class LicenseService {
	constructor(
		private readonly store: LicenseStore,
		private readonly httpClient: HttpClient,
		private readonly publicKeyPem: string | undefined,
		private readonly getAgent: () => LicenseAgentContext,
		private readonly logger?: AgentLogger,
		private readonly now: () => number = Date.now,
	) {}

	/** Local-only evaluation: no network access, safe to call at every startup. */
	getStatus(): LicenseStatus {
		const stored = this.store.load();
		if (!stored) return { state: 'unlicensed' };

		let payload: LicensePayload;
		try {
			if (!this.publicKeyPem) throw new LicenseTokenError('No license public key configured');
			payload = verifyLicenseToken(stored.token, this.publicKeyPem);
			if (payload.agentUuid !== this.getAgent().uuid) {
				throw new LicenseTokenError('License belongs to a different agent');
			}
		} catch (error) {
			return {
				state: 'unlicensed',
				invalidReason: error instanceof Error ? error.message : String(error),
			};
		}

		const perpetual = payload.expiresAt === null;
		const expired = !perpetual && this.now() >= (payload.expiresAt as number);
		const state: LicenseState =
			payload.tier === 'trial'
				? expired ? 'trial_expired' : 'trial'
				: expired ? 'paid_expired' : 'paid';

		return {
			state,
			tier: payload.tier,
			licenseId: payload.licenseId,
			expiresAt: payload.expiresAt,
			daysRemaining: perpetual
				? undefined
				: Math.max(0, Math.ceil(((payload.expiresAt as number) - this.now()) / DAY_MS)),
		};
	}

	/** Requests a trial for this agent. Refused locally if any license already exists. */
	async activateTrial(): Promise<LicenseStatus> {
		if (this.store.load()) {
			throw new Error('A license is already present on this agent; trial cannot be re-activated');
		}
		return this.requestAndStore('license/trial', {});
	}

	hasStoredLicense(): boolean {
		return this.store.load() !== null;
	}

	/**
	 * Activates a paid license. Also converts an existing trial (active or
	 * expired) in place: only the stored token changes, so agent identity,
	 * registration and configuration are untouched.
	 */
	async activatePaid(licenseKey: string): Promise<LicenseStatus> {
		if (!licenseKey?.trim()) throw new Error('licenseKey is required');
		return this.requestAndStore('license/activate', { licenseKey: licenseKey.trim() }, 'paid');
	}

	/** Installs a signed token obtained out-of-band (air-gapped activation). */
	applyToken(token: string, expectedTier?: 'paid'): LicenseStatus {
		if (!this.publicKeyPem) throw new Error('No license public key configured');
		const payload = verifyLicenseToken(token, this.publicKeyPem);
		if (payload.agentUuid !== this.getAgent().uuid) {
			throw new Error('License belongs to a different agent');
		}
		if (expectedTier && payload.tier !== expectedTier) {
			throw new Error(`Expected a ${expectedTier} license but received ${payload.tier}`);
		}
		const current = this.getStatus();
		if (payload.tier === 'trial' && current.tier === 'paid') {
			throw new Error('Cannot replace a paid license with a trial');
		}
		this.store.save({ token, activatedAt: this.now() });
		this.logger?.infoSync('License activated', {
			component: LogComponents.agentManager,
			operation: 'license',
			tier: payload.tier,
			licenseId: payload.licenseId,
			previousState: current.state,
		});
		return this.getStatus();
	}

	private async requestAndStore(
		path: string,
		body: Record<string, unknown>,
		expectedTier?: 'paid',
	): Promise<LicenseStatus> {
		const agent = this.getAgent();
		const { baseUrl, headers } = this.buildAuth(agent, path);

		const url = buildApiEndpoint(baseUrl, `/agent/${agent.uuid}/${path}`);
		const response = await this.httpClient.post<LicenseServerResponse>(url, body, { headers });
		if (!response.ok) {
			const err = await response.json().catch(() => ({ message: response.statusText }));
			throw new Error(`License request failed ${response.status}: ${JSON.stringify(err)}`);
		}
		const { token } = await response.json();
		return this.applyToken(token, expectedTier);
	}

	private buildAuth(agent: LicenseAgentContext, path: string): { baseUrl: string; headers: Record<string, string> } {
		if (agent.apiKey && agent.apiEndpoint) {
			return { baseUrl: agent.apiEndpoint, headers: { 'x-agent-key': agent.apiKey } };
		}
		if (!agent.licenseApiEndpoint) {
			throw new Error('No license server configured (set LICENSE_API)');
		}
		if (!agent.popSign || !agent.popPublicKey) {
			throw new Error('Agent identity (PoP key) is not available');
		}
		// Signed message is `${uuid}:license:${path}:${timestamp}`; the server verifies it
		// with the public key (trust-on-first-use) and rejects stale timestamps.
		const timestamp = String(this.now());
		const signature = agent.popSign(`license:${path}:${timestamp}`, agent.uuid);
		return {
			baseUrl: agent.licenseApiEndpoint,
			headers: {
				'x-agent-public-key': Buffer.from(agent.popPublicKey, 'utf8').toString('base64url'),
				'x-agent-timestamp': timestamp,
				'x-agent-signature': signature,
			},
		};
	}
}
