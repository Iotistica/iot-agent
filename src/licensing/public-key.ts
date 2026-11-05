/**
 * Vendor Ed25519 public key (SPKI PEM) used to verify license tokens.
 * Must be filled in at release time. While empty, the LICENSE_PUBLIC_KEY env
 * var is used as a fallback (dev/test); once embedded, the env var is ignored
 * so it cannot be swapped out through agent.env.
 */
export const EMBEDDED_LICENSE_PUBLIC_KEY = '';

export function getLicensePublicKey(): string | undefined {
	if (EMBEDDED_LICENSE_PUBLIC_KEY) return EMBEDDED_LICENSE_PUBLIC_KEY;
	return process.env.LICENSE_PUBLIC_KEY?.replace(/\\n/g, '\n') || undefined;
}
