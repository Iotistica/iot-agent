# license-server

Minimal Node.js license activation API for the Iotistica agent. Implements the endpoints
the agent calls (see `src/licensing/service.ts` in the agent):

- `POST /api/v1/agent/:uuid/license/trial` – one 14-day trial per agent uuid (`409` if used).
- `POST /api/v1/agent/:uuid/license/activate` – body `{ "licenseKey" }`; binds the key to the agent and returns a paid token. Also converts a trial; idempotent for the same agent.

Both return `{ "token" }` (Ed25519-signed, format matches the agent's `token.ts`).

**Auth (standalone agents, PoP):** headers `x-agent-public-key` (base64url PEM), `x-agent-timestamp`
(±5 min), `x-agent-signature` (base64 Ed25519 over `<uuid>:license:license/<action>:<timestamp>`).
First verified request registers the key for the uuid (trust-on-first-use); a different key later gets `403`.
The provisioned-agent `x-agent-key` path is not implemented yet.

## Run
```
npm install
npm run gen-keys                      # keep private key secret; embed public key in the agent
LICENSE_PRIVATE_KEY="$(cat priv.pem)" npm start   # PORT (3003), DB_PATH, TRIAL_DAYS (14)
node src/add-key.js L-001 2027-12-31  # or "never"; prints the key once, stores only its hash
npm test
```
Agent side: `LICENSE_API=http://host:3003` and the public key in `src/licensing/public-key.ts`.

## Before production
Rate-limit `/activate`, run behind TLS, back up the SQLite file (or move to Postgres), add admin
tooling for revoke/list, and replace TOFU with an enrollment check if needed.
