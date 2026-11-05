// Generates the vendor Ed25519 keypair. Keep the private key secret; embed the
// public key in the agent (src/licensing/public-key.ts).
const crypto = require('crypto');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
console.log('# LICENSE_PRIVATE_KEY (server secret)\n' + privateKey.export({ type: 'pkcs8', format: 'pem' }));
console.log('# Public key (agent)\n' + publicKey.export({ type: 'spki', format: 'pem' }));
