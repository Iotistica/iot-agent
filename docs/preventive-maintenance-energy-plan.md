# Preventive Maintenance & Energy Recommendations — Implementation Plan

Status: **planned, not implemented**. This document captures the architecture decisions and phased
implementation plan agreed before writing any code.

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

## Data model

New tables, modeled after the real column conventions already used by `anomaly_alerts` /
`anomaly_events` (snake_case, `bigint` epoch-ms timestamps, `AUTOINCREMENT` ids).

```sql
-- One row per (device, component, rule) — a standing recommendation, re-evaluated in place.
CREATE TABLE IF NOT EXISTS "maintenance_recommendations" (
    "id"                  integer NOT NULL,
    "device_uuid"         varchar(255) NOT NULL,
    "device_name"         varchar(255) NOT NULL,
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
CREATE UNIQUE INDEX IF NOT EXISTS "maintenance_rec_device_component_rule_unique"
    ON "maintenance_recommendations" ("device_uuid", "component", "rule_type");
CREATE INDEX IF NOT EXISTS "idx_maintenance_rec_status" ON "maintenance_recommendations" ("status");

-- Same shape, energy-specific rule types.
CREATE TABLE IF NOT EXISTS "energy_recommendations" (
    "id"                  integer NOT NULL,
    "device_uuid"         varchar(255) NOT NULL,
    "device_name"         varchar(255) NOT NULL,
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
CREATE UNIQUE INDEX IF NOT EXISTS "energy_rec_device_metric_rule_unique"
    ON "energy_recommendations" ("device_uuid", "metric", "rule_type");
CREATE INDEX IF NOT EXISTS "idx_energy_rec_status" ON "energy_recommendations" ("status");

-- Rule definitions (the config an admin edits), one row per configured rule instance.
CREATE TABLE IF NOT EXISTS "maintenance_rules" (
    "id"              integer NOT NULL,
    "device_uuid"     varchar(255) NOT NULL,
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
    "device_uuid"     varchar(255) NOT NULL,
    "metric"          varchar(255) NOT NULL,
    "rule_type"       varchar(50) NOT NULL,
    "enabled"         boolean NOT NULL DEFAULT 1,
    "config"          text NOT NULL,
    "created_at"      datetime DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      datetime DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY("id" AUTOINCREMENT)
);
```

`status` lifecycle for both recommendation tables: `open` → `scheduled` → `completed`, or
`open` → `dismissed` (operator feedback — see [Deferred](#deferred--v2-ideas)). A rule that keeps
re-evaluating as true against an already-`completed`/`dismissed` recommendation should open a
**new** row rather than reopening the old one, preserving history.

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

### Phase 1 — Backend: schema + rule engine

1. Add the migrations for the four new tables above (`maintenance_recommendations`,
   `energy_recommendations`, `maintenance_rules`, `energy_rules`) plus corresponding model files
   (mirroring `anomaly-event.model.ts` / `anomaly-alert.model.ts`'s `Row`/`Payload` interface
   pattern).
2. Extract the anomaly engine's per-metric rolling-stats/buffer logic into something callable from
   outside the anomaly module (currently private to it) — this is the one piece of *shared*
   infrastructure across all three modules.
3. Implement rule evaluators per `rule_type` (real TS functions, not a generic interpreter):
   `evaluateCumulativeRuntime()`, `evaluateCycleCount()`, `evaluateThresholdDuration()`,
   `evaluateStandbyWaste()`, `evaluateScheduleMismatch()`, `evaluateDutyCycle()`.
4. New detection-runner-style loop(s) (mirroring `iot-agent-pro/src/anomaly/detection-runner.ts`'s
   structure) that: loads enabled rules for the device → evaluates each on tick → applies debounce
   → upserts into the recommendation table.

### Phase 2 — Admin UI

1. New views following `AnomalyView.vue`'s established pattern (rule table, add/edit modal) —
   `MaintenanceView.vue` and `EnergyView.vue`.
2. Rule editor per `rule_type`, form fields driven by the config shape above.
3. Recommendation list view per module: status, message, due-by/impact, with actions to mark
   scheduled/completed/dismissed.

### Phase 3 — Publishing

1. Dedicated publish path per module (own `alertDestinationId`/`alertTopic`-style config),
   following the pattern anomaly alerts already use — **not** the generic tags/ml metric-stream
   payload formats, since recommendations are event-shaped, not continuous metrics.
2. Payload includes at minimum: device, component/metric, rule_type, message, status, due_by or
   estimated_impact.

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

## Open questions before Phase 1 starts

- **Repo placement**: anomaly detection's DB models/schema live in `iot-agent`
  (`src/db/models/anomaly-*.model.ts`), while the statistical detection algorithms themselves live
  in `iot-agent-pro/src/anomaly/`. Confirm whether maintenance/energy rule evaluation belongs in
  `iot-agent-pro` (mirroring the algorithm-tier split) or `iot-agent` directly before writing any
  code.
- Confirm the exact rule-type list is complete for a useful v1 before building the admin UI around
  it — the six listed above are a starting set, not necessarily final.
