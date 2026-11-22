## Unified Event System

All agent events flow through a single EventBus (`src/events/event-bus.ts`) with `submit()`. The bus writes to three SQLite tables: `agent_events` → `agent_incidents` (fingerprint-correlated) → `agent_alerts`. The old `anomaly_events`/`anomaly_incidents`/`anomaly_alerts` tables no longer exist.

### Event sources
`EventSource` = `anomaly | schema-drift | discovery | memory | adapter | auth | audit | system` (defined in `src/events/types.ts`). `AUDIT_SOURCES` (`audit`, `auth`) skip incident correlation — they produce events only.

### Convenience helper
`logEvent()` in `src/api/actions.ts` wraps `eventBus.submit()` for call sites that don't hold a bus reference. The bus is injected at startup via `setActionsEventBus()` in `src/init/features.ts`.

### API endpoints (`src/api/events.ts`)
- `GET /v1/events?source=&severity=&fingerprint=&from=&to=&limit=&offset=`
- `GET /v1/incidents?source=&status=&severity=&from=&to=&limit=&offset=`
- `GET /v1/incidents/stats?source=&windowHours=`
- `GET /v1/incidents/bad-actors?source=&windowDays=&limit=`
- `GET /v1/incidents/:id` — single incident with its alerts and recent events
- `PATCH /v1/incidents/:id/resolve` — requires `operator` role
- `GET /v1/alerts?source=&severity=&from=&to=&limit=&offset=`
- Backward-compatible aliases: `/v1/anomaly-events` → events filtered to `anomaly,schema-drift`

### Frontend
- **Alerts page** (`admin/src/views/AlertsView.vue`) — Events / Incidents / Alerts tabs with a source dropdown filter. Uses `admin/src/api/events.ts` and `admin/src/utils/eventSources.ts`.
- **Analytics page** (`admin/src/views/AnomalyView.vue`) — Baselines / Schema Drift / Anomaly Rules only (events/incidents/alerts moved out).

### Database / migrations
- Template: `src/db/sql/template.sqlite.sql` — 59 tables, all migrations squashed into a single initial schema (`src/db/migrations/20260312020000_squashed_initial_schema.ts`).
- `src/db/native-migrations.ts` references only the squashed migration. New migrations go after it.
- Dead tables removed from template: `enum_devices`, `enum_metrics`, `enum_observations`, `enum_quality_codes`, `mqtt_acls`.

---

## OPC UA Simulator (for load testing)

The simulator used for development and load testing lives at `C:\Users\Dan\iot-registry\sim\opcua\simulator.py` (Docker image). It's a standalone asyncua-based OPC UA server configured via env vars:

- `OPCUA_POINT_COUNT` — number of simulated tags (default 8, max 100,000)
- `OPCUA_PORT` — OPC UA listen port (default 4840)
- `TICK_INTERVAL_S` — value update interval in seconds (default 5.0)
- `UPDATE_BATCH_SIZE` — nodes updated per asyncio yield (default 250)
- `OPCUA_ENGINEERING_UNITS` — attach EU metadata to each tag (default true)
- `DEVICE_ID` — device folder name in the address space (default "opcua-001")

**Startup behavior:** The server creates all nodes *before* calling `server.start()`, so the TCP port isn't listening until node creation finishes. At 100K points this takes ~1 hour. Progress is logged every 5,000 nodes. The agent's reconnect loop is expected during this window.

---

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.
