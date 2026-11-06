export type LicenseTier = 'trial' | 'paid';

export type LicenseState =
	| 'unlicensed'
	| 'trial'
	| 'trial_expired'
	| 'paid'
	| 'paid_expired';

/** Claims inside a signed license token. Timestamps are epoch milliseconds. */
export interface LicensePayload {
	licenseId: string;
	agentUuid: string;
	tier: LicenseTier;
	issuedAt: number;
	/** null = perpetual (paid only) */
	expiresAt: number | null;
	features?: string[];
}

export interface LicenseStatus {
	state: LicenseState;
	tier?: LicenseTier;
	licenseId?: string;
	expiresAt?: number | null;
	/** Whole days left; undefined when unlicensed or perpetual. Never negative. */
	daysRemaining?: number;
	/** Set when a stored token exists but was rejected (bad signature, wrong agent...). */
	invalidReason?: string;
}

export interface StoredLicense {
	token: string;
	activatedAt: number;
}

/** Persistence for the single signed license token of this agent. */
export interface LicenseStore {
	load(): StoredLicense | null;
	save(license: StoredLicense): void;
	clear(): void;
}

export interface LicenseServerResponse {
	/** Signed token: base64url(payload JSON) + '.' + base64url(Ed25519 signature) */
	token: string;
}

export interface SignedLicensePayload {
	version: 1;
	licenseId: string;
	agentUuid: string;
	type: 'trial' | 'paid';
	issuedAt: string;
	expiresAt: string;
	features: string[];
}

export interface SignedLicense {
	payload: SignedLicensePayload;
	signature: string;
}
