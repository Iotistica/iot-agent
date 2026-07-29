# Preventive Maintenance & Energy Recommendations — Implementation Plan

Status: **All four phases implemented.** Asset registry; maintenance/energy schema; Pro-only rule
evaluators, debounce, and tick service in `iot-agent-pro/src/maintenance/`; live data-flow wiring
through `AnomalyFeed`; admin UI (`MaintenanceView.vue`/`EnergyView.vue` — rules, recommendations,
alert routing); and publishing (per-module MQTT/cloud alert routing, reusing the same
`publish_destinations` table and `ExternalMqttClient` infrastructure anomaly alerts already use).
This document still captures the architecture decisions behind those choices, kept for reference.

## Goal

Add two new advisory modules to the agent:

- **Preventive maintenance** — recommend service/inspection actions based on equipment usage
  (runtime hours, cycle counts, sustained threshold conditions).
- **Energy recommendations** — flag energy-inefficient patterns (standby waste, schedule
  mismatches, poor duty cycles) and suggest fixes.

Both are advisory (they produce recommendations for a human to act on) — not autonomous control.
Closing the loop into automatic corrective action is an explicit non-goal for this plan; see
[Deferred / v2 ideas](#deferred--v2-ideas).

## Key architecture decisions

### 1. Separate from anomaly detection, not a shared "Insights" schema

Considered generalizing `anomaly_events`/`anomaly_incidents`/`anomaly_alerts` into a shared
schema with a `module` discriminator. Rejected because the shapes don't actually match:

- An **anomaly** is a stream of repeated discrete readings that need incident-grouping to avoid
  alert spam — that's the whole reason the event → incident → alert three-tier model exists.
- A **maintenance recommendation** is a standing record per device + component that gets
  *re-evaluated and updated* over time ("service due in 12 days" recalculated daily), not a
  stream of discrete events to deduplicate.

Forcing the second shape into the first's schema would mean nullable-everywhere columns and
awkward status semantics. Separate tables, separate admin views, separate publish config. Zero
changes required to existing anomaly code or schema.

What **is** shared: the anomaly engine's per-metric buffer/baseline logic (rolling mean/std/
median/mad, warm-up tracking) should be extracted so maintenance/energy rule evaluation can reuse
it instead of re-deriving rolling stats a second and third time.

### 2. v1 is rule-based only — no ML, no forecasting

Rule types operate on thresholds, cumulative counters, and duration-over-threshold — not trend
extrapolation or trained models. Forecasting ("vibration climbing toward failure, ETA 12 days")
is real future value but needs a whole separate piece of infrastructure (the edge-training-
container idea, or reviving cloud-side training) — deliberately out of scope until the rule-based
version proves useful.

### 3. No generic JSON rules engine

Considered `json-rules-engine` or similar for admin-composable arbitrary boolean logic. Rejected:

- The rule types below aren't boolean-logic problems, they're **computation** problems —
  `cumulative_runtime` needs stateful accumulation across ticks, `duty_cycle` needs windowed
  on/off ratio math. A generic rules engine doesn't remove that computation, it just adds an
  abstraction layer on top of code that still has to be written.
- The anomaly engine already established the pattern for this exact situation — a small, fixed,
  **typed** set of methods (`DetectionMethod` union) with structured config
  (`AnomalyMetricConfig`), not free-form rule logic. Consistency with that pattern beats
  introducing a second paradigm for a sibling module.
- The actual benefit a JSON engine buys — admin-editable behavior without a code deploy — already
  comes for free from structured, DB-stored config objects. You don't need free-form rule *logic*
  to be editable, just the *parameters* of a fixed, well-tested set of rule types.

If a genuine case for arbitrary admin-composed conditions shows up later, add it then — most real
maintenance/energy rules are one of a handful of well-known shapes, not open-ended logic.

### 4. Reuse the debounce pattern from anomaly alerts

