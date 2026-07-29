# MQTT Device-Write Commands

Optional feature letting an external system (SCADA, cloud app) trigger a
protocol write on the agent by publishing an MQTT command, instead of calling
the local Device API directly. **Disabled by default.**

Covers GitHub issues #4 (OPC-UA), #5 (Modbus), #6 (BACnet — not yet
implemented, see [Protocol support](#protocol-support) below).

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

The feature also requires the device to be provisioned (command topics are
tenant-scoped, same precondition as the Agent Updater's MQTT listener).

## MQTT topics

Both are agent-scoped, following the same convention as every other agent
MQTT topic (`i/{tenantId}/a/{agentId}/...`, base64-encoded):

```
i/{tenantId}/a/{agentId}/cmd/write     # inbound commands (QoS 1, subscribe)
i/{tenantId}/a/{agentId}/cmd/result    # outbound results (QoS 1, never retained)
```

A retained message on the command topic is always rejected and dropped —
there is no commandId to publish a result against, so nothing is published.

## Command schema

Deliberately protocol-agnostic — one schema, one topic, for every protocol.
`deviceName` is resolved against whichever adapter currently owns that
device, so the producer doesn't need to know if it's writing to an OPC-UA
node or a Modbus register.

```json
{
  "version": 1,
  "commandId": "01J2XYZ8T2NJ5V8D3M1G6G7P9Q",
  "type": "device.write",
  "issuedAt": "2026-07-28T15:20:00.000Z",
  "expiresAt": "2026-07-28T15:20:30.000Z",
  "deviceName": "ahu-1",
  "pointName": "SpeedSetpoint",
  "value": 1500
}
```

`pointName` maps to the same point identifier already used by each adapter's
existing write path — an OPC-UA data point's `name` (or `nodeId`), or a
Modbus register's `name`.

## Result schema

Exactly one terminal result is published per command that had a recoverable
`commandId`.

```json
{
  "version": 1,
  "commandId": "01J2XYZ8T2NJ5V8D3M1G6G7P9Q",
  "type": "device.write.result",
  "status": "succeeded",
  "deviceName": "ahu-1",
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

## Protocol support

| Protocol | Write capability | Status |
|----------|------------------|--------|
| OPC-UA   | `OPCUAAdapter.writeNode()` (pre-existing) | Supported |
| Modbus   | `ModbusAdapter.writeRegister()` (pre-existing) | Supported |
| BACnet   | none yet | Not implemented — commands targeting a BACnet device are rejected with `UNSUPPORTED_COMMAND_TYPE` until `BACnetAdapter` gains a `write()` capability (tracked separately, issue #6) |

## Architecture

```
MQTT command topic
        │
        ▼
MqttCommandConsumer          (src/commands/mqtt-command-consumer.ts)
        │ retain? -> drop
        ▼
CommandService.handleMessage (src/commands/command-service.ts)
        │ parse + schema validate (command-validator.ts)
        │ expiry check
        │ dedup check (command-deduplicator.ts)
        │ bounded FIFO queue, sequential execution
        ▼
dispatchWrite()               (src/commands/write-dispatcher.ts)
        │ resolve deviceName -> owning adapter
        │ OPCUAAdapter.writeNode() / ModbusAdapter.writeRegister()
        ▼
CommandResultPublisher.publish (src/commands/command-result-publisher.ts)
        │
        ▼
MQTT result topic
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
- BACnet write support (see table above).
- Per-device (rather than agent-wide) queues.
