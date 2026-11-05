// Usage: node src/add-key.js <licenseId> [expiresAtISO|never]
// Prints the plaintext license key once; only its hash is stored.
const crypto = require('crypto');
const { openDb } = require('./db');
const { hashKey } = require('./app');

const [licenseId, expires = 'never'] = process.argv.slice(2);
if (!licenseId) {
	console.error('Usage: node src/add-key.js <licenseId> [expiresAtISO|never]');
	process.exit(1);
}
const expiresAt = expires === 'never' ? null : Date.parse(expires);
if (expiresAt !== null && !Number.isFinite(expiresAt)) {
	console.error('Invalid expiry date');
	process.exit(1);
}
const key = `IOT-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
openDb(process.env.DB_PATH || './license.sqlite')
	.prepare('INSERT INTO license_keys (key_hash, license_id, expires_at) VALUES (?, ?, ?)')
	.run(hashKey(key), licenseId, expiresAt);
console.log(key);
