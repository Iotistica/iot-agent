import * as crypto from 'crypto';
import type { LicensePayload } from './types';

export class LicenseTokenError extends Error {}

const b64u = (buf: Buffer): string => buf.toString('base64url');

/** Verifies an Ed25519-signed token and returns its payload. Throws LicenseTokenError. */
export function verifyLicenseToken(token: string, publicKeyPem: string): LicensePayload {
	const parts = typeof token === 'string' ? token.split('.') : [];
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		throw new LicenseTokenError('Malformed license token');
	}
	const [body, sig] = parts;

	let ok = false;
	try {
		ok = crypto.verify(
			null,
			Buffer.from(body, 'utf8'),
			crypto.createPublicKey(publicKeyPem),
			Buffer.from(sig, 'base64url'),
		);
	} catch {
		throw new LicenseTokenError('License signature could not be verified');
	}
	if (!ok) throw new LicenseTokenError('Invalid license signature');

	let payload: LicensePayload;
	try {
		payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
	} catch {
		throw new LicenseTokenError('Malformed license payload');
	}

	const validExpiry =
		payload.expiresAt === null ||
		(typeof payload.expiresAt === 'number' && Number.isFinite(payload.expiresAt));
	if (
		!payload ||
		typeof payload.licenseId !== 'string' ||
		typeof payload.agentUuid !== 'string' ||
		(payload.tier !== 'trial' && payload.tier !== 'paid') ||
		typeof payload.issuedAt !== 'number' ||
		!validExpiry ||
		(payload.tier === 'trial' && payload.expiresAt === null)
	) {
		throw new LicenseTokenError('Invalid license payload');
	}
	return payload;
}

/** Signs a payload. Server-side/test helper; the agent never holds the private key. */
export function signLicensePayload(payload: LicensePayload, privateKeyPem: string): string {
	const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
	const sig = crypto.sign(null, Buffer.from(body, 'utf8'), crypto.createPrivateKey(privateKeyPem));
	return `${body}.${b64u(sig)}`;
}
