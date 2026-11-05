const crypto = require('crypto');
const express = require('express');
const { popAuth } = require('./auth');
const { signLicensePayload } = require('./token');

const DAY_MS = 86_400_000;
const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

/**
 * @param {{ db, privateKeyPem: string, trialDays?: number, now?: () => number }} opts
 * Mounted at /api/v1 to match the agent's buildApiEndpoint().
 */
function createApp({ db, privateKeyPem, trialDays = 14, now = Date.now }) {
	const app = express();
	app.use(express.json());
	const auth = popAuth(db, now);
	const router = express.Router();

	router.post('/agent/:uuid/license/trial', auth('trial'), (req, res) => {
		const { uuid } = req.params;
		// Atomic: only one request can flip trial_used_at from NULL.
		const claimed = db
			.prepare('UPDATE agents SET trial_used_at = ? WHERE uuid = ? AND trial_used_at IS NULL')
			.run(now(), uuid);
		if (claimed.changes === 0) return res.status(409).json({ message: 'Trial already used' });

		const issuedAt = now();
		const token = signLicensePayload(
			{ licenseId: `trial-${uuid}`, agentUuid: uuid, tier: 'trial', issuedAt, expiresAt: issuedAt + trialDays * DAY_MS },
			privateKeyPem,
		);
		res.json({ token });
	});

	router.post('/agent/:uuid/license/activate', auth('activate'), (req, res) => {
		const { uuid } = req.params;
		const licenseKey = typeof req.body?.licenseKey === 'string' ? req.body.licenseKey.trim() : '';
		if (!licenseKey) return res.status(400).json({ message: 'licenseKey is required' });

		const row = db.prepare('SELECT * FROM license_keys WHERE key_hash = ?').get(hashKey(licenseKey));
		if (!row) return res.status(404).json({ message: 'Unknown license key' });
		if (row.revoked_at) return res.status(403).json({ message: 'License key revoked' });
		if (row.agent_uuid && row.agent_uuid !== uuid) {
			return res.status(409).json({ message: 'License key bound to another agent' });
		}
		// Expiry is enforced by the signed token, but refuse to issue already-expired licenses.
		if (row.expires_at !== null && row.expires_at <= now()) {
			return res.status(403).json({ message: 'License key expired' });
		}

		// Conditional bind keeps concurrent first activations from different agents safe.
		db.prepare('UPDATE license_keys SET agent_uuid = ? WHERE key_hash = ? AND (agent_uuid IS NULL OR agent_uuid = ?)')
			.run(uuid, row.key_hash, uuid);
		const bound = db.prepare('SELECT agent_uuid FROM license_keys WHERE key_hash = ?').get(row.key_hash);
		if (bound.agent_uuid !== uuid) return res.status(409).json({ message: 'License key bound to another agent' });

		const token = signLicensePayload(
			{
				licenseId: row.license_id,
				agentUuid: uuid,
				tier: 'paid',
				issuedAt: now(),
				expiresAt: row.expires_at,
				...(row.features ? { features: JSON.parse(row.features) } : {}),
			},
			privateKeyPem,
		);
		res.json({ token });
	});

	app.use('/api/v1', router);
	return app;
}

module.exports = { createApp, hashKey };
