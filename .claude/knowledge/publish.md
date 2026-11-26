# Publish Pipeline Architecture

## Overview

The publish pipeline moves OPC UA readings from a Rust IPC server to MQTT destinations. It handles 100K+ points at ~7.6K readings/sec production rate across multiple subscription/destination bindings.

## End-to-End Data Flow

```
Rust OPC UA plugin → binary frames → Rust IPC server (modules/ipc/src/lib.rs)
  → decode_batch_to_json() converts binary wire format v1 to JSON
  → broadcast_frame() sends JSON over Unix socket
  → Node.js SocketConnection (src/publish/core/socket.ts) receives data
  → MessageBatcher (src/publish/core/batch.ts) reassembles frames, JSON.parse each
  → 'flush' event triggers PublishManager.publishBatch()
  → Per-subscription routing → Rust batch (modules/publish/) or JS fallback
  → MQTT publish via R3 concurrent publisher
```

## Key Files

| File | Role |
|------|------|
| `src/publish/core/manager.ts` | **PublishManager** — orchestrates the entire publish cycle |
| `src/publish/core/batch.ts` | **MessageBatcher** — frame reassembly + message accumulation |
| `src/publish/core/socket.ts` | **SocketConnection** — Unix socket lifecycle, reconnect, pause/resume |
| `src/publish/init.ts` | **DevicePublish** — multi-endpoint manager, plugin instantiation |
| `src/publish/core/types.ts` | Config schemas (Zod), DeviceState enum, interfaces |
| `src/publish/plugins/mqtt.ts` | **MqttPublishPlugin** — R3 concurrent MQTT publisher |
| `src/publish/core/compress.ts` | PayloadCompressor — JSON/deflate/zstd/msgpack |
| `src/publish/core/payload-chunker.ts` | PayloadChunker — splits readings into size-bounded chunks |
| `src/publish/core/activity-monitor.ts` | ActivityMonitor — dashboard tile data, quality sampling |
| `src/publish/anomaly/feed.ts` | AnomalyFeed — feeds readings to anomaly detection |
| `src/publish/anomaly/enrich.ts` | AnomalyEnricher — attaches anomaly scores to readings |
| `src/core/rust-publish-formatter.ts` | **PublishFormatter** — TypeScript wrapper for Rust NAPI module |
| `modules/publish/src/lib.rs` | **Rust NAPI module** — off-thread flatten/chunk/enrich/serialize |
| `modules/publish/Cargo.toml` | Rust deps: napi 2, serde_json, tokio, zstd, libc |
| `modules/ipc/src/lib.rs` | **Rust IPC server** — binary→JSON decode, Unix socket broadcast |

## PublishManager.publishBatch() — The Hot Path

This is the main publish cycle. It runs when the batcher emits 'flush'.

### Phase Sequence

```
1. takeUpTo(MAX_MESSAGES_PER_CYCLE)   — bounded drain from batcher (socket paused only here)
2. liveDataInterceptor                — enriches messages (pointIdentity, unitValue, etc.)
3. collectTagRecords + qualitySample  — feeds dashboard quality tile
4. schemaDriftDetector                — schema drift observation window
5. processAnomaly()                   — anomaly feed + enrichment
6. buildPayload()                     — builds global-format payload (see CAUTION below)
7. publishOnline()                    — durable buffer + compression + route + MQTT
   7a. persistClaimedBatch()          — SQLite durable buffer write
   7b. compressedPayloadCache         — global payload cache
   7c. routePublishBatch()            — iterates bindings → collectRouteEntries()
       → getCompressedPayloadForFormat() per subscription (Rust batch or JS fallback)
       → MqttPublishPlugin.publishBatch() (R3 concurrent publisher)
8. finally: self-retrigger            — if batcher still has messages, setImmediate → publishBatch()
```

### Timing Logs

- `[Metrics] Socket paused for batcher drain` — messageCount, remainingInBatcher, cappedAt
- `[Metrics] Publish cycle phase breakdown` — interceptorMs, qualitySampleMs, driftMs, anomalyMs, buildPayloadMs, publishOnlineMs, totalMs
- `[Metrics] publishOnline phase breakdown` — persistMs, compressCacheMs, routeMs, totalOnlineMs
- `[Publish:Rust] batch completed` — metaMs, stringifyMs, jsonBytes, wallMs, flattenMs, chunkMs, enrichMs, serializeMs, compressMs, totalOffThreadMs, mainThreadMs
- `[R3] Batch processing started/completed` — batchSize, totalDurationMs, avgMsPerItem, concurrency
- `[Metrics] Publish cycle completed` — publishCycleDurationMs

## Bounded Batch Size (Anti-Snowball)

**Problem**: unbounded `take()` drains ALL accumulated messages. If a cycle takes longer than the production interval, the next cycle gets even more messages → snowball → IPC buffer-full disconnects.

**Solution**: `MAX_MESSAGES_PER_CYCLE = 20` constant in manager.ts. `batcher.takeUpTo(20)` takes at most 20 messages per cycle, leaving the rest. The `finally` block self-retriggers with `setImmediate` if messages remain.

