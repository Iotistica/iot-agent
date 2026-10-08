#!/usr/bin/env bash
# smoke.sh — build, deploy, and verify the iot-agent container
# Run from the repo root: bash .claude/skills/run-iot-agent/smoke.sh
# Exits 0 if healthy, 1 on failure.
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$COMPOSE_DIR"

CONTAINER=iotistica-agent
API=http://localhost:48481
SESSION_COOKIE=""

step() { echo ""; echo "==> $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

# ── Build ──────────────────────────────────────────────────────────────
step "Building Docker image"
docker compose build agent 2>&1 | tail -3

# ── Deploy ─────────────────────────────────────────────────────────────
step "Deploying container"
docker compose up -d agent 2>&1

# ── Wait for healthy ───────────────────────────────────────────────────
step "Waiting for container health (up to 30s)"
for i in $(seq 1 15); do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo "missing")
  [ "$STATUS" = "healthy" ] && break
  sleep 2
done
[ "$STATUS" = "healthy" ] || fail "Container not healthy after 30s (status: $STATUS)"
echo "Container healthy"

# ── Ping ───────────────────────────────────────────────────────────────
step "API ping"
PING=$(curl -sf "$API/ping" -m 5) || fail "Ping failed"
[ "$PING" = "OK" ] || fail "Unexpected ping response: $PING"
echo "OK"

# ── Auth ───────────────────────────────────────────────────────────────
step "Authenticating (admin/admin)"
LOGIN=$(curl -sf -c - -X POST "$API/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin"}' -m 5) \
  || fail "Login failed"
SESSION_COOKIE=$(echo "$LOGIN" | grep admin_session | awk '{print $NF}')
[ -n "$SESSION_COOKIE" ] || fail "No session cookie returned"
echo "Authenticated"

auth() { curl -sf -b "admin_session=$SESSION_COOKIE" "$@" -m 8; }

# ── Settings API ───────────────────────────────────────────────────────
step "GET /v1/settings"
auth "$API/v1/settings" | head -c 120
echo "..."

# ── Schema drift config ───────────────────────────────────────────────
step "GET /v1/schema-drift/config"
DRIFT=$(auth "$API/v1/schema-drift/config") || fail "Schema drift config GET failed"
echo "$DRIFT"

# ── Protocol outputs ──────────────────────────────────────────────────
step "GET /v1/protocol-outputs"
auth "$API/v1/protocol-outputs" | head -c 200
echo "..."

# ── Admin UI serves ───────────────────────────────────────────────────
step "Admin UI (HTML title)"
ADMIN_HTML=$(curl -sf "$API/admin/" -m 5) || fail "Admin UI not served"
echo "$ADMIN_HTML" | grep -o '<title>[^<]*</title>' || echo "(no title tag found)"

# ── CLI ────────────────────────────────────────────────────────────────
step "iotctl version"
docker exec "$CONTAINER" iotctl version 2>&1 || true

step "iotctl status"
docker exec "$CONTAINER" iotctl status 2>&1 | head -3

# ── Done ───────────────────────────────────────────────────────────────
step "All smoke checks passed"
