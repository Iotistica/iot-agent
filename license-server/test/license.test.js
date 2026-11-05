const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { openDb } = require('../src/db');
const { createApp, hashKey } = require('../src/app');

const DAY = 86_400_000;
const pem = (k, type) => k.export({ type, format: 'pem' });
const vendor = crypto.generateKeyPairSync('ed25519');
const vendorPriv = pem(vendor.privateKey, 'pkcs8');

function agentIdentity() {
	const kp = crypto.generateKeyPairSync('ed25519');
	return { pub: pem(kp.publicKey, 'spki'), priv: kp.privateKey };
}

// Mirrors the agent's LicenseService.buildAuth()
function headers(id, uuid, action, ts) {
	const sig = crypto.sign(null, Buffer.from(`${uuid}:license:license/${action}:${ts}`), id.priv).toString('base64');
	return {
		'content-type': 'application/json',
		'x-agent-public-key': Buffer.from(id.pub).toString('base64url'),
		'x-agent-timestamp': String(ts),
		'x-agent-signature': sig,
	};
}

function decode(token) {
	const [body, sig] = token.split('.');
	assert.ok(crypto.verify(null, Buffer.from(body), vendor.publicKey, Buffer.from(sig, 'base64url')), 'vendor signature');
	return JSON.parse(Buffer.from(body, 'base64url').toString());
}

async function setup(t) {
	let now = 1_800_000_000_000;
	const db = openDb();
	const app = createApp({ db, privateKeyPem: vendorPriv, now: () => now });
	const server = app.listen(0);
	t.after(() => server.close());
	const base = `http://127.0.0.1:${server.address().port}/api/v1`;
	const call = async (uuid, action, id, body = {}, ts = now) => {
		const res = await fetch(`${base}/agent/${uuid}/license/${action}`, {
			method: 'POST',
			headers: headers(id, uuid, action, ts),
			body: JSON.stringify(body),
		});
		return { status: res.status, body: await res.json() };
	};
	return { db, url: base, call, advance: (ms) => (now += ms), now: () => now };
}

test('trial: issues a signed 14-day token bound to the agent', async (t) => {
	const { call, now } = await setup(t);
	const id = agentIdentity();
	const r = await call('a1', 'trial', id);
	assert.strictEqual(r.status, 200);
	const p = decode(r.body.token);
	assert.deepStrictEqual(
		{ tier: p.tier, agentUuid: p.agentUuid, expiresAt: p.expiresAt },
		{ tier: 'trial', agentUuid: 'a1', expiresAt: now() + 14 * DAY },
	);
});

test('trial: only once per agent', async (t) => {
	const { call } = await setup(t);
	const id = agentIdentity();
	assert.strictEqual((await call('a1', 'trial', id)).status, 200);
	assert.strictEqual((await call('a1', 'trial', id)).status, 409);
});

test('auth: rejects missing headers, bad signature, stale timestamp and key swap', async (t) => {
	const { call, now } = await setup(t);
	const id = agentIdentity();
	assert.strictEqual((await call('a1', 'trial', id, {}, now() - 10 * 60_000)).status, 401);

	// signature made by a different key than the one presented
	const impostor = { pub: id.pub, priv: agentIdentity().priv };
	assert.strictEqual((await call('a1', 'trial', impostor)).status, 401);

	assert.strictEqual((await call('a1', 'trial', id)).status, 200);
	assert.strictEqual((await call('a1', 'trial', agentIdentity())).status, 403);
});

test('auth: rejects requests without PoP headers', async (t) => {
	const { url } = await setup(t);
	const res = await fetch(`${url}/agent/a1/license/trial`, { method: 'POST' });
	assert.strictEqual(res.status, 401);
});

test('paid: activates a key, binds it, and rejects other agents / revoked / unknown', async (t) => {
	const { call, db, now } = await setup(t);
	db.prepare('INSERT INTO license_keys (key_hash, license_id, expires_at) VALUES (?, ?, ?)')
		.run(hashKey('KEY-1'), 'L-1', now() + 365 * DAY);
	db.prepare('INSERT INTO license_keys (key_hash, license_id, expires_at, revoked_at) VALUES (?, ?, NULL, ?)')
		.run(hashKey('KEY-REV'), 'L-2', now());
	const a = agentIdentity();
	const b = agentIdentity();

	const ok = await call('a1', 'activate', a, { licenseKey: 'KEY-1' });
	assert.strictEqual(ok.status, 200);
	assert.deepStrictEqual(
		{ tier: decode(ok.body.token).tier, licenseId: decode(ok.body.token).licenseId },
		{ tier: 'paid', licenseId: 'L-1' },
	);
	assert.strictEqual((await call('a1', 'activate', a, { licenseKey: 'KEY-1' })).status, 200); // idempotent
	assert.strictEqual((await call('b1', 'activate', b, { licenseKey: 'KEY-1' })).status, 409);
	assert.strictEqual((await call('a1', 'activate', a, { licenseKey: 'KEY-REV' })).status, 403);
	assert.strictEqual((await call('a1', 'activate', a, { licenseKey: 'nope' })).status, 404);
	assert.strictEqual((await call('a1', 'activate', a, {})).status, 400);
});

test('conversion: an agent that used its trial can still activate paid', async (t) => {
	const { call, db, now } = await setup(t);
	db.prepare('INSERT INTO license_keys (key_hash, license_id, expires_at) VALUES (?, ?, NULL)').run(hashKey('K'), 'L-3');
	const id = agentIdentity();
	assert.strictEqual((await call('a1', 'trial', id)).status, 200);
	const r = await call('a1', 'activate', id, { licenseKey: 'K' });
	assert.strictEqual(r.status, 200);
	assert.strictEqual(decode(r.body.token).expiresAt, null);
	void now;
});
