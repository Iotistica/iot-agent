import type { AgentInitContext } from '../init/context.js';
import { createHttpClient } from '../lib/http-client.js';
import { LogComponents } from '../logging/types.js';
import { bootstrapLicense } from './bootstrap';
import { getLicensePublicKey } from './public-key';
import { LicenseService } from './service';
import { SqliteLicenseStore } from './store';

let instance: LicenseService | undefined;

export function getLicenseService(): LicenseService | undefined {
	return instance;
}

function envEnabled(value: string | undefined, defaultValue: boolean): boolean {
	if (value === undefined || value.trim() === '') return defaultValue;
	return !['false', '0', 'no', 'off'].includes(value.trim().toLowerCase());
}

/** Builds the LicenseService for this agent and kicks off the non-blocking bootstrap. */
export function initLicensing(ctx: AgentInitContext): LicenseService {
	// No default server: licensing stays inert until LICENSE_API is set.
	const licenseApi = process.env.LICENSE_API?.trim() || undefined;
	const publicKey = getLicensePublicKey();

	const service = new LicenseService(
		new SqliteLicenseStore(),
		createHttpClient(licenseApi ?? 'http://localhost'),
		publicKey,
		() => {
			const info = ctx.agentManager!.getAgentInfo();
			const pop = ctx.agentManager!.getPopCrypto();
			return {
				uuid: info.uuid,
				apiKey: info.provisioned ? info.apiKey : undefined,
				apiEndpoint: info.provisioned ? info.apiEndpoint : undefined,
				licenseApiEndpoint: licenseApi,
				popPublicKey: pop?.isEnabled() ? pop.getPublicKey() : undefined,
				popSign: pop?.isEnabled() ? (c, u) => pop.signChallenge(c, u) : undefined,
			};
		},
		ctx.agentLogger,
	);

	instance = service;
	ctx.licenseService = service;

	if (!licenseApi || !publicKey) {
		ctx.agentLogger?.infoSync('Licensing not configured; skipping automatic activation', {
			component: LogComponents.agentManager,
			operation: 'license-init',
			hasLicenseApi: !!licenseApi,
			hasPublicKey: !!publicKey,
		});
		return service;
	}

	bootstrapLicense(
		service,
		{
			autoTrial: envEnabled(process.env.LICENSE_AUTO_TRIAL, true),
			licenseKey: process.env.LICENSE_KEY?.trim() || undefined,
		},
		ctx.agentLogger,
	);
	return service;
}
