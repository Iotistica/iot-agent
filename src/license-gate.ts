import { getLicenseService } from './licensing/runtime.js';

const PRO_STATES = new Set(['trial', 'paid']);

export function isProLicensed(): boolean {
	if (process.env.PRO_FORCE === 'true') return true;
	const svc = getLicenseService();
	if (!svc) return false;
	return PRO_STATES.has(svc.getStatus().state);
}
