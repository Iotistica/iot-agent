const crypto = require('crypto');

const MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * Verifies the agent's PoP headers:
 *   x-agent-public-key  base64url(PEM)
 *   x-agent-timestamp   epoch ms
 *   x-agent-signature   base64 Ed25519 over `${uuid}:license:${path}:${timestamp}`
 * Trust-on-first-use: the first verified request registers the public key for the uuid;
 * later requests must use the same key.
 */
function popAuth(db, now = Date.now) {
	return (action) => (req, res, next) => {
		const { uuid } = req.params;
		const keyB64 = req.get('x-agent-public-key');
		const ts = req.get('x-agent-timestamp');
		const sig = req.get('x-agent-signature');
		if (!keyB64 || !ts || !sig) return res.status(401).json({ message: 'Missing PoP headers' });

		const tsNum = Number(ts);
		if (!Number.isFinite(tsNum) || Math.abs(now() - tsNum) > MAX_SKEW_MS) {
			return res.status(401).json({ message: 'Stale or invalid timestamp' });
		}

		const publicKeyPem = Buffer.from(keyB64, 'base64url').toString('utf8');
		let valid = false;
		try {
			valid = crypto.verify(
				null,
				Buffer.from(`${uuid}:license:license/${action}:${ts}`, 'utf8'),
				crypto.createPublicKey(publicKeyPem),
				Buffer.from(sig, 'base64'),
			);
		} catch {
			valid = false;
		}
		if (!valid) return res.status(401).json({ message: 'Invalid signature' });

		const row = db.prepare('SELECT public_key FROM agents WHERE uuid = ?').get(uuid);
		if (!row) {
			db.prepare('INSERT INTO agents (uuid, public_key, created_at) VALUES (?, ?, ?)').run(uuid, publicKeyPem, now());
		} else if (row.public_key !== publicKeyPem) {
			return res.status(403).json({ message: 'Public key does not match registered agent' });
		}
		next();
	};
}

module.exports = { popAuth };