**Math**: 20 messages × ~500 readings/msg = ~10K readings per cycle. At ~1s per bounded cycle, throughput is ~20 msgs/sec vs ~15 msgs/sec production rate → system keeps up.

## buildPayload() — CAUTION: Format Mismatch

`buildPayload()` creates a payload using `this.payloadFormat` (the **global** format, typically `'custom'`). But per-subscription routing uses each subscription's own `payload_format` (typically `'tags'`).

**Key issue**: The global cache key is `custom::global::fq=false` but per-subscription lookups use `tags::global::fq=false` — they never match. So:
- buildPayload's JSON.stringify is **completely wasted** (nobody reads it)
- persistClaimedBatch stores the wrong format for retry
- The Rust batch runs independently for each subscription

**Current optimization**: buildPayload **defers** its JSON.stringify (returns `jsonString: ''`). publishOnline skips `persistClaimedBatch` and global cache when `stringifyDeferred === true`. The error path in `handlePublishFailure` lazy-computes jsonString only when needed.

**If you change buildPayload**: Check whether the global format matches any subscription format. If they match, the cache hit path returns a single unchunked payload. If they don't match, the stringify is wasted.

## Payload Formats

| Format | Description | Used by |
|--------|-------------|---------|
| `custom` | Raw messages wrapped in `{timestamp, protocol, messages, msgId}` | Global `this.payloadFormat` default |
| `tags` | Flattened tag records: `{timestamp, node, group, tags[]}` | Most MQTT subscriptions |
| `ecp` | Like tags but deduped by name (snapshot semantics) | ECP destinations |
| `ml` | ML features: `{timestamp, node, group, schema, features[]}` | Dataset-linked subscriptions |

Format resolution: `resolvePayloadFormatForBinding()` reads `subscription.payload_format` and falls back to `this.payloadFormat`.

## Rust Publish Module (modules/publish/)

### Three NAPI entry points

1. **`process_batch_from_json(jsonBuf: Buffer, config: BatchConfig)`** — preferred path. Node.js does `JSON.stringify(messages)` → Buffer (V8 native C++, ~20-100ms) → NAPI Buffer passthrough (zero-copy pointer) → Rust `serde_json::from_slice` + `process_batch_impl` off-thread via `tokio::spawn_blocking`.

2. **`process_batch(messages: Value, config: BatchConfig)`** — legacy path. NAPI marshals JS objects to `serde_json::Value` property-by-property (~3μs/property × 20 props × 12K objects = ~720ms). **Do not use** — the JSON pre-serialization path is 30x faster on the main thread.

3. **`serialize_payload(payload, compress, level)`** — standalone JSON+zstd serialization. Used by the JS fallback path.

### Rust batch phases (process_batch_impl)

```
1. flatten_messages()     — unwrap .readings[] arrays into flat Vec<&Value>
2. chunk_readings()       — size-estimate + split into bounded chunks
3. per-chunk:
   a. enrich (tags/ml/custom envelope)
   b. serde_json::to_string (serialize)
   c. zstd::encode_all (compress, if enabled)
4. Return BatchResult { chunks[], timing, quarantined_count }
```

Thread naming: Rust threads show as `publish-batch` in `top` (via `prctl(PR_SET_NAME)`).

### When Rust path is used vs JS fallback

```typescript
const canUseRust = !overrideOpts?.useMsgpack && !overrideOpts?.useKeyCompaction;
```

Rust handles: tags, ecp, ml, custom formats with JSON or JSON+zstd compression.
JS fallback: msgpack encoding, dictionary key compaction.

## IPC Server (modules/ipc/)

- `PER_CLIENT_BUF_CAP = 64MB` — per-client write buffer limit. When exceeded: `[ipc] Client N buffer full (63.8MB), disconnecting`.
- `decode_batch_to_json()` — converts binary wire format v1 (bitmask with 15 bits for optional fields) to JSON before broadcasting.
- `broadcast_frame()` — sends to all connected Node.js clients.

**Buffer-full disconnects** happen when Node.js can't drain the socket fast enough. Root causes:
1. Socket paused too long during publish cycle (fixed: pause only during `takeUpTo`)
2. Publish cycle too slow → event loop can't read socket (fixed: deferred stringify, bounded batches)
3. Production rate exceeds consumption rate (fix: raise `MAX_MESSAGES_PER_CYCLE` or optimize per-cycle cost)

## Socket Backpressure

`SocketConnection.pause()` / `.resume()` controls whether Node.js reads from the IPC Unix socket. While paused, the IPC server's per-client buffer fills. If it exceeds 64MB → disconnect.

**Current strategy**: Socket is paused ONLY for the atomic `takeUpTo()` drain (~0ms). It stays unpaused during the entire publish cycle so the event loop can keep reading IPC data into the batcher.

## R3 MQTT Publisher (src/publish/plugins/mqtt.ts)

`MqttPublishPlugin.publishBatch()` publishes pre-chunked payloads concurrently:

- `MQTT_PUBLISH_CONCURRENCY = 4` — max in-flight publishes
- Uses `Promise.race()` to wait for a slot
- Yields to event loop every 50 items via `setImmediate`
- Logs: `[R3] Batch processing started/completed` with avgMsPerItem, successCount, failureCount

