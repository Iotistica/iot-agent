# Phase 2C-1: durable point identity integration design

**Status:** Phase 2C-1 is the design below. The user subsequently approved an
isolated Phase 2C-2 catalog with an injected, fail-closed verifier; see the
implementation note below. This does not authorize production catalog writes,
runtime integration, backfill, or changed contracts. The baseline is the current
uncommitted working tree, including Phase 1, 2A and the reviewed 2B patch. The preceding
[Phase 2 design](./phase2-point-identity-design.md) remains the architectural
baseline; where its illustrative SQL differs from the actual migration, the
migration is authoritative.

Throughout, **Verified** means inspected in the current tree or exercised by
the commands below; **Proposed** means future behavior; **Validate** marks an
unproven requirement or decision. Neither tests nor this design establish that
a deployed database, server or old binary has the same behavior.

### Phase 2C-2 implementation and review limits

**Verified:** [`PointIdentityCatalog`](../src/points/point-identity-catalog.ts)
is isolated and has no production verifier or runtime caller. Its synchronous
verifier receives an operation-specific request, including caller-supplied
evidence; only the literal boolean `true` admits the operation. Tests use
fixture verifiers, not protocol evidence. Without a verifier, writes and
alias-based reconciliation fail closed. Exact-address and alias listings remain
read-only. Strings reject NUL and malformed UTF-16 because Node's SQLite string
round trip can truncate at NUL. The service validates address version, size and
scope but **does not independently prove a key was produced by the canonicalizer**.
Any future verifier must check the resolved canonicalizer result, protocol
provenance, admission and all relevant identity evidence; a boolean alone is
not production evidence. Tests exercise a fixture-only admission token and
reject noncanonical keys, ambiguous legacy selectors and unadmitted candidates,
including caller-supplied `verified: true`. That fixture is not a production
authorization policy. Neither a syntactically valid key nor caller assertions
establish that a point is new or belongs to the source.

The service snapshots the complete persisted endpoint row before calling the
verifier and compares it under the transaction; it does not persist or log that
snapshot. This detects a changed row, not ABA changes, or changes to in-memory
configuration, protocol sessions, mappings, aliases, device evidence, or other
tables on which a verifier might rely. Those facts are not automatically
rechecked against the verifier's snapshot. A production verifier and a
transactionally enforceable freshness/authorization contract remain blocking
requirements for any runtime integration.
Expected write conflicts are returned as structured results and unexpected
errors are thrown; rate-limited operational diagnostics are not implemented and
must be designed with the future caller before rollout.

**Verified:** the actual connection is checked for `foreign_keys` and writes
check `query_only`; neither pragma is changed by the service. An old comment in
[`actions.ts`](../src/api/actions.ts) says foreign keys are never enabled, but
the current actual-connection tests observe them enabled; no global behavior
has been changed. `BEGIN IMMEDIATE` serializes writers; an exact committed
owner is reused, a second same-version address is rejected, and an existing
other version blocks creation. During write transactions the service retries only Node SQLite errors
with `code = ERR_SQLITE_ERROR` and primary `errcode = 5` (busy), at most three
times with short asynchronous delays; preliminary reads and verifier errors are
not retried. Other errors are surfaced. Each SQLite
call can still block for the connection's full busy timeout. A winner already
committed after contention is reread under the lock. Commit/FK failures roll
back and do not return a UUID. Association updates still require verification,
confirmed device evidence and compare-and-swap; when the current device and
authorized provenance are unchanged, the identity row is not rewritten.

**Read contention contract:** `resolveExistingIdentity` is synchronous and
intentionally does not retry or translate SQLite busy errors. An original SQLite
exception can propagate during the initial source read or the read transaction;
the latter is rolled back. Callers must handle this exception; it is not a
`busy` result. The integration tests exercise both lock locations using separate
real SQLite connections. The bounded structured `busy` result described above
applies to writes, not this synchronous read.

**Transaction limitation:** `DatabaseSync.isTransaction` is available starting
in Node 22.16.0. When present and true, this service rejects verified operations
before invoking the verifier; it also rejects verifier reentrancy on the same
connection. The current Node 22.14.0 has no such indicator. On that version,
SQLite rejects a nested `BEGIN`, the caller retains its outer transaction, and
the verifier may already have run inside it. Tests cover the current fallback
and simulate the exposed indicator; they do not establish behavior on another
Node binary. Callers must not use this service from an existing transaction.
Production use is prohibited until transaction ownership can be enforced
before verifier invocation and the evidence freshness limitations above are
resolved. No cross-process load or telemetry latency claim is established by
the fixture tests.

## 1. Executive summary

**Proposed:** introduce a small, isolated SQLite catalog with explicit read and
write operations. Its key is `(endpoint_uuid, protocol, address_version,
address_key)`; generate a random UUID only inside a successful write transaction,
and return it only after commit. Device association is optional, separately
verified metadata, never a component of point identity. A name, DeviceUUID,
endpoint display name or provisional name UUID is not proof of identity.

**Verified:** the schema and standalone canonicalizers exist but have no runtime
integration. Adapters commonly discard point addresses before IPC; JSON IPC
projects an allowlist and CSV has only six columns. Source UUID enrichment can
be missing, can be name-derived, and can substitute the source UUID for a
device UUID. A durable UUID cannot safely be attached to a downstream reading
by matching its metric name. BACnet additionally keys read results by object
name, so two object addresses can collide before serialization.

