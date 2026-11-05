import type { AgentInitContext } from '../init/context.js';
import { createHttpClient } from '../lib/http-client.js';
import { bootstrapLicense } from './bootstrap';
import { getLicensePublicKey } from './public-key';
import { LicenseService } from './service';
import { SqliteLicenseStore } from './store';

const DEFAULT_LICENSE_API = 'https://api.iotistica.com';

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
	const licenseApi = process.env.LICENSE_API?.trim() || DEFAULT_LICENSE_API;

	const service = new LicenseService(
		new SqliteLicenseStore(),
		createHttpClient(licenseApi),
		getLicensePublicKey(),
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