`anomaly_alerts` already has `consecutive_count`/`cooldown_sec`/`first_seen` for suppressing
noise-driven false positives (require N consecutive hits before firing, then cool down). The
[edge predictive-maintenance article reviewed during planning](https://medium.com/@ThinkingLoop/edge-predictive-maintenance-that-actually-works-f5de4f21ce38)
independently confirms this exact pattern ("score > 0.8 for 3 of 5 consecutive windows before
acting"). Maintenance/energy rule evaluation should reuse the same consecutive-hit-before-firing
logic, not reinvent it.

### 5. Tunable parameters, not hardcoded thresholds

Per rule instance, expose as config (not code):

- Window size (wider window for noisy sensors)
- Consecutive-hits-required before firing
- Condition/temperature gating (suppress the rule outside a valid operating envelope, e.g. don't
  flag vibration drift during a startup transient)

### 6. Distribution rides existing infrastructure

Rule config for a device is just DB config pushed via the same target-state mechanism every other
per-device config change already uses — no new distribution mechanism needed. If this ever grows
into shipping actual trained models to devices (v2+), the existing image/job rollout tables
(`image_rollouts`, `image_update_policies`, `job_templates`, `job_executions`) are the natural
place to hang that, rather than inventing a parallel rollout system.

## Asset model (Phase 0 — prerequisite for Phase 1)

### Why this exists

`device_uuid` identifies a *reporting* device — a sensor, PLC, or gateway; a communications
identity. It has nothing to do with the *equipment* being maintained (a compressor, a motor, a
bearing) — a business/physical identity. Conflating the two breaks down as soon as either of these
is true, both of which are normal in the field:

- One asset is monitored by more than one device (vibration sensor on one Modbus endpoint,
  temperature probe on a separate OPC-UA endpoint, both describing the same compressor).
- One device/gateway reports metrics for more than one unrelated asset (a single gateway
  multiplexing readings for five machines on a floor).

Without a real asset entity, `component` (see rule types below) is just a free-text label typed
into a rule config — no criticality, no install date, no rated life, nothing to prioritize on.
That's the actual gap between "we evaluate metric thresholds" and the asset-management value users
expect from a PM feature.

### Ownership: agent-local, not cloud-authored

Unlike `devices`/`endpoints` (which are cloud-authored in the main `iotistica` API and pushed down
via `agent_target_state`), the asset registry lives **in the agent's own SQLite**, same DB as
`maintenance_recommendations`, CRUD'd through the agent's Device API (port 48484) and surfaced in
`agent/admin`. Reasoning: `STANDALONE=true` is a first-class deployment mode with no cloud
connection at all — if assets were cloud-only, standalone/offline deployments (a real target for
this feature, not just a fallback) would have no asset management whatsoever. Physical equipment
metadata is naturally entered by whoever is standing next to the machine, at the site — it doesn't
need central authoring the way fleet-wide protocol/connection config does. A cloud rollup for
fleet-wide asset views can be added later as a one-way sync (mirroring how device health already
reconciles upward), without changing where the data is authored.

### New tables

```sql
-- The equipment itself. Agent-local — CRUD'd via Device API + agent/admin, no cloud dependency.
CREATE TABLE IF NOT EXISTS "assets" (
    "id"                  integer NOT NULL,
    "uuid"                varchar(255) NOT NULL,
    "name"                varchar(255) NOT NULL,        -- e.g. "Compressor Unit A"
    "asset_type"          varchar(255),                  -- free-text for v1, e.g. "compressor"
    "criticality"         varchar(20) NOT NULL DEFAULT 'medium',  -- low | medium | high | critical
    "manufacturer"        varchar(255),
    "model"               varchar(255),
    "rated_life_hours"    real,
    "rated_cycles"        integer,
    "install_date"        bigint,                        -- epoch ms
    "last_service_date"   bigint,
    "location"            varchar(255),
    "created_at"          datetime DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          datetime DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY("id" AUTOINCREMENT)
);
CREATE UNIQUE INDEX IF NOT EXISTS "assets_uuid_unique" ON "assets" ("uuid");

-- Maps an asset to the metric(s) that describe its condition. Many-to-many by construction:
-- one asset can bind metrics from multiple devices/endpoints; one device can back multiple assets.
CREATE TABLE IF NOT EXISTS "asset_metrics" (
    "id"              integer NOT NULL,
    "asset_id"        integer NOT NULL REFERENCES assets(id),
    "device_uuid"     varchar(255) NOT NULL,   -- the reporting device
    "endpoint_uuid"   varchar(255),             -- protocol connection on that device, if applicable
    "metric"          varchar(255) NOT NULL,    -- e.g. "vibration_rms", "runtime_hours"
    "created_at"      datetime DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      datetime DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY("id" AUTOINCREMENT)
);
CREATE INDEX IF NOT EXISTS "idx_asset_metrics_asset" ON "asset_metrics" ("asset_id");
```

### Granularity decision: `component` stays a free-text string (v1)

`component` (e.g. `"Bearing-1"`) already names a sub-part, not a whole machine — but it stays a
plain string scoped under `asset_id`, not its own sub-entity with independent criticality/rated-
life. Considered a hierarchical `asset_components` table (asset → components, each with its own
criticality) and rejected for v1: no concrete case yet where a sub-part needs criticality
independent of its parent asset, and it's a second new table plus more admin UI surface for no
proven benefit. Revisit only if a real case shows up (e.g. a non-critical bearing on an otherwise
critical compressor that genuinely needs its own tuning).

## Data model

New tables, modeled after the real column conventions already used by `anomaly_alerts` /
`anomaly_events` (snake_case, `bigint` epoch-ms timestamps, `AUTOINCREMENT` ids). `asset_id`
replaces `device_uuid`/`device_name` as the key identifier — see [Asset model](#asset-model-phase-0--prerequisite-for-phase-1)
above for why. `asset_name`/`criticality` are denormalized onto each recommendation row so the
admin UI and publish payloads (Phase 3) don't need a join to render or prioritize.

```sql
-- One row per (asset, component, rule) — a standing recommendation, re-evaluated in place.
CREATE TABLE IF NOT EXISTS "maintenance_recommendations" (
    "id"                  integer NOT NULL,
    "asset_id"            integer NOT NULL REFERENCES assets(id),
    "asset_name"          varchar(255) NOT NULL,        -- denormalized, avoids a join to render/publish
    "criticality"         varchar(20) NOT NULL,          -- denormalized from assets.criticality at eval time
    "component"           varchar(255) NOT NULL,      -- e.g. "Bearing-1", "Compressor"
    "rule_type"           varchar(50) NOT NULL,        -- cumulative_runtime | cycle_count | threshold_duration
    "rule_config"         text NOT NULL,                -- JSON: rule-type-specific params (see below)
    "status"              varchar(20) NOT NULL DEFAULT 'open',  -- open | scheduled | completed | dismissed
    "message"             varchar(1000) NOT NULL,
    "due_by"              bigint,                       -- epoch ms, nullable (not all rule types predict a date)
    "confidence"          float,
    "consecutive_count"   integer NOT NULL DEFAULT 1,
    "first_evaluated_at"  bigint NOT NULL,
    "last_evaluated_at"   bigint NOT NULL,
    "created_at"          datetime DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          datetime DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY("id" AUTOINCREMENT)
);
-- Partial, not plain, unique index: only one *active* (open/scheduled) recommendation is
-- allowed per (asset, component, rule) — completed/dismissed history rows for that same
-- combination are exempt, otherwise a re-triggered rule could never open a new row per the
-- history-preservation rule below (a plain unique index would collide with the old closed row).
CREATE UNIQUE INDEX IF NOT EXISTS "maintenance_rec_active_unique"
    ON "maintenance_recommendations" ("asset_id", "component", "rule_type")
    WHERE "status" IN ('open', 'scheduled');
CREATE INDEX IF NOT EXISTS "idx_maintenance_rec_status" ON "maintenance_recommendations" ("status");

-- Same shape, energy-specific rule types.
CREATE TABLE IF NOT EXISTS "energy_recommendations" (
    "id"                  integer NOT NULL,
    "asset_id"            integer NOT NULL REFERENCES assets(id),
    "asset_name"          varchar(255) NOT NULL,
    "criticality"         varchar(20) NOT NULL,
    "metric"              varchar(255) NOT NULL,
    "rule_type"           varchar(50) NOT NULL,        -- standby_waste | schedule_mismatch | duty_cycle
    "rule_config"         text NOT NULL,
    "status"              varchar(20) NOT NULL DEFAULT 'open',
    "message"             varchar(1000) NOT NULL,
    "estimated_impact"    varchar(255),                 -- free-text for v1 ("~4.2 kWh/day"), structured later
    "confidence"          float,
    "consecutive_count"   integer NOT NULL DEFAULT 1,
    "first_evaluated_at"  bigint NOT NULL,
    "last_evaluated_at"   bigint NOT NULL,
    "created_at"          datetime DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          datetime DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY("id" AUTOINCREMENT)
);
-- Same partial-uniqueness reasoning as maintenance_recommendations above.
CREATE UNIQUE INDEX IF NOT EXISTS "energy_rec_active_unique"
    ON "energy_recommendations" ("asset_id", "metric", "rule_type")
    WHERE "status" IN ('open', 'scheduled');
CREATE INDEX IF NOT EXISTS "idx_energy_rec_status" ON "energy_recommendations" ("status");

-- Rule definitions (the config an admin edits), one row per configured rule instance.
CREATE TABLE IF NOT EXISTS "maintenance_rules" (
    "id"              integer NOT NULL,
    "asset_id"        integer NOT NULL REFERENCES assets(id),
    "component"       varchar(255) NOT NULL,
    "rule_type"       varchar(50) NOT NULL,
    "enabled"         boolean NOT NULL DEFAULT 1,
    "config"          text NOT NULL,   -- JSON, shape depends on rule_type (see below)
    "created_at"      datetime DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      datetime DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY("id" AUTOINCREMENT)
);

CREATE TABLE IF NOT EXISTS "energy_rules" (
    "id"              integer NOT NULL,
    "asset_id"        integer NOT NULL REFERENCES assets(id),
    "metric"          varchar(255) NOT NULL,
    "rule_type"       varchar(50) NOT NULL,
    "enabled"         boolean NOT NULL DEFAULT 1,
    "config"          text NOT NULL,
    "created_at"      datetime DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      datetime DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY("id" AUTOINCREMENT)
);
```

The rule evaluator resolves `asset_id` → its bound `(device_uuid, endpoint_uuid, metric)` via
`asset_metrics` to know which metric stream to actually read; `device_uuid` no longer
appears directly on the rule/recommendation tables.

`status` lifecycle for both recommendation tables: `open` → `scheduled` → `completed`, or
`open` → `dismissed` (operator feedback — see [Deferred](#deferred--v2-ideas)). A rule that keeps
re-evaluating as true against an already-`completed`/`dismissed` recommendation should open a
**new** row rather than reopening the old one, preserving history.

### Criticality feeds prioritization, not just display

`criticality` isn't just a label — it's meant to modulate behavior:

- **Rule defaults**: when an admin adds a rule for a `critical` asset, the UI should default to a
  lower `consecutiveWindowsRequired`/shorter `cooldown_sec` than for a `low` asset (still editable
  per rule instance, per decision #5 above).
- **Publish priority (Phase 3)**: the publish payload includes `criticality`, so downstream
  destinations (ticketing, paging) can route a critical-asset recommendation differently from an
  informational one — without needing their own copy of asset metadata.
- **Admin UI sort/filter**: recommendation list views sort by criticality by default, so the most
  consequential open items surface first regardless of which rule fired.

## Rule types (v1)

Typed configs, not free-form JSON logic — each `rule_type` has a fixed, known shape.

```typescript
// Maintenance
interface CumulativeRuntimeRuleConfig {
  metric: string;              // e.g. "runtime_hours" (monotonically increasing counter)
  thresholdHours: number;      // fire when cumulative runtime crosses this since last service
  windowGating?: {             // optional condition/temperature gating from the article review
    metric: string;
    min?: number;
    max?: number;
  };
}

interface CycleCountRuleConfig {
  metric: string;               // e.g. "start_stop_count"
  thresholdCycles: number;
}

interface ThresholdDurationRuleConfig {
  metric: string;                // e.g. "vibration_rms"
  threshold: number;
  comparator: 'gt' | 'lt';
  sustainedForMs: number;        // must stay past threshold for this long
  consecutiveWindowsRequired: number;  // debounce, mirrors anomaly_alerts.consecutive_count
  windowGating?: { metric: string; min?: number; max?: number };
}

// Energy
interface StandbyWasteRuleConfig {
  metric: string;                 // e.g. "power_draw_w"
  standbyThreshold: number;       // below this = considered idle
  outsideScheduleOnly: boolean;   // only flag waste outside configured operating hours
  schedule?: { start: string; end: string; days: number[] };  // 24h "HH:mm", 0=Sun
}

interface ScheduleMismatchRuleConfig {
  metric: string;                  // e.g. "occupancy" or "run_state"
  expectedSchedule: { start: string; end: string; days: number[] };
  toleranceMinutes: number;
}

interface DutyCycleRuleConfig {
  metric: string;                  // on/off signal
  windowMs: number;                // rolling window to compute on/off ratio over
  expectedMinRatio?: number;
  expectedMaxRatio?: number;
}
```

Every rule evaluation reuses:
- The anomaly engine's shared metric buffer/baseline accessor (extraction target — see Phase 1).
- The same consecutive-hit debounce approach as `anomaly_alerts`.

## Phased implementation

### Phase 0 — Backend: asset registry

1. Add migrations for `assets` and `asset_metrics` (see
   [Asset model](#asset-model-phase-0--prerequisite-for-phase-1) above), plus corresponding model
   files following the same `Row`/`Payload` interface pattern as the anomaly models.
2. Device API (port 48484) endpoints for asset CRUD and metric-binding management — this is what
   `agent/admin`'s new Assets view will call.
3. `agent/admin`: new `AssetsView.vue` — asset list/create/edit (name, type, criticality,
   manufacturer, rated life, install/service dates) plus a metric-binding editor per asset
   (pick device/endpoint + metric to bind).

No rule evaluation or recommendation logic yet — this phase only stands up the registry that
Phase 1 depends on for `asset_id`.

### Phase 1 — Backend: schema + rule engine

1. Add the migrations for the four new tables above (`maintenance_recommendations`,
   `energy_recommendations`, `maintenance_rules`, `energy_rules`) plus corresponding model files
   (mirroring `anomaly-event.model.ts` / `anomaly-alert.model.ts`'s `Row`/`Payload` interface
   pattern). These key off `asset_id`, so Phase 0 must land first.
2. Extract the anomaly engine's per-metric rolling-stats/buffer logic into something callable from
   outside the anomaly module (currently private to it) — this is the one piece of *shared*
   infrastructure across all three modules.
3. Implement rule evaluators per `rule_type` (real TS functions, not a generic interpreter):
   `evaluateCumulativeRuntime()`, `evaluateCycleCount()`, `evaluateThresholdDuration()`,
   `evaluateStandbyWaste()`, `evaluateScheduleMismatch()`, `evaluateDutyCycle()`. Each evaluator
   resolves `asset_id` → `(device_uuid, endpoint_uuid, metric)` via `asset_metrics` before
   reading the metric stream.
4. New detection-runner-style loop(s) (mirroring `iot-agent-pro/src/anomaly/detection-runner.ts`'s
   structure) that: loads enabled rules for the device → evaluates each on tick → applies debounce
   → upserts into the recommendation table.

### Phase 2 — Admin UI

1. New views following `AnomalyView.vue`'s established pattern (rule table, add/edit modal) —
   `MaintenanceView.vue` and `EnergyView.vue`. Rule editor's asset picker reuses the Assets view
   from Phase 0.
2. Rule editor per `rule_type`, form fields driven by the config shape above.
3. Recommendation list view per module: status, message, due-by/impact, sorted by asset
   criticality by default, with actions to mark scheduled/completed/dismissed.

### Phase 3 — Publishing

1. Dedicated publish path per module (own `alertDestinationId`/`alertTopic`-style config),
   following the pattern anomaly alerts already use — **not** the generic tags/ml metric-stream
   payload formats, since recommendations are event-shaped, not continuous metrics.
2. Payload includes at minimum: asset (name + criticality), component/metric, rule_type, message,
   status, due_by or estimated_impact — criticality lets downstream destinations (ticketing,
   paging) route/prioritize without needing their own copy of asset metadata.

## Deferred / v2 ideas

Captured from the [edge predictive-maintenance article review](https://medium.com/@ThinkingLoop/edge-predictive-maintenance-that-actually-works-f5de4f21ce38)
and earlier planning discussion — explicitly not in v1 scope:

- **Trend forecasting** (predict time-to-threshold, not just threshold-crossing) — needs either
  the edge-training-container approach (Python container trains locally, exports ONNX, Node.js
  agent does lightweight continuous inference) or reviving cloud-side training. See the
  train/infer split discussion earlier in this plan's history for the reasoning on why
  training-only-then-exit containers beat an always-on Python inference service on
  resource-constrained gateways.
- **Vibration-specific feature rule types** (RMS, kurtosis, crest factor, band power) — real value
  for rotating-equipment condition monitoring specifically, not universal; add as additional
  `rule_type`s under the same typed pattern once there's a concrete equipment case for them.
- **Autonomous local corrective action** (auto-adjust setpoints/speed rather than just
  recommending) — explicit decision needed later on whether this module ever closes the loop, or
  stays advisory-only permanently.
- **Operator feedback loop** — a "dismiss as not relevant" action feeding back into rule tuning
  (the `status = 'dismissed'` state is already reserved for this in the schema above, but no
  tuning logic consumes it yet).
- **Drift monitoring / retraining cadence** — only relevant once an actual trained model exists in
  the loop.

## Open questions before Phase 0 starts

- **Repo placement**: anomaly detection's DB models/schema live in `iot-agent`
  (`src/db/models/anomaly-*.model.ts`), while the statistical detection algorithms themselves live
  in `iot-agent-pro/src/anomaly/`. Confirm whether maintenance/energy rule evaluation belongs in
  `iot-agent-pro` (mirroring the algorithm-tier split) or `iot-agent` directly before writing any
  code. The asset registry itself (schema + CRUD) is agent-local by decision and belongs in
  `iot-agent` regardless — this question is only about where rule *evaluation* logic lives.
- Confirm the exact rule-type list is complete for a useful v1 before building the admin UI around
  it — the six listed above are a starting set, not necessarily final.
- **Cloud rollup for fleet-wide asset views**: deferred, not designed yet. If/when multi-site
  fleets need a consolidated asset view, decide whether that's a one-way sync of agent-authored
  asset data upward (mirroring device health reconciliation) or something else — out of scope for
  this plan.