**Proposed:** 2C-2 tests the catalog in isolation; 2C-3 gathers trusted evidence
in a private, opt-in shadow path without changing IPC or telemetry; 2C-4
resolves only evidenced candidates internally. Unresolved telemetry continues
unchanged. Carrying a UUID through IPC or using it for publishing, anomaly,
historical storage, UI, or cloud requires separate approval and a compatible
reader-before-writer plan.

## 2. Verified implementation and baseline

| Area | Inspected behavior and references |
|---|---|
| SQLite | [`getDatabase`, `closeDatabase`, `transact`](../src/db/sqlite.ts#L5) use one lazy `DatabaseSync`, WAL, a 15,000 ms default busy timeout, optional `query_only`, and synchronous transactions. [`initialized`](../src/db/connection.ts#L12) runs migrations first; [`runMigrations`](../src/db/migration-runner.ts#L133) uses a migration lock and an immediate transaction per migration. `transact` does not support nesting. |
| Foreign keys | The current Node `DatabaseSync(':memory:')` reports `PRAGMA foreign_keys = 1`, SQLite 3.47.2; the [migration test](../test/integration/point-identity-migration.integration.spec.ts#L93) checks the real application connection. [`sqlite.ts`](../src/db/sqlite.ts#L5) does not explicitly set or recheck the pragma. This one observation does not establish every future connection's setting. |
| Catalog schema | [Migration](../src/db/migrations/20261114000000_add_point_identity.ts#L4) and [registration](../src/db/native-migrations.ts#L53) create only the three catalog tables and indexes. Addresses have a composite FK to `(point_uuid, endpoint_uuid, protocol)`; aliases reference `(point_uuid, endpoint_uuid)`. Address and alias keys use binary collation. No endpoint/device FK or cascade exists. Alias uniqueness does **not** include protocol, so application checks must also validate the parent protocol. |
| Sources | [`endpoints`](../src/db/template.sqlite.sql#L148) stores connection and points as JSON; `uuid` is nullable, and the template creates a [unique UUID index](../src/db/template.sqlite.sql#L416). [`getByUuid`](../src/db/models/endpoint.model.ts#L132) uses `LIMIT 1`; future identity code must validate a nonempty UUID, exactly one source row and protocol rather than assume every historical schema has that index. [`updateEndpointRow`](../src/db/models/endpoint.model.ts#L292) changes `updated_at` on generic updates; it is not a dedicated, proven configuration revision. |
| Discovery | [`DiscoveryStore.save`](../src/discovery/db.ts) and [`DiscoveryService`](../src/discovery/service.ts#L190) preserve configuration and constrain pruning by scan status. Discovery is not an authoritative full configuration inventory. |
| Naming | [`computeProvisionalPointId`](../src/points/identity.ts#L28) uses protocol, endpoint **name**, device key and raw name. [`PointNameCatalog.resolve`](../src/points/catalog.ts#L121) uses an in-memory cache and deferred persistence; it selects a stored mapping only when rules versions match, even if locked. [`PointNameMappingsModel`](../src/db/models/point-name.model.ts#L43) has nullable `source_system` and a `LIMIT 1` lookup; enumerate candidates for reconciliation. Never modify mapping rows or assume locked-name behavior beyond current code. |
| Device evidence | [`DeviceResolutionStore.confirm`](../src/discovery/device-resolution-store.ts#L67) uses source-scoped confirmed keys and point addresses under `IMMEDIATE`, and rejects conflicting point owners. Its records and device enabled states remain untouched by the proposed catalog. An external device tag, internal device UUID, synthetic endpoint fallback and confirmed physical equipment are different things. |
| Canonicalizers | [`canonicalizeAddress` and `canonicalizeModbusAddresses`](../src/points/canonical-address.ts#L282) return resolved keys or reasons, perform no catalog I/O, and rely on caller assertions for namespace, selector, network and inventory evidence. |
| IPC and publishing | [`DeviceDataPoint`](../src/plugins/types.ts#L18) lacks canonical address/point UUID. [`wireAdapterEvents`](../src/plugins/index.ts#L277) enriches then sends; [`formatAsJson`/`formatAsCsv`](../src/core/socket-server.ts#L900) drop unlisted fields. [`MessageBatcher.addMessage`](../src/publish/core/batch.ts#L180) parses JSON; [`PublishManager.publishBatch`](../src/publish/core/manager.ts#L702) runs naming/unit/quality and anomaly before output. [`mapTagPayload`](../src/publish/core/manager.ts#L1185) emits legacy provisional IDs/names; custom formats require separate review. |
| Consumers | [`AnomalyFeed.readPointIdentity`](../src/publish/anomaly/feed.ts#L142) requires legacy normalized name and device key; [TimescaleDB publisher](../src/publish/plugins/timescaledb.ts#L303) still uses normalized metric and legacy extras. [Activity monitor](../src/publish/core/activity-monitor.ts#L78), saved views and dataset APIs use name-based point keys. No consumer is migrated here. |

The current [Phase 2A integration fixture](../test/integration/point-identity-migration.integration.spec.ts#L10)
tests existing records, actual SQLite constraints, rollback and reopen. It
does not execute an older application binary. The
[canonicalizer tests](../test/unit/points/canonical-address.unit.spec.ts)
exercise collisions and malformed evidence, not live protocol integrations.
CSV output is not evidence that the publisher's JSON-only batch parser accepts
CSV. [`buildPayload`](../src/publish/core/manager.ts#L815) includes whole
message objects for custom output, so an added downstream field could leak
externally even if tag projections omit it. The
[MQTT topic template](../src/publish/plugins/mqtt.ts#L121) uses legacy context,
not the proposed UUID.

## 3. Phase 2B execution verification

**Verified on this working tree**, using PowerShell from `C:\Users\Dan\iot-agent`.
Each test invocation set `DATABASE_PATH` to a separate file under this session's
`files` directory, not a production database. Migration tests also create their
own temporary databases. The counts below are from this run.

```powershell
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.build.json
npm run lint
npx eslint --parser-options project:./test/tsconfig.json test\unit\points\canonical-address.unit.spec.ts
$env:DATABASE_PATH='C:\Users\Dan\.copilot\session-state\9f165ade-3b77-4328-a779-0d3828140c37\files\phase2c-design-unit.sqlite'
npx jest --config jest.config.unit.js --runInBand 'canonical-address.unit.spec.ts|service.unit.spec.ts|mqtt-discovery.unit.spec.ts' --silent
$env:DATABASE_PATH='C:\Users\Dan\.copilot\session-state\9f165ade-3b77-4328-a779-0d3828140c37\files\phase2c-design-integration.sqlite'
npx jest --config jest.config.integration.js --runInBand 'point-identity-migration.integration.spec.ts|endpoint-device-enabled.integration.spec.ts' --silent
$env:DATABASE_PATH='C:\Users\Dan\.copilot\session-state\9f165ade-3b77-4328-a779-0d3828140c37\files\phase2c-design-node.sqlite'
node --import tsx --test test\unit\devices\opcua\opcua-device-identification.test.ts test\unit\devices\opcua\opcua-device-snapshot.test.ts test\unit\devices\opcua\opcua-discovery-safety.test.ts
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');console.log('foreign_keys:',d.prepare('PRAGMA foreign_keys').get().foreign_keys,'sqlite:',d.prepare('select sqlite_version() as v').get().v);d.close()"
```

Results: TypeScript and both lint commands passed. Unit Jest: **4 suites,
136/136 tests** (including **80** canonicalizer tests; the filename pattern
also selected command-service tests). Integration Jest: **2 suites, 56/56**
(9 migration and 47 discovery/device tests). Node: **11/11**. No failures
were observed in these commands. SQLite emitted its experimental warning and
the unit Jest configuration uses `forceExit`. A full suite and the separate
test-project-wide TypeScript check were not run in this task; prior failures
in broader checks cannot be attributed to this design or independently
classified as baseline here. Phase 2B remains subject to independent review;
these results do not prove live adapter integration.

## 4. Proposed internal catalog contract

**Proposed conceptual contract:** place the database-facing service in
`src/points/point-identity-catalog.ts`, taking the existing `DatabaseSync`
through a constructor or `getDatabase()` after initialization; test injection
uses the same API. Avoid a new connection pool. Do not overload the existing
`PointNameCatalog` or its `PointIdentity` type.

```ts
type Scope = { endpointUuid: string; protocol: AddressProtocol };
type Address = Scope & { version: number; key: string };
type Identity = Scope & { pointUuid: string; deviceUuid: string | null };
type Reason =
  | 'not-found' | 'source-missing' | 'source-ambiguous' | 'protocol-mismatch'
  | 'invalid-address' | 'evidence-missing' | 'identity-ambiguous'
  | 'alias-conflict' | 'address-conflict' | 'association-conflict'
  | 'version-unreconciled' | 'stale-configuration' | 'foreign-keys-disabled'
  | 'busy' | 'database-unavailable';
type Result<T> =
  | { status: 'resolved'; value: T }
  | { status: 'unresolved'; reason: Reason; retryable: boolean };

// Conceptual only: evidence must originate from a reviewed verifier, not merely
// a public boolean or an unchecked type assertion.
type VerifiedAddress = { address: Address; provenance: AddressProvenance;
  evidenceRef: string; snapshotToken: string };
type VerifiedAlias = { scope: Scope; kind: string; key: string;
  evidenceRef: string };
type VerifiedAssociation = { scope: Scope; deviceUuid: string | null;
  expectedDeviceUuid: string | null; evidenceRef: string };

findByCanonicalAddress(address: Address): Result<Identity>;
resolveExistingIdentity(address: VerifiedAddress, aliases: VerifiedAlias[]): Result<Identity>;
createIdentityIfAbsent(address: VerifiedAddress, admission: NewPointAdmission): Result<Identity>;
attachVerifiedAddress(pointUuid: string, address: VerifiedAddress, equivalence: Evidence): Result<Identity>;
findAliases(scope: Scope, pointUuid: string): Result<VerifiedAlias[]>;
attachVerifiedAlias(pointUuid: string, alias: VerifiedAlias): Result<Identity>;
updateOptionalDeviceAssociation(pointUuid: string, association: VerifiedAssociation): Result<Identity>;
```

`NewPointAdmission` and `Evidence` below were deliberately unspecified opaque
capabilities in the design: a TS brand alone is not evidence. The isolated
implementation instead uses the verifier interface and asynchronous writes
described above; the pseudocode is not its exact signature. The verifier
must establish the actual endpoint, supported canonical version, trusted
protocol evidence and current configuration/session token. The result of
canonicalization must be `resolved`, with matching protocol/version/key; validate
nonempty identifiers, key size and exact binary comparisons. Unknown protocol,
unsupported version, unsafe legacy candidate, or malformed input is unresolved.
No UUID is generated for it.

- `findByCanonicalAddress` and `findAliases` are read-only and never create,
  attach, reassign, or update timestamps. `resolveExistingIdentity` is also
  read-only: it enumerates all supplied verified aliases plus the exact
  address, checks scope and agreement, and returns unresolved if owners differ.
  An alias match without an independently verified address-to-alias relationship
  is not sufficient. `not-found` is not proof that creating a new point is safe.
- `createIdentityIfAbsent` is the **only** ordinary creation operation. It
  requires an explicitly authorized new-point admission policy, no unresolved
  historical/alias conflict, and a still-current evidence token. If an exact
  address already exists it returns that committed owner only after validating
  continuity and scope. No automatic backfill, merging, or version transition.
- Attach operations require explicit verified one-to-one equivalence and check
  every existing owner. Already attached to the same owner is idempotent;
  ownership by another point is a conflict, never `UPDATE`, `REPLACE`, or
  `ON CONFLICT DO UPDATE`. Alias lookups check parent protocol as well as
  endpoint because the alias schema enforces only endpoint scope.
- Association changes use compare-and-swap on `expectedDeviceUuid`, require an
  existing confirmed internal `devices.uuid` in the same source and appropriate
  evidence/authorization; clearing or reassignment needs explicit authorization.
  Never copy the legacy endpoint fallback, alter `device_resolution_*`, or
  infer equipment from membership. `association_source` records provenance,
  not the evidence itself. If evidence cannot be validated, leave the prior
  association unchanged and return unresolved.
- Expected ambiguity and bounded contention produce structured unresolved
  results and structured, rate-limited diagnostics without secrets. Unexpected
  integrity/programming errors are logged and surfaced as errors, not
  success-shaped fallbacks. Legacy telemetry processing remains separate.

**Validate:** the trust capability and evidence storage format, caller
authorization, whether a caller can ever prove a truly new point rather than an
unrecorded address change, and whether reconciliation needs a separately
approved durable audit ledger. No evidence is persisted by the current
`point_identity_address` schema; `point_identity_alias.evidence` is a nonempty
text field, not by itself proof.

## 5. SQLite lifecycle, transaction and concurrency

**Proposed:** run catalog operations only after `initialized` succeeds.
Immediately before any catalog operation, including after close/reopen, read
`PRAGMA foreign_keys` on the actual connection. If not `1`, fail closed with
`foreign-keys-disabled`; do not silently rely on declarations or toggle a
global pragma inside a transaction. Check `query_only` for writes. An injected
test or future connection must pass the same check. Existing singleton
lifecycle remains in charge of shutdown; invalidate any cache on database
close/reopen, configuration change or failed commit. Prefer no cache in 2C-2.

For create/attach/association, use one synchronous `transact(db, fn,
'IMMEDIATE')`, with no `await`, network work, user callbacks or reentrant
catalog calls inside `fn`:

1. Validate inputs and evidence outside the transaction; begin the immediate
   transaction, then recheck the source by enumerating all UUID matches, its
   protocol, evidence freshness/configuration token, exact address, aliases,
   version and intended device under the same lock.
2. If the verified address already has one safe owner, return that existing
   owner only after transaction completion. Conflicting owners abort.
3. If absent and explicitly admitted as new, generate UUIDv4 **inside the
   transaction after these checks**. Insert `point_identity`, then its scoped
   address, then only separately authorized aliases. Check affected rows.
4. Commit; only then return/cache the UUID. Roll back the entire unit on any
   insert, FK, scope, stale-evidence or commit failure. Never emit a generated
   UUID from an uncommitted path. After an uncertain commit outcome or broken
   connection, return no UUID until a fresh connection re-reads the exact
   scoped address and verifies the committed owner.

Concurrent writers serialize at `BEGIN IMMEDIATE`; the unique address key is
the final arbiter. A losing writer rolls back and rereads the exact key after
the winner commits, subject to all evidence checks. Retry only classified
`SQLITE_BUSY`/contention or the narrowly recognized uniqueness race, outside
the transaction, with a bounded attempt/deadline and jitter. Return `busy`
with `retryable: true` when exhausted; do not retry FK violations, conflicts,
malformed evidence or unknown errors as if transient. Do not return an ID on
rollback. The shared `DatabaseSync` call can block the event loop for the
existing busy timeout (default 15 seconds); a deadline cannot preempt a
synchronous SQLite call. Measure this before rollout; changing a global timeout
or introducing a worker/connection requires separate review. No writes on each
telemetry reading by default.

`transact` issues a new `BEGIN`, not a savepoint. Reject nested/reentrant
catalog transactions explicitly; internal helpers accept the already-owned
transaction and must not start another. Do not call the service from migration
callbacks or other `transact` callbacks. Lock order, multi-process races, busy
timeout, commit uncertainty, and `closeDatabase`/reopen need integration tests.
There is no automatic UUID reuse after source deletion/recreation, or after an
unverified address change/version upgrade.

## 6. Legacy reconciliation decision table

**Proposed:** inspect mappings, all aliases, source configuration and confirmed
device evidence read-only. Never use name, `LIMIT 1`, DeviceUUID or a generated
provisional UUID alone to prove equivalence. Preserve full mapping rows,
manual/locked names, anomaly references and evidence. Explicit review means a
future authorized operation with auditable equivalence, not a name-based guess.

| Situation | Decision |
|---|---|
| Exact verified address, same unique live source and continuity, no conflicts | Reuse existing committed UUID; no mapping changes. |
| Verified legacy alias and independently proven one-to-one address relationship | Reuse its owner; attach missing address/alias only through explicit verified transaction. |
| Alias owners disagree, or alias scope/protocol conflicts | Unresolved; manual review, preserve all owners. Never merge. |
| Same name, different verified addresses | Distinct address candidates; name does not authorize merge or creation without new-point admission. |
| Same address, different names | Existing exact address may be reused only with continuity evidence; retain both legacy mappings. Names alone cannot prove one point or two. |
| Device absent/added/reassigned | UUID unchanged. Verified optional association is separately authorized and compare-and-swap; conflicts remain unchanged. |
| Source deleted then recreated with a new UUID | Old identities remain historical; no cross-source reuse by name/address. Explicit migration is a later approval. |
| Ambiguous historical rows, duplicate NULL-source mappings, or same legacy ID mapping to multiple points | Unresolved; do not rewrite or backfill. |
| Missing canonical address | Unresolved; continue legacy behavior, no UUID. |
| Canonical version change | Block new-version creation until explicit evidence maps old and new addresses to one owner atomically; conflict requires review, never silent split. |

The current schemas have no deletion generation or address retirement marker.
**Validate:** policy for source UUID reuse, replacement equipment at the same
address, legitimate readdressing and how to prove a new candidate is not an
unrecorded legacy point. Same address alone does not establish physical
continuity after a server/device replacement.

## 7. Protocol evidence matrix

No current location below supplies *all* required trusted evidence; these are
the earliest candidate collection points, not proof that integration is ready.

| Protocol | Verified collection points | Missing evidence and proposed gate |
|---|---|---|
| OPC UA | [`doConnectDevice`](../src/plugins/opcua/adapter.ts#L1225) obtains a live session and [`validateNodeIds`](../src/plugins/opcua/adapter.ts#L540) reads configured NodeIds; subscription callback has `dp.nodeId` and indexed monitored item ([adapter](../src/plugins/opcua/adapter.ts#L810)); polling has paired `validDataPoints[i]` and `dataValues[i]` ([adapter](../src/plugins/opcua/adapter.ts#L1820)). [`collectOpcuaDeviceSnapshot`](../src/plugins/opcua/device-snapshot.ts#L12) demonstrates a Good NamespaceArray read at `ns=0;i=2255`. | A future verifier must read that array in the *same* authenticated session as each verified node, validate index/URI and namespace zero, bind to the exact endpoint UUID despite pooled sessions, and prove server identity and reconnect continuity. [`OPCUADeviceClient.connect`](../src/plugins/opcua/client.ts#L105) can check an expected thumbprint but that option is not universal proof. On remap use verified URI; missing old binding, changed server or ambiguous ExpandedNodeId stays unresolved. Historic index alone is insufficient. |
| MQTT | [`handleMessage`](../src/plugins/mqtt/adapter.ts#L1066) knows concrete received topic, parsed payload and selected raw value; [`compileMetricPath`](../src/plugins/mqtt/adapter.ts#L221) creates string segments and [`getFieldFast`](../src/plugins/mqtt/adapter.ts#L724) uses JS property access. [`findDeviceForTopic`](../src/plugins/mqtt/adapter.ts#L615) chooses the first matching filter. | Resolve the configured source UUID without name-only guessing; distinguish filter from concrete topic; derive typed tokens from the actual traversal and container types. Legacy dotted paths and literal dots cannot be inferred. Shape changes, missing fields, fallback `value` vs whole payload and overlapping subscriptions require explicit policies; absence is not deletion. Queue/enrichment clones must retain any private correlation. |
| Modbus | [`startModbusAdapter`/group](../src/plugins/index.ts#L583) use endpoint rows plus [`normalizeModbusRegisters`](../src/plugins/modbus/types.ts#L163), or explicit application configuration in the non-group path. [`readAllRegisters`](../src/plugins/modbus/client.ts#L369) holds the register beside each direct/batch result; [`readRegister`](../src/plugins/modbus/client.ts#L1116) uses wire address/count. | Obtain the exact active configuration for the same unique source UUID, including disabled configured points, all relevant units and address spaces. Use normalized FC, unit, direct address and full count/width. `{complete:true}` is merely an assertion. Derive a stable fingerprint over the relevant raw and effective configuration, excluding secrets from diagnostics, and validate it at commit under `IMMEDIATE`; for explicit in-memory config require an adapter generation token plus coordination preventing changes through commit. If atomic coordination cannot be established, defer. `updated_at` alone is not a revision. Batch end uses the last point rather than maximum end for overlapping configurations ([client](../src/plugins/modbus/client.ts#L690)); reject overlaps, do not fix adapter here. |
| BACnet | Discovery samples at most 50 objects ([discovery](../src/plugins/bacnet/discovery.ts#L805)); [`readObject`](../src/plugins/bacnet/client.ts#L181) has configured address/type/instance and effective property, while [`pollDevice`](../src/plugins/bacnet/adapter.ts#L357) emits points. | Prove source UUID, actual device instance and uniqueness within the relevant network/routing scope, not merely IP or `deviceInstance` in JSON. Config construction chooses `deviceId`/`deviceInstance` differently by startup path ([group](../src/plugins/index.ts#L1274)). Property 0 is defaulted to 85; arrays are not supported. `readObjects` maps by name ([client](../src/plugins/bacnet/client.ts#L255)), so duplicate names prevent reliable per-reading association even if address evidence was collected earlier. |

## 8. Verified field flows and proposed attachment boundary

```mermaid
flowchart LR
 C[Endpoint JSON and discovery candidates] --> A[Adapter configured address + value]
 A --> E[DeviceDataPoint: metric/value and optional device fields]
 E --> M[AdapterManager name-based source enrichment]
 M --> S[Socket JSON allowlist or six-column CSV]
 S --> B[Batcher JSON parse]
 B --> N[Legacy name, unit and quality interceptors]
 N --> P[Anomaly and legacy publisher projections]
 A -. future verified private evidence .-> H[Opt-in in-process shadow resolution]
 H -. no new IPC or payload field .-> D[Committed catalog]
```

| Representative path | Available before emit; transformed/dropped at emit and IPC | Earliest safe **candidate**, not current support |
|---|---|---|
| OPC UA discovery/config → subscription or polling → manager → IPC → publish | `dp.nodeId`, session and owning config exist at `createSubscription`/`readDeviceData`; output has `metric=dp.name`, optional source device tag and protocol, **not NodeId**. Manager maps by device name and may lack the shared endpoint UUID. Socket does not carry NodeId. | After same-session namespace and server/endpoint verification, pair evidence with the exact indexed callback/read result before constructing the point; retain safely across batching/cloning. Without that proof leave unresolved. |
| MQTT config/filter → concrete topic → configured/auto/fallback extraction → queue → manager → IPC → publish | `handleMessage` knows concrete topic, payload and path; `buildMetricPoint` returns metric/value and optional payload `deviceId`, not concrete topic or typed selector as address. `enqueueData` can clone; filter matching chooses first match. | At actual selected-value extraction after typed traversal and unique source binding, before `buildMetricPoint`/queue. Payload `deviceId` is not confirmed physical DeviceUUID. Missing/shape-changing fields are unresolved. |
| Modbus endpoint → normalized device/register → direct or batch read → manager → IPC → publish | `readAllRegisters` sees register, unit from device config and result, but returns `metric=register.name` without address. Adapter enrichment may clone; manager fills endpoint/device fields via name. | After stable complete effective inventory proof and at the register/result pairing before construction, including error/fallback paths. A single address resolution without full inventory is insufficient. |
| BACnet discovery/config → `readObject` → `readObjects` name map → `pollDevice` → manager → IPC → publish | `readObject` sees object and effective property; `readObjects` indexes results by `obj.name`, then `pollDevice` reads them back by name and emits metric/value without address. Discovery is sampled. | Address-level shadow resolution can occur after validated config/network evidence, but **do not attach it to a reading** when duplicate names or result correlation are ambiguous. A safe per-object result association needs separately reviewed correction. |

The shared manager's [`resolveEnrichedDeviceName`](../src/plugins/index.ts#L112)
uses name lookup and falls back to `endpointUuid` as `device_uuid` when no
source device ID exists. This legacy behavior is preserved, not treated as
confirmed equipment and not copied into the new catalog.

**Proposed:** a private evidence event/envelope at the precise adapter
correlation point can feed a shadow observer in the same agent process. Keep
the existing `data` event, JSON/CSV frames and published records byte-for-byte
unchanged; no name/time join after IPC. Test clone, batching, queue, retry,
error and hot-reload paths. A sidecar must not rely on object identity after a
spread/serialization. The existing IPC is an observable consumer boundary even
within one process: attaching a field to `DeviceDataPoint` alone is ineffective
and extending frames could break clients. A cross-process or downstream UUID
requires a separately approved private transport and reader-before-writer
contract; until then the downstream pipeline has no durable UUID.

## 9. Failure, compatibility and rollback

| Failure/event | Proposed behavior; legacy runtime always continues unchanged |
|---|---|
| SQLite unavailable/query-only/FK off | Surface structured error; no create/attach and no fabricated UUID. Read-only lookup only if its prerequisites are valid. |
| SQLite busy | Bounded retry outside transaction; after timeout unresolved/retryable. Account for blocking busy timeout. |
| Transaction or commit failure | Roll back, never expose generated UUID; if outcome uncertain re-read committed exact owner before reporting success. |
| FK violation, duplicate address, conflicting alias | FK is an error; same verified committed owner is idempotent, different owner is unresolved and requires review. No overwrite. |
| Invalid canonicalization or missing evidence | Unresolved; defer creation, retain legacy telemetry. |
| OPC UA reconnect/remap | Reuse only if same trusted server and URI binding/continuity are proven; otherwise unresolved. |
| MQTT payload shape or selector changes | Resolve only with the actual typed selector and safe continuity policy; ambiguous shape remains unresolved, never silently merge/split. |
| Modbus config changes during resolution | Recheck fingerprint/generation under coordinated lock; stale means retry from a new complete snapshot or defer. |
| BACnet network ambiguity | Defer; operator/network evidence needed. |
| Source deletion/recreation | Preserve catalog; a new source UUID is a new scope. No automatic restoration by name. |
| Mixed old/new binaries | Old code ignores additive tables and may mutate config without maintaining identities. Disable creation/reassociation while an older writer can run, then revalidate after upgrade; do not infer continuity from timestamps. |
| Phase 2A database or code rollback | Keep schema/data in place and disable new behavior. Schema fixture supports old-table access, but actual old-binary compatibility is **not verified**. No destructive down migration. |

Do not change MQTT topics/payloads, IPC, endpoint/device IDs, names, locked
mappings, device evidence, anomaly baselines, saved views, TimescaleDB or cloud.
Existing unidentified telemetry may already contain the endpoint fallback as
`device_uuid`; this phase must not introduce it into the catalog and cannot
claim that legacy output is device-free. Future external changes need all
readers and deployed schemas inventoried, reader-before-writer rollout,
golden contracts and rollback. Existing name-based historian collision risks
are not repaired by adding a local UUID.

## 10. Independently reviewable implementation plan

All paths below are **expected proposals**, not authorization to edit them.

### Phase 2C-2: isolated catalog service

- **Dependencies:** independently approve 2B execution and this design; agree
  evidence/admission and transaction contracts. Use existing 2A tables only.
- **Expected files:** new `src/points/point-identity-catalog.ts`, focused
  `test/integration/point-identity-catalog.integration.spec.ts` and, if useful,
  `test/unit/points/point-identity-catalog.unit.spec.ts`. Reuse existing
  `src/db/sqlite.ts` API without changing its global behavior.
- **Excluded:** migrations, adapters, discovery, naming, IPC, publishing, UI,
  cloud and anomaly. No startup registration, production backfill or runtime
  callers. Fixture-only APIs described in section 4 are explicit read/write.
- **Acceptance:** real temporary SQLite proves scoped lookups, no implicit
  creation, transactional rollback, concurrency, active FK checks, busy and
  restart behavior, alias conflict and association CAS. Compare old rows.
  No uncommitted UUID is returned. Rollback removes the unused service code;
  tables remain. Open: source existence/duplicate checks and admission token.

### Phase 2C-3: trusted protocol evidence

- **Dependencies:** 2C-2 reviewed; per-protocol trust and snapshot policies
  approved. Enable only isolated opt-in shadow evidence, no UUID creation.
- **Expected files:** `src/plugins/index.ts` and the specific paths under
  `src/plugins/opcua/adapter.ts`, `opcua/client.ts`, `mqtt/adapter.ts`,
  `modbus/adapter.ts`/`client.ts`, `bacnet/adapter.ts`/`client.ts`, plus
  focused existing or new `test/unit/devices/` and protocol tests. Actual
  selection depends on approved correlation strategy.
- **API:** private verified evidence envelope with endpoint UUID, typed
  canonicalizer input, evidence provenance and session/config generation;
  explicit unresolved reason. Never put evidence into legacy serialized data.
- **Excluded:** schema, `SocketServer` framing, publish/anomaly/cloud/UI,
  backfill, device-resolution mutation. Tests use mock sessions/messages and
  configuration snapshots, plus golden existing event/frame payloads.
- **Acceptance:** verify all four protocol boundaries, hot reload/reconnect,
  nonblocking failure and no change to legacy output. Ambiguous BACnet
  name-mapped results and untrusted endpoints remain unresolved. Roll back
  by disabling/removing shadow evidence. Open: trusted server identity,
  source binding, config generation and BACnet network uniqueness.

### Phase 2C-4: internal resolution

- **Dependencies:** independently approve 2C-3 evidence and an explicit
  no-silent-backfill/new-point admission policy.
- **Expected files:** catalog service and its tests, private observer/integration
  near `src/plugins/index.ts` and approved protocol evidence producers; add
  integration tests for exact internal association and catalog persistence.
  Do not assume IPC or `PublishManager` can correlate readings by names.
- **API:** opt-in resolve-existing, followed by explicit admitted create or
  verified attachment; structured unresolved and bounded contention. Internal
  committed UUID may accompany only the proven in-process association.
- **Excluded:** external/IPC payload fields, consumers, cloud, schema changes,
  automatic backfill and device identification. Acceptance: restart and
  concurrency tests, unchanged output goldens, no UUID for unresolved inputs,
  measurable error and blocking budgets. Roll back by disabling the feature;
  retain additive catalog rows. Address version changes, operators and
  downstream transport remain separate approvals.

## 11. Proposed regression matrix

All are future tests, not claims of support. `U` = unit, `I` = temporary
SQLite/in-process integration, `E` = end-to-end. Mock sessions, brokers and
protocol clients suffice unless noted. Every test checks that legacy fields and
stored evidence are not mutated.

| # | Scenario | Level and fixture/assertion |
|---|---|---|
| 1 | Same address after restart | I: file-backed SQLite, close/reopen; same committed UUID. |
| 2 | Reconnect | I: fake session reconnect with trusted continuity; same UUID, otherwise unresolved. |
| 3 | Point rename | I: same verified address, new label; same UUID and unchanged mapping rows. |
| 4 | Device reassociation | I: authorized CAS changes optional association only; conflict unchanged. |
| 5 | No DeviceUUID | I: NULL association; no fabricated endpoint-as-device. |
| 6 | Same address, different endpoints | I: two source UUIDs; distinct owners. |
| 7 | Same address string, different protocols | I: distinct scoped owners; alias parent protocol verified. |
| 8 | Concurrent creation | I: separate real connections/processes race; one committed winner. |
| 9 | Busy contention | I: held writer lock, bounded wait/retry, no unpersisted UUID or event-loop budget claim. |
| 10 | Transaction rollback | I: inject failure after parent/address/alias and at commit; no partial rows. |
| 11 | Verified legacy alias | I: seeded mapping plus explicit one-to-one evidence; reuse without rewriting mapping. |
| 12 | Conflicting aliases | I: two existing owners and NULL-source duplicates; unresolved, no merge. |
| 13 | Locked name | I: locked/manual row with old rules version; row and legacy output unchanged; test current name behavior separately. |
| 14 | OPC namespace remap | U/I: fake same trusted server and URI at changed index; same owner. |
| 15 | Missing OPC evidence | U/I: missing NamespaceArray, mismatched server or remote ambiguity; unresolved. |
| 16 | MQTT wildcard | I: mock filter with two concrete topics, no filter-as-address. |
| 17 | MQTT selector ambiguity | U/I: literal dots, object numeric keys vs arrays, missing field and shape change; unresolved where unproved. |
| 18 | Modbus overlap | U/I: coil/discrete and 16/32-bit spans, separate units/spaces; both overlaps unresolved. |
| 19 | Modbus concurrent config update | I: snapshot then edit before commit; stale/deferred; include disabled points and explicit config path. |
| 20 | BACnet network ambiguity | U/I: duplicate instance across networks and duplicate object names; no guessed association. |
| 21 | Source deletion/recreation | I: preserved old catalog and new endpoint UUID; no automatic reuse. |
| 22 | Telemetry payload compatibility | I/E: golden MQTT/custom/tag/Timescale payloads and topics with feature off/on; byte/field equivalence. Mock publishers. |
| 23 | IPC compatibility | I: existing JSON single/batch, CSV, subscription and legacy consumer goldens; no field or framing change. |
| 24 | Old binary after migration | E: actual previous binary against copied migrated DB with old-table reads/writes; requires approved prior binary fixture, no physical device. |
| 25 | Address-version continuity | I: v1/v2 verified alias mapping and conflict; no second identity until explicit reconciliation. |

Additional tests: disabled FK on injected connection, query-only mode, invalid
source/duplicate source UUID, failed/partial discovery, unsupported canonical
version, schema retained on rollback, session/queue clone correlation,
read-only lookup causes no writes, and no catalog activity until feature
approval. Real OPC UA server/cloud integration and deployed schema verification
are separate gates; mock success is not a production interoperability claim.

## 12. Unresolved decisions and risks

1. How to prove new-point admission and address continuity without a durable
   history, especially after server replacement or mixed-version operation.
2. How to authenticate OPC UA server identity when thumbprint pinning is not
   configured, bind pooled sessions to source UUIDs, and remap legacy NodeIds.
3. MQTT wildcard cardinality limits, typed traversal for changing payload
   shapes, overlapping filters and exact fallback equivalence.
4. A configuration snapshot/generation mechanism that is atomically valid
   across SQLite rows, explicit in-memory adapter configuration and hot reload.
5. BACnet network scope evidence and the name-keyed read-result collision;
   correcting that behavior is outside this design authorization.
6. Alias evidence format, operator authorization/audit, source UUID uniqueness,
   address version transitions and source deletion/reuse policy.
7. SQLite synchronous blocking at the existing busy timeout; performance and
   failure isolation before any high-rate telemetry integration.
8. Legacy endpoint-as-device fallback, locked-name rules-version behavior,
   historical name collisions, anomaly/view compatibility and old-binary
   behavior remain existing limitations, not solved by this catalog.
9. External contract changes and access to deployed cloud schemas require
   separately approved reader-before-writer validation.

## 13. Explicit approval gates

1. Independent review of Phase 2B compatibility, execution results and this
   document preceded isolated Phase 2C-2 approval.
2. The user approved a fail-closed verifier interface with test-only
   implementations. Review the isolated 2C-2 patch and resolve its documented
   production evidence and transaction-ownership gaps before any runtime caller.
3. Separately approve protocol-specific evidence and configuration/session
   provenance for 2C-3; no unverified `true` flags or changed IPC/output.
4. Separately approve 2C-4 creation policy, operational contention limits and
   shadow rollout; no automatic legacy backfill or identity merging.
5. Separately approve any IPC, telemetry, anomaly, UI, cloud, historical
   migration or real production database operation, with compatibility tests
   and rollback. Stop when evidence is ambiguous.
