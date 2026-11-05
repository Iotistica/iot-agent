const crypto = require('crypto');

// Must match agent src/licensing/token.ts: base64url(payload JSON) + '.' + base64url(Ed25519 sig).
function signLicensePayload(payload, privateKeyPem) {
	const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
	const sig = crypto.sign(null, Buffer.from(body, 'utf8'), crypto.createPrivateKey(privateKeyPem));
	return `${body}.${sig.toString('base64url')}`;
}

module.exports = { signLicensePayload };
