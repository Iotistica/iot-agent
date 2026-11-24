# Unified Namespace (UNS) & Sparkplug B — Direction

## Current State

The agent already has building blocks toward UNS:

- **OPC UA browse path** — `DiscoveryObject.browsePath` captures the full hierarchy during discovery (`device-identity.ts`). Each path segment encodes `[namespaceUri, browseName]`.
- **Asset path per device** — user-editable `assetPath` field on the device model (e.g., `Chicago/Plant-3/Line-A/CNC-01`), stored in DB, exposed in Device Drawer.
- **Topic template** — destination-level `topicTemplate` with `{deviceId}`, `{endpoint}`, `{topic}`, `{assetPath}` placeholders. Applied in `applyTopicTemplate()` at publish time.

**Gap**: everything publishes as one bulk JSON per batch to one topic. UNS requires one topic per point (or per device), where the topic hierarchy *is* the namespace.

## Proposed Levels

### Level 1 — Per-Point Publish Mode

Add a publish mode to subscriptions or destinations:

| Mode | Behavior | Topic |
|------|----------|-------|
| `batch` (current default) | All readings in one JSON payload | `{template}` |
| `per-point` (new) | One message per reading | `{template}/{normalizedName}` |

In `per-point` mode the MQTT plugin iterates the readings array and publishes each one individually to its own topic. Payload per message is ~100 bytes (one reading), so no chunking needed.

**Implementation**: similar scope to the MQTT chunking feature. The `chunkPayload()` method already parses JSON and iterates readings — per-point mode chunks to size=1 and appends the point's metric name to the topic.

**Where the setting lives**: `route_json` on the subscription (alongside `maxPointsPerMessage`), or `config_json` on the destination. Subscription-level is more flexible since the same destination could serve both batch and per-point consumers.

### Level 2 — Browse Path as Topic Placeholder

Wire OPC UA browse path from discovery → device data points → publish payload, so it's available as `{browsePath}` in topic templates.

**Data flow**:
1. Discovery already captures `browsePath` on `DiscoveryObject` (`device-identity.ts:191`)
2. Store a cleaned version on each `OPCUADataPoint` (e.g., `Objects/Machines/AHU-1/SpaceTemp`)
3. Include it in the publish payload alongside `metric`, `deviceName`, etc.
4. Add `{browsePath}` to `applyTopicTemplate()` — resolves per reading in per-point mode

**Example result**: template `uns/{browsePath}` → topic `uns/Objects/Machines/AHU-1/SpaceTemp`

This is the "automatic namespace from OPC UA structure" path — no manual asset path needed per device.

### Level 3 — Topic Rules

Instead of one topic template per destination, allow a list of rules that match points by pattern and assign topics. One rule covers many points.

```json
[
  {
    "name": "OPC UA → UNS by browse path",
    "match": { "protocol": "opcua" },
    "topicTemplate": "uns/{browsePath}"
  },
  {
    "name": "Modbus → UNS by asset path",
    "match": { "protocol": "modbus" },
    "topicTemplate": "uns/{assetPath}/{metric}"
  },
  {
    "name": "Catch-all",
    "match": {},
    "topicTemplate": "uns/unclassified/{deviceName}/{metric}"
  }
]
```

**Available template fields per reading**: `deviceName`, `deviceId`, `metric` (normalized point name), `protocol`, `unit`, `quality`, `browseName`, `rawObjectName`, `assetPath`, `browsePath`.

**Match criteria**: `protocol`, `deviceName` (glob), `metric` (glob), `endpoint`.

Rules are evaluated in order; first match wins. Stored on the destination or subscription as `topicRules` in JSON config.

**UI**: simple ordered list in Destination or Subscription drawer — name, match pattern, topic template. Drag to reorder.

### Level 4 — Sparkplug B (Optional, Customer-Driven)

Sparkplug B adds on top of UNS:

- **Fixed topic scheme**: `spBv1.0/{group_id}/{message_type}/{edge_node_id}/{device_id}`
  - `message_type`: NBIRTH, NDEATH, DBIRTH, DDEATH, NDATA, DDATA, NCMD, DCMD
- **Protobuf payloads**: Google Protobuf encoding (not JSON) per the Sparkplug B spec
- **Birth/death certificates**: on connect, publish NBIRTH (edge node birth) and DBIRTH (device birth) with full metric catalog; on disconnect, broker publishes NDEATH via LWT
- **Sequence numbers**: monotonically increasing `seq` per edge node, reset on NBIRTH
- **Metric metadata**: data type, alias (compact integer ID), properties, timestamp per metric

**Implementation scope**: significantly larger than levels 1-3. Requires:
- Protobuf serialization (sparkplug-payload npm package or manual)
- Connection lifecycle management (birth/death on connect/disconnect)
- Metric catalog tracking (which metrics belong to which device)
- Sequence number state machine
- New payload format option (`sparkplug-b`) alongside existing `tags`/`ecp`/`ml`/`custom`

**Recommendation**: implement only when a specific customer or integration requires it (HiveMQ, Ignition, Inductive Automation). Levels 1-3 with JSON payloads cover the general UNS use case. Any MQTT consumer can subscribe to hierarchical topics regardless of payload format.

## Suggested Sequence

| Step | Scope | Depends On |
|------|-------|------------|
| Per-point publish mode | MQTT plugin change, ~same as chunking | Nothing |
| `{browsePath}` placeholder | Discovery → data point → payload wiring | Nothing |
| Topic rules engine | Config model + rule evaluation at publish | Per-point mode |
| Topic rules UI | Admin drawer for rules list | Topic rules engine |
| Sparkplug B | New payload format + lifecycle | Per-point mode |

Steps 1-2 are independent and can be done in parallel. Together they give a working UNS: set topic template to `uns/{browsePath}` with per-point mode and each OPC UA point publishes to its own hierarchical topic automatically.

## Compatibility Notes

- **Batch mode stays default** — existing deployments are unaffected
- **Per-point mode + chunking**: mutually exclusive (per-point is chunk-size-1 by definition)
- **Compression**: per-point payloads are small (~100 bytes); compression overhead would exceed savings. Auto-disable compression in per-point mode.
- **Activity monitor**: per-point mode still calls `activityMonitor.record()` once per batch, not per point — no performance change there
- **Rate limiting**: at 50K points × 1 msg/point × 1 publish/sec = 50K msg/sec to the broker. Need `minIntervalMs` on subscription (already exists in `route_json`) or a configurable publish rate cap. This is the main scalability concern for per-point mode at high point counts.
