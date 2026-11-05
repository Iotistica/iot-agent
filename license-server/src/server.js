const { openDb } = require('./db');
const { createApp } = require('./app');

const privateKeyPem = process.env.LICENSE_PRIVATE_KEY?.replace(/\\n/g, '\n');
if (!privateKeyPem) {
	console.error('LICENSE_PRIVATE_KEY is required (see: npm run gen-keys)');
	process.exit(1);
}

const app = createApp({
	db: openDb(process.env.DB_PATH || './license.sqlite'),
	privateKeyPem,
	trialDays: Number(process.env.TRIAL_DAYS || 14),
});
const port = Number(process.env.PORT || 3003);
app.listen(port, () => console.log(`license-server listening on :${port}`));
