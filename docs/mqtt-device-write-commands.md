# MQTT Device-Write Commands

Optional feature letting an external system (SCADA, cloud app) trigger a
protocol write on the agent by publishing an MQTT command, instead of calling
the local Device API directly. **Disabled by default.**

Supported protocols: OPC-UA, Modbus, and BACnet (see [Protocol support](#protocol-support)).

## Security note

`Good`/`succeeded` means the protocol server accepted the write — it does not
mean the physical equipment reached the requested state. Verifying that
requires a separate feedback point on the device and is out of scope for this
first version.

## Enabling it

```bash
COMMANDS_ENABLED=true
COMMANDS_MAX_AGE_SECONDS=30        # default 30
COMMANDS_QUEUE_SIZE=1000           # default 1000
COMMANDS_WRITE_TIMEOUT_MS=5000     # default 5000
COMMANDS_DEDUP_TTL_SECONDS=300     # default 300
```

When `COMMANDS_ENABLED` is unset (or anything other than `"true"`), the agent
never subscribes to the command topic and never touches a protocol adapter
for this feature — existing telemetry, discovery, and publishing behavior is
completely unchanged.

Setup checklist:

1. Set `COMMANDS_ENABLED=true` and restart the agent.
2. In the admin UI, create (or edit) an MQTT publish destination and tick
   `use_for_commands`. Only one destination can carry this flag. The command
   consumer subscribes on that destination's broker, not the cloud connection.
3. Mark each target point `writable: true` in the device configuration.
4. Provisioning is **not** required. If no destination is flagged, the agent
   logs a warning and the consumer does not start.

## MQTT topics

Both topics are scoped by the agent's own device UUID and live on the broker
of the destination flagged `use_for_commands`:

```
{agentUuid}/cmd/write     # inbound commands (QoS 1, subscribe)
{agentUuid}/cmd/result    # outbound results (QoS 1, never retained)
```

`{agentUuid}` is the agent's own device uuid, not the target device's. The
target device is named inside the payload (`deviceUuid`).

A retained message on the command topic is always rejected and dropped —
there is no commandId to publish a result against, so nothing is published.

## Sending a command (example)

Subscribe to results, then publish a command:

```bash
mosquitto_sub -h <broker> -q 1 -t "<agentUuid>/cmd/result"

mosquitto_pub -h <broker> -q 1 -t "<agentUuid>/cmd/write" -m '{
  "version": 1,
  "commandId": "cmd-001",
  "type": "device.write",
  "issuedAt": "2026-07-28T15:20:00.000Z",
  "expiresAt": "2026-07-28T15:20:30.000Z",
  "deviceUuid": "<target device uuid>",
  "pointName": "SpeedSetpoint",
  "value": 1500
}'
```

`expiresAt` must fall within the `COMMANDS_MAX_AGE_SECONDS` window from
`issuedAt`. Commands older than that are rejected.

## Command schema

Deliberately protocol-agnostic — one schema, one topic, for every protocol.
`deviceUuid` is resolved against whichever adapter currently owns that device,
so the producer doesn't need to know if it's writing to an OPC-UA node, a
Modbus register, or a BACnet object.

```json
{
  "version": 1,
  "commandId": "01J2XYZ8T2NJ5V8D3M1G6G7P9Q",
  "type": "device.write",
  "issuedAt": "2026-07-28T15:20:00.000Z",
  "expiresAt": "2026-07-28T15:20:30.000Z",
  "deviceUuid": "3f1c2a7e-9b4d-4e8a-8c2f-6a1d0e5b7c90",
  "pointName": "SpeedSetpoint",
  "value": 1500
}
```

- `deviceUuid` is the devices table `uuid`. Copy it from the admin UI's Devices
  grid (copy button). A raw configured endpoint name also works as a
  best-effort fallback.
- `value` may be a number, boolean, or string. `null` is not accepted.

### Point name rules

`pointName` must match what a user sees for that point:

- **OPC-UA:** the data point's `name`, its raw `nodeId`, or its unmodified `browseName`.
- **BACnet:** the sanitized `name`, or the device's raw `objectName` (e.g. `AHU-1.SF-Run`).
- **Modbus:** the register's `name`.

## Result schema

Exactly one terminal result is published per command that had a recoverable
`commandId`.

```json
{
  "version": 1,
  "commandId": "01J2XYZ8T2NJ5V8D3M1G6G7P9Q",
  "type": "device.write.result",
  "status": "succeeded",
  "deviceUuid": "3f1c2a7e-9b4d-4e8a-8c2f-6a1d0e5b7c90",
  "pointName": "SpeedSetpoint",
  "requestedValue": 1500,
  "receivedAt": "2026-07-28T15:20:01.100Z",
  "completedAt": "2026-07-28T15:20:01.180Z"
}
```

`status` is one of `succeeded`, `failed`, `rejected`, `duplicate`, `expired`.
Failures/rejections include an `error` object:

```json
{
  "status": "rejected",
  "error": { "code": "NODE_NOT_ALLOWED", "message": "Node is not writable: SpeedSetpoint" }
}
```

Error codes: `INVALID_JSON`, `INVALID_SCHEMA`, `UNSUPPORTED_VERSION`,
`UNSUPPORTED_COMMAND_TYPE`, `COMMAND_EXPIRED`, `COMMAND_TOO_OLD`,
`DUPLICATE_COMMAND`, `NODE_NOT_ALLOWED`, `DEVICE_NOT_CONNECTED`,
`WRITE_REJECTED`, `WRITE_TIMEOUT`, `RETAINED_COMMAND_REJECTED`,
`PAYLOAD_TOO_LARGE`, `COMMAND_QUEUE_FULL`, `INTERNAL_ERROR`.

## Writable-point allowlist

A point must be explicitly marked writable in the device's own stored config
before a command can write to it — the command layer never accepts a
node/register identity as authorization on its own:

- **OPC-UA**: each data point already supports `writable: true` +
  `writeDataType` (pre-existing fields, enforced inside
  `OPCUAAdapter.writeNode`).
- **Modbus**: each register now supports `writable: true` (new field on
  `ModbusRegisterSchema`, default `false`). This is enforced only in the
  command-write path (`src/commands/write-dispatcher.ts`), not inside
  `ModbusAdapter.writeRegister` itself — the pre-existing, role-gated HTTP
  endpoint (`POST /v1/adapters/modbus/devices/:deviceName/write`) is
  unaffected and keeps its current behavior.
- **BACnet**: each object now supports `writable: true` + `writePriority`
  (1-16, default 8) + an optional `writeDataType` override (new fields on
  `BACnetObjectSchema`, added in Phase 2). Enforced inside
  `BACnetClient.write()` itself, same pattern as OPC-UA — there was no
  pre-existing BACnet write path to avoid disrupting.

## Protocol support

| Protocol | Write capability | Status |
|----------|------------------|--------|
| OPC-UA   | `OPCUAAdapter.writeNode()` (pre-existing) | Supported |
| Modbus   | `ModbusAdapter.writeRegister()` (pre-existing) | Supported |
| BACnet   | `BACnetAdapter.writeProperty()` / `BACnetClient.write()` (added in Phase 2, uses `bacstack`'s `writeProperty` with a configurable per-object priority) | Supported |

### BACnet write data types

Each writable object needs its BACnet application tag known at write time.
`writeDataType` (`boolean` \| `unsigned` \| `signed` \| `real` \| `double` \|
`enumerated` \| `string`) is optional — when omitted, it's inferred from
`objectType`: analog-\* → `real`, binary-\* → `boolean`, multi-state-\* →
`unsigned`. The value is validated against the resolved tag (e.g. a boolean
sent for an analog point is rejected, not silently coerced to `1`/`0`).

BACnet's Null-write (releasing a priority-array entry) is not wired through
the MQTT command schema in this pass — `WriteCommandSchema.value` doesn't
accept `null` yet. `BACnetClient.write()` could support it at the protocol
layer, but there's no way to request it via a command today.

## Architecture

```
MQTT command topic  ({agentUuid}/cmd/write, on the use_for_commands destination)
        │
        ▼
MqttCommandConsumer          (src/commands/mqtt-consumer.ts)
        │ retain? -> drop
        ▼
CommandService.handleMessage (src/commands/service.ts)
        │ parse + schema validate (types.ts)
        │ expiry check
        │ dedup check (deduplicator.ts)
        │ bounded FIFO queue, sequential execution
        ▼
dispatchWrite()               (src/commands/write-dispatcher.ts)
        │ resolve deviceUuid -> owning adapter
        │ OPCUAAdapter.writeNode() / ModbusAdapter.writeRegister()
        │ / BACnetAdapter.writeProperty()
        ▼
CommandResultPublisher.publish (src/commands/result-publisher.ts)
        │
        ▼
MQTT result topic  ({agentUuid}/cmd/result)
```

Commands are processed sequentially (one write in flight at a time, agent-wide,
not per-device) to keep ordering, deduplication, and auditing simple in this
first version. Deduplication is process-local (in-memory, TTL'd, bounded) —
sufficient for MQTT QoS 1 redelivery, but does not survive an agent restart.

## What's intentionally not built yet

- Read-back verification (`verifyReadBack`) — the issues ask for it as an
  optional, disabled-by-default extra; not implemented in this first pass.
- Per-protocol metrics (`agent_commands_*` counters) — no metrics/prom-client
  system exists in this codebase yet to hook into; structured logs
  (`component: LogComponents.commands`) cover the same audit trail for now.
- Per-device (rather than agent-wide) queues.
- BACnet Null-writes (priority-array release) — see above.
- MQTT adapter write support — the MQTT adapter has no write method, so
  commands targeting it are rejected with `UNSUPPORTED_COMMAND_TYPE`.