Typical: 44 chunks at 24ms avg = ~1s for the MQTT phase.

## Subscription/Binding Model

```
DevicePublish (src/publish/init.ts)
  └── PublishManager[] (one per endpoint config)
        ├── SocketConnection → MessageBatcher
        └── HostBinding[] (subscription × destination pairs)
              ├── subscription: PublishSubscriptionRecord (source filter, payload format, compression)
              ├── publisher: PublisherRecord (destination type, name, config)
              └── plugin: IPublishPlugin (MqttPublishPlugin, NoopPublishPlugin, etc.)
```

Each publish cycle iterates all bindings in `collectRouteEntries()`:
1. Resolve destination topic
2. Filter messages by source route (`filterMessagesForSourceRoute`)
3. Apply publish interval throttle (`filterMessagesForPublishInterval`)
4. Call `getCompressedPayloadForFormat()` for each non-noop binding
5. Collect `[plugin, batchItems[]]` entries
6. `Promise.allSettled()` to publish all entries

## Durable Buffer (Message Retry)

SQLite-based message buffer for reliability:
1. `persistClaimedBatch()` — stores payload before MQTT publish
2. On success: `MessageBufferModel.deleteByIds()` — removes buffer entry
3. On failure: `markRetryFailed()` — keeps entry for retry
4. On shutdown: marks in-flight as failed

**Current state**: When stringify is deferred (`jsonString === ''`), the durable buffer is SKIPPED. This is acceptable because:
- The buffer stored the wrong format (global vs per-subscription mismatch)
- IoT streaming data tolerates a lost batch on crash
- The error path (`handlePublishFailure`) lazy-computes jsonString if needed

## Compression Options

Set per-subscription via `subscription.compression`:
- `null` / not set → no compression (JSON string directly)
- `'deflate'` → zlib deflate
- `'zstd'` → zstd (Rust-side when using Rust batch)
- `'msgpack'` → MessagePack (forces JS fallback path)

Global compression check: `needsGlobalCompress = bindings.some(b => b.subscription.compression !== null)`.

## Schema Drift Detection

Runs inside `publishBatch()` between anomaly and buildPayload. Accumulates messages in `driftAccumulator`, observes every `DRIFT_OBSERVE_WINDOW_MS`. After first cycle where all metrics are skipped, the anomaly feed is bypassed (`anomalyFeedSkipped = true`).

## Activity Monitor

`activityMonitor.record()` / `.recordQualitySample()` / `.recordSubscriptionOnly()` — feeds the dashboard's real-time tiles. Called per-reading in `publishBatch()` (quality) and per-binding in `collectRouteEntries()` (subscription activity).

## Performance Reference (100K+ points)

| Metric | Typical Value | Notes |
|--------|--------------|-------|
| IPC production rate | ~15 msgs/sec (~7.6K readings/sec) | From OPC UA subscriber |
| Messages per IPC frame | ~500-850 readings | Each message wraps a `.readings[]` array |
| Bounded cycle size | 20 messages (~10K readings) | `MAX_MESSAGES_PER_CYCLE` |
| JSON.stringify (messages) | 20-110ms for 10-20K readings | V8 native C++, varies with payload size |
| Rust off-thread batch | 100-260ms for 10-17K readings | flatten + chunk + enrich + serialize |
| R3 MQTT publish | ~1s for 44 chunks at 4 concurrency | 24ms avg per chunk |
| Target cycle time | <2s for 20 messages | Enough to keep up with production rate |
| IPC buffer limit | 64MB per client | Disconnect if exceeded |

## Common Failure Modes

### IPC buffer-full disconnects
**Log**: `[ipc] Client N buffer full (63.8MB), disconnecting`
**Cause**: Node.js event loop blocked → can't read socket → IPC server buffer fills to 64MB
**Check**: Phase breakdown logs for which phase is slow. Usually buildPayload or R3 MQTT.

### Snowball effect
**Log**: `remainingInBatcher` growing each cycle, cycle times increasing
**Cause**: `take()` drains all messages → cycle takes longer → more accumulate → bigger next cycle
**Fix**: Ensure `takeUpTo(MAX_MESSAGES_PER_CYCLE)` is used, not `take()`

### Wasted buildPayload stringify
**Log**: `stringifyDeferred: false` with `globalPayloadFormat: 'custom'` but subscriptions use `'tags'`
**Cause**: buildPayload stringifies in the global format, but no subscription reads it
**Fix**: buildPayload should return `jsonString: ''` when the global format differs from subscription formats

### Rust mainThreadMs much larger than stringify + offThread
**Cause**: Event loop congestion delaying promise resolution. The wall time includes waiting for the `spawn_blocking` promise to resolve, which depends on event loop availability.
**Fix**: Reduce synchronous work earlier in the cycle to free the event loop.

### "Publish batch skipped: previous cycle still running"
**Log**: Appears with increasing `pendingMessages` count
**Cause**: Normal when socket is unpaused — new messages trigger flush events while a cycle is in progress. The `publishing` guard prevents overlap. Self-retrigger in `finally` picks up the backlog.
