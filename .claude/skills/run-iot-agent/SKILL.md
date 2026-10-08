---
name: run-iot-agent
description: Build, run, and drive iot-agent. Use when asked to start iot-agent, deploy it, run its tests, verify the admin UI, or interact with the running container.
---

Dockerized Node.js IoT device agent with a Vue 3 admin panel. Drive it
via `curl` against the API (port 48481) and `docker exec` for the CLI.
The smoke script at `.claude/skills/run-iot-agent/smoke.sh` exercises the
full build-deploy-verify cycle.

## Prerequisites

- Docker Desktop with `docker compose` v2
- `curl` available in the shell
- The `iotistica-net` Docker network must exist:

```bash
docker network create iotistica-net 2>/dev/null || true
```

## Build

```bash
docker compose build agent
```

Takes 2-5 minutes. Multi-stage: backend TypeScript, admin Vue SPA,
CLI (`iotctl`), then Alpine production image.

## Deploy

```bash
docker compose up -d agent
```

Container name: `iotistica-agent`. API on host port **48481** (mapped
from container port 48484). Healthcheck via `/ping` — wait for
`(healthy)` in `docker ps`.

**Important:** always use `up -d`, not `restart`. `restart` keeps the
old image and ignores a fresh build.

## Run (agent path)

### Full smoke test

```bash
bash .claude/skills/run-iot-agent/smoke.sh
```

Builds, deploys, waits for healthy, verifies ping, authenticates,
tests API endpoints, checks admin UI serves, runs CLI commands.

### Authenticate and call API

Default credentials: `admin` / `admin`.

```bash
SESSION=$(curl -sf -c - -X POST http://localhost:48481/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin"}' -m 5 \
  | grep admin_session | awk '{print $NF}')

# Authenticated GET
curl -sf -b "admin_session=$SESSION" http://localhost:48481/v1/settings -m 8

# Authenticated PATCH
curl -sf -b "admin_session=$SESSION" -X PATCH \
  http://localhost:48481/v1/schema-drift/config \
  -H "Content-Type: application/json" \
  -d '{"warmupBatches":25}' -m 8
```

### Key API endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/ping` | no | Health check — returns `OK` |
| POST | `/v1/auth/login` | no | Get session cookie |
| GET | `/v1/settings` | viewer | Agent settings |
| PATCH | `/v1/settings` | operator | Update settings |
| GET | `/v1/protocol-outputs` | viewer | Protocol pipe config + drift options |
| PATCH | `/v1/protocol-outputs/drift` | operator | Update drift options (all pipes) |
| GET | `/v1/schema-drift/config` | viewer | Effective drift config + sensitivity |
| PATCH | `/v1/schema-drift/config` | operator | Update drift config (flat body, strict validation) |
| POST | `/v1/schema-drift/config/reset-advanced` | operator | Reset 11 advanced fields to defaults |
| GET | `/v1/schema-drift/baselines` | viewer | Per-device schema baselines |
| GET | `/v1/anomaly/config` | viewer | Anomaly detection config |
| PATCH | `/v1/anomaly/config` | operator | Update anomaly config |

### CLI via docker exec

```bash
docker exec iotistica-agent iotctl status
docker exec iotistica-agent iotctl help
docker exec iotistica-agent iotctl config show
```

The CLI connects to `http://localhost:48484/v1` inside the container.
Commands that hit authenticated endpoints (e.g. `schema-drift get`)
return 401 — they work from the container's internal context only when
auth is not required for the endpoint, or when the CLI is extended
with a session mechanism.

### Admin UI

The admin panel is served at `http://localhost:48481/admin/`. It's a
Vue 3 SPA (Ant Design Vue). Key pages:

- `/admin/` — Dashboard
- `/admin/settings?tab=alerts` — Alerts config (anomaly + schema drift)
- `/admin/alerts` — Alert rules and baselines

### Type checking

```bash
npx tsc --noEmit                             # backend
cd admin && npx vue-tsc --noEmit && cd ..    # frontend
```

## Run (human path)

For local dev without Docker:

```bash
npm install
npm run dev          # tsx watch on src/app.ts — needs Node 24+
npm run dev:admin    # Vite dev server for admin UI (separate terminal)
```

## Test

```bash
npm test                # all tests (jest)
npm run test:unit       # unit tests only
npm run test:integration  # integration tests only
```

## Gotchas

- **`docker compose restart` vs `up -d`**: `restart` does NOT pick up a
  freshly built image. Always `docker compose up -d agent` after a build.
- **Global auth gate**: Every `/v1/*` route except `/v1/auth/*`,
  `/v1/provision/*`, and `/v1/device/*` requires an `admin_session`
  cookie. The CLI inside the container also hits this gate.
- **`iotistica-net` network**: The compose file expects an external Docker
  network called `iotistica-net`. Create it before first `up`.
- **DriftOptions type wrapping**: `DriftOptionsSchema` is wrapped in
  `.optional()`, so the inferred type is `{...} | undefined`. Use
  `NonNullable<DriftOptions>` when you need the inner type for `Pick`.
- **Curly apostrophes in Vue strings**: The codebase uses `’`
  (right single quote) for apostrophes inside single-quoted JS strings
  in Vue templates (e.g. `'wasn’t'`). A regular `'` breaks parsing.

## Troubleshooting

- **`docker network not found: iotistica-net`**: Run
  `docker network create iotistica-net` before `docker compose up`.
- **Container shows `(unhealthy)`**: Check logs with
  `docker logs iotistica-agent --tail 50`. Common cause: port 48484
  already in use inside the container, or a startup crash.
- **`HTTP 401: Not authenticated` from curl**: You need the session
  cookie. Login first via `POST /v1/auth/login` and pass the cookie
  with `-b "admin_session=<token>"`.
