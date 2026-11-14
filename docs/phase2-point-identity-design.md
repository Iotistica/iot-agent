# Phase 2 design: durable source-scoped point identity

Status: **design only; approval required**. The baseline is the current working
tree, including the uncommitted Phase 1 safeguards, not HEAD alone. No Phase 2
implementation, schema migration, backfill, or consumer change is implied by
this document.

Throughout, **Verified** describes code inspected in this working tree;
**Proposed** is a design choice, not existing behavior; **Validate** identifies
an assumption or decision that must be resolved before implementing it.

## 1. Executive summary

**Proposed.** Give each reliably addressed point a random, persisted Point UUID.
Resolve it by the existing endpoint UUID, protocol, and a versioned canonical
protocol address. Device/asset association is optional contextual metadata;
neither a name nor a device identifier participates in point uniqueness. A
source rename, point rename, or device reassignment must not change the Point
UUID. Keep legacy naming, anomaly, API, and publishing contracts untouched
until their own compatibility changes are approved.

**Verified.** The current `PointNameCatalog` is a naming cache with a
deterministic *provisional* ID, not a persistent source/address point catalog.
Some readings lack both the correct source UUID and protocol address when
they arrive at the normalization pipeline. Legacy enrichment may also put an
endpoint UUID in the `device_uuid` field. A new SQLite table alone cannot
deliver end-to-end point-first telemetry or safely distinguish that fallback
from a real device.

**Proposed sequencing.** Ship the additive schema first, with no reads, writes,
or backfill. Implement and test address canonicalization separately. Integrate
only where endpoint and address provenance are demonstrably reliable, with
legacy output unchanged. Treat IPC, anomaly, UI, and cloud changes as separate
compatibility decisions, not an implicit authorization to modify them.

## 2. Current lifecycle and findings

### Discovery and source configuration

- **Verified:** `OPCUADiscovery.discover`, Modbus, MQTT and BACnet discovery
  produce endpoint candidates. `DiscoveryStore.save` matches sources, preserves
  existing connection settings, and merges point configuration conservatively;
  ambiguous addresses leave the configured list intact. The service uses
  `scanStatus` and rejects known incomplete point results for pruning.
  Built-in scans are not protocol-wide authoritative. See
  [discovery/db.ts](../src/discovery/db.ts#L19),
  [discovery/service.ts](../src/discovery/service.ts#L190), and
  [plugins/types.ts](../src/plugins/types.ts#L210).
- **Verified:** `EndpointModel` stores connection and `data_points` as JSON;
  endpoint UUID is distinct from its numeric row ID and name.
  [EndpointModel](../src/db/models/endpoint.model.ts#L12) and
  [serialization](../src/db/models/endpoint.model.ts#L87).
  Device sync currently preserves existing rows, including placeholders and
  enabled state; confirmed device evidence is stored separately in
  [device.model.ts](../src/db/models/device.model.ts#L312) and
  [device-resolution-store.ts](../src/discovery/device-resolution-store.ts#L48).
  Explicit device/source deletion can remove confirmed evidence via
  [cleanup triggers](../src/db/migrations/20261113000000_add_device_resolution_evidence.ts#L6).
  Phase 2 must not alter those operations or infer equipment.
- **Validate:** Some historical endpoint records may have missing or duplicate
  UUIDs, malformed JSON, or insufficient point addresses. Measure a read-only
  inventory before any backfill; do not generate or replace endpoint UUIDs as
  part of this design.

### Ingestion, naming and enrichment

- **Verified:** Protocol adapters read configured points and emit
  `DeviceDataPoint`s. OPC UA's subscription and polling paths use `dp.nodeId`
  internally but emit `dp.name` as `metric`; Modbus emits register names;
  BACnet emits object names; MQTT builds one or more metrics from each message.
  Their emitted values generally do not carry the full protocol address.
  See [OPC UA subscription](../src/plugins/opcua/adapter.ts#L856),
  [OPC UA polling](../src/plugins/opcua/adapter.ts#L1831),
  [Modbus client](../src/plugins/modbus/client.ts#L389),
  [BACnet adapter](../src/plugins/bacnet/adapter.ts#L382), and
  [MQTT adapter](../src/plugins/mqtt/adapter.ts#L1002).
- **Verified:** `AdapterManager.enrichWithEndpointUuid` maps a device name to
  a source UUID where possible and `resolveEnrichedDeviceName` substitutes that
  endpoint UUID as `device_uuid` when no source device UUID is present. For
  multi-device OPC UA it may not find `endpoint_uuid` at all.
  [plugins/index.ts](../src/plugins/index.ts#L112).
  The agent's UUID, source UUID, source-provided DeviceUUID and any synthetic
  grouping ID are therefore not interchangeable.
- **Verified:** JSON IPC explicitly projects fields in
  [socket-server.ts](../src/core/socket-server.ts#L900); an address added only
  to an adapter object will be dropped. CSV has a different projection. The
  path then passes through name normalization, unit normalization and quality
  in that order ([init/features.ts](../src/init/features.ts#L727)).
  Modbus and MQTT additionally perform protocol-side scaling/conversion.
  Raw values, time, quality and existing configured transforms must not be
  altered by identity resolution.
- **Verified:** `attachIdentity` selects `normalizationName`, `metric` or
  `name`; its device key is `device_uuid ?? endpoint_uuid ?? deviceId`.
  `sourceAddress` is used only if already present.
  [interceptor.ts](../src/points/interceptor.ts#L65).
  `naturalKey` hashes protocol, endpoint **name**, device key and raw name into
  a UUIDv5 and short naming suffix ([identity.ts](../src/points/identity.ts#L24)).
  [PointNameCatalog](../src/points/catalog.ts#L48) preloads mappings, resolves
  from memory, and defers bounded SQLite writes; its queue can overflow or
  exhaust retries. This is not a commit-before-use durability guarantee.
- **Verified:** `point_name_mappings` stores locked names and provisional IDs,
  keyed by mutable values; `source_system` is nullable and SQLite treats NULLs
  as distinct in unique constraints. The model performs a separate NULL lookup.
  See [migration](../src/db/migrations/20260804000000_add_point_name_mappings.ts#L12)
  and [model](../src/db/models/point-name.model.ts#L52).
  In `resolve`, an existing row is reused only when its `rulesVersion` equals
  the current version; the `locked` flag alone does not ensure reuse across
  rule-version changes ([catalog.ts](../src/points/catalog.ts#L132)). Preserve
  stored locked mappings exactly; a future integration must test this case
  rather than assume the flag is sufficient.

### Anomaly, persistence, publishing and views

- **Verified:** For reading objects/arrays, `AnomalyFeed` requires a
  `pointIdentity.normalizedName` and nonempty `deviceKey`; it passes the
  normalized name as the metric and device key as `deviceId`. Other payload
  shapes take different fallback paths. Buffers use
  `deviceId::deviceState::metricName`, while baseline storage queries retain
  metric, state, device and time-slot semantics. See
  [feed.ts](../src/publish/anomaly/feed.ts#L123),
  [metric-router.ts](../src/analytics/anomaly/metric-router.ts#L152),
  [service.ts](../src/analytics/anomaly/service.ts#L260), and
  [storage.ts](../src/analytics/anomaly/storage.ts#L511).
  A name or device-key change can orphan a baseline/configuration or mix
  series; creating a Point UUID does not by itself fix this.
- **Verified:** `PublishManager` emits normalized names and existing
  `provisionalPointId` in some formats, and routes dataset records by a
  name-based tuple ([manager.ts](../src/publish/core/manager.ts#L1167)).
  MQTT destination topic templates use `deviceId`, `endpoint`, `topic` and
  optional `assetPath` ([mqtt.ts](../src/publish/plugins/mqtt.ts#L121)).
  Direct TimescaleDB publishing uses the agent UUID, normalized metric name,
  nullable equipment UUID and endpoint UUID, and existing provisional ID in
  `extra`; its insert conflict key is `(agent_uuid, metric_name, time)`
  ([timescaledb.ts](../src/publish/plugins/timescaledb.ts#L303)).
  Two distinct points with the same agent/metric/time can therefore conflict.
- **Verified:** Data Explorer's activity monitor is a bounded in-memory event
  and history cache, not a durable point registry. It keys by protocol,
  endpoint name and normalized/raw metric
  ([activity-monitor.ts](../src/publish/core/activity-monitor.ts#L78)).
  The UI uses the same tuple, with legacy key handling
  ([data-explorer-point-key.ts](../admin/src/utils/data-explorer-point-key.ts#L3)).
  Saved views and ML datasets persist `pointKeys`; their APIs validate tuple
  formats ([data-explorer-views.ts](../src/api/data-explorer-views.ts#L27),
  [ml-datasets.ts](../src/api/ml-datasets.ts#L68)). Replacing keys with UUIDs
  would break existing saved selections without compatibility work.
- **Verified:** The available cloud normalizer treats `entry.deviceUuid` as
  the ingestion/agent identity and equipment `device_uuid` and `endpoint_uuid`
  as optional extra fields
  ([readings-normalizer.ts](../../iotistica/ingestion/src/services/readings-normalizer.ts#L109)).
  The checked-in `metric_catalog` definition filters out rows without a device
  UUID ([migration 021](../../iotistica/api/database/migrations/021_catalog_identity_dedup.sql#L18));
  `readings_latest` is keyed by agent, device **name**, and metric
  ([migration 026](../../iotistica/api/database/migrations/026_rename_endpoint_latest_to_readings_latest.sql#L23)).
  Ingestion and direct writes also use `(agent_uuid, metric_name, time)` for
  reading conflicts ([readings.ts](../../iotistica/ingestion/src/services/readings.ts#L225)).
  Null equipment context can be stored but does not guarantee visibility or
  separation in catalog/latest/history.
- **Validate:** Checked-in migrations are not proof of any deployed database's
  current schema, refresh jobs, subscriptions, or API behavior. Inspect actual
  deployment versions and all cloud catalog, latest, historian and dashboard
  readers before proposing a later reader-before-writer migration.

## 3. Existing identity dependency map

| Input | Verified use | Change/collision risk |
|---|---|---|
| Endpoint UUID | Endpoint record and best-effort `endpoint_uuid`; also legacy equipment fallback | Missing/wrong source lookup blocks reliable source-scoped resolution; recreation gets a different UUID. Substitution can misrepresent equipment. |
| Endpoint name | Provisional natural key, catalog, activity/UI tuples, routes | Rename can create a new provisional ID/name mapping, lose a saved-view match, or change a topic/template. |
| DeviceUUID or `deviceId` | Legacy `deviceKey`, device grouping/display, anomaly device dimension | Adding/reassigning it can change provisional ID and anomaly series. Name/endpoint fallbacks can collapse unrelated equipment. |
| Raw point/label name | Provisional key and adapter metric; BACnet result maps keyed by object name | Rename generates another mapping; duplicate names can collide before the new catalog sees an address. |
| Normalized name | Anomaly metric, publish metric, activity/UI key, historical metric | Rename or collision can orphan baseline/view references or conflate readings. Preserve locked mappings. |
| Protocol address | Configuration/discovery matching and reads; often absent from live messages | Mutable/ambiguous representation can merge distinct points or create duplicates; it is not currently a universal durable key. |
| Provisional UUIDv5 | Naming cache and some published payloads | Changes with natural-key fields; pending mappings can be lost before flush. It is an alias candidate, not the new UUID. |
| SQLite row ID | Endpoint/device internal references and confirmed evidence | Local DB row identity is not a portable source or point identity. Restore/recreation can change IDs. |
| MQTT concrete topic/filter and payload field | Subscription matching, expansion and metric construction | A filter is not a concrete point; topic alone collapses fields; dynamic topics/fields can appear or disappear. Topic-based publishing is an external contract. |
| Anomaly `(deviceId, state, metric)` | Buffer, baseline and observations | Changing any component can orphan or mix state; no automatic baseline transfer. |

## 4. Proposed additive SQLite schema

The following is illustrative SQL, **not an executed migration**. Naming and
exact constraints require review against the actual SQLite version and schema.
Use nonempty, canonical UUID strings and validate types/lengths in application
code as well as constraints.

```sql
CREATE TABLE point_identity (
  point_uuid TEXT PRIMARY KEY NOT NULL,
  endpoint_uuid TEXT NOT NULL CHECK (length(endpoint_uuid) > 0),
  protocol TEXT NOT NULL CHECK (length(protocol) > 0),
  device_uuid TEXT,                 -- optional confirmed internal device context
  association_source TEXT,          -- provenance, not identity evidence
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (point_uuid, endpoint_uuid, protocol)
);

CREATE TABLE point_identity_address (
  endpoint_uuid TEXT NOT NULL,
  protocol TEXT NOT NULL,
  address_version INTEGER NOT NULL CHECK (address_version > 0),
  address_key TEXT NOT NULL COLLATE BINARY CHECK (length(address_key) > 0),
  point_uuid TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (endpoint_uuid, protocol, address_version, address_key),
  FOREIGN KEY (point_uuid, endpoint_uuid, protocol)
    REFERENCES point_identity (point_uuid, endpoint_uuid, protocol)
);

CREATE TABLE point_identity_alias (
  endpoint_uuid TEXT NOT NULL,
  alias_kind TEXT NOT NULL,         -- e.g. legacy provisional UUID
  alias_key TEXT NOT NULL COLLATE BINARY,
  point_uuid TEXT NOT NULL,
  evidence TEXT NOT NULL,           -- validated provenance, not a name guess
  created_at TEXT NOT NULL,
  PRIMARY KEY (endpoint_uuid, alias_kind, alias_key),
  FOREIGN KEY (point_uuid) REFERENCES point_identity (point_uuid)
);

CREATE INDEX idx_point_identity_source
  ON point_identity (endpoint_uuid, protocol);
CREATE INDEX idx_point_identity_device
  ON point_identity (device_uuid) WHERE device_uuid IS NOT NULL;
CREATE INDEX idx_point_identity_address_point
  ON point_identity_address (point_uuid);
CREATE INDEX idx_point_identity_alias_point
  ON point_identity_alias (point_uuid);
```

- **Proposed:** `address_key` is a strictly validated, versioned,
  deterministic typed serialization, not a delimiter-concatenated string or a
  hash alone. Full values are compared byte-for-byte; choose a size limit and
  canonical encoding per protocol. The address table permits a verified
  readdressing or schema-version alias without changing `point_uuid`. Each
  address can belong to at most one point in a source/protocol/version.
- **Proposed:** Preserve endpoint UUID as a non-FK historical source key:
  deleting an endpoint must not cascade-delete identity rows. Validate source
  existence and protocol at creation. Similarly, do not cascade from device
  deletion or rewrite confirmed evidence. Retained identities after an explicit
  endpoint deletion are historical records, not active configuration.
  SQLite foreign-key enforcement is connection-dependent; transactions and
  application-level checks must enforce scope even if it is disabled.
- **Proposed:** Store only an actually confirmed internal device UUID, or NULL.
  An external non-UUID DeviceUUID string is evidence, not automatically a
  `devices.uuid`; use existing established conversion/mapping only after
  verifying provenance. Never interpret the legacy endpoint fallback as
  confirmed physical equipment. Do not copy it blindly into this column.
  Treat source-to-device links as context, not a request to modify existing
  `device_resolution_*` rows or point configuration.
- **Proposed:** Legacy name mappings remain in `point_name_mappings`. Proven
  aliases can reference their existing IDs/keys without editing those rows.
  Record unresolved/collision diagnostics in an additive reconciliation
  ledger or operator report, not as a fabricated alias. Define retention,
  access and audit needs before adding a ledger table.
- **Validate:** Decide whether one active address and historical addresses
  require explicit lifecycle flags. Address reuse after device replacement,
  multiple projections of the same raw address, and explicit readdressing need
  operator semantics; a uniqueness constraint is not proof of physical
  continuity. Do not release/reuse an old address automatically.

### Transactions and concurrency

**Proposed:** Validate endpoint ownership and the complete address before
resolution. On a cache miss, use `BEGIN IMMEDIATE`, look up the exact
source/protocol/version/address, insert a random UUID and address if absent,
and commit before returning or caching the UUID. Concurrent requests/processes
must read the winner after a uniqueness conflict; a rollback, timeout, or
`SQLITE_BUSY` must produce a visible unresolved/error result, never a
success-shaped unpersisted UUID. Cache only committed rows; keep bounded
contention and telemetry throughput under test. Existing SQLite uses WAL,
busy timeout, and `transact` ([sqlite.ts](../src/db/sqlite.ts#L5)); avoid
synchronous per-reading writes on the hot path by resolving configured points
at configuration/session boundaries and batching genuinely new addresses.

```text
resolve(source_uuid, protocol, canonical_address):
    validate source ownership and canonical address
    begin immediate
    if exact committed address exists: return its point UUID after commit
    if cross-version/legacy ownership is ambiguous: rollback; report unresolved
    insert random Point UUID and its address atomically
    commit; cache and return Point UUID
```

Random UUIDv4 persisted before use avoids deriving identity from mutable names,
addresses, or schema versions, and lets a confirmed address change retain the
same identity. It is not a substitute for unique-address constraints or
transactional concurrency. On restart, reload committed mappings. A crash
before commit publishes no new durable ID; a crash after commit reuses it.

Schema versions must not silently partition identical physical points: before
enabling v2 creation, explicitly map each v1 address to v2 in a transaction.
If old and new representations cannot be proved equivalent, stop resolution
for that candidate; do not create a second point or merge records.

## 5. Canonical protocol addresses

The resolver interface should return either a typed, versioned canonical
address with provenance or an explicit unresolved reason. It must not infer
devices. Examples below show logical typed arrays, not a final wire format.

### OPC UA

**Verified:** Configured points carry string `nodeId`
([types.ts](../src/plugins/opcua/types.ts#L120)); Phase 1 matches supported
NodeId forms in [discovery/db.ts](../src/discovery/db.ts#L19). The device
snapshot reads server NamespaceArray and uses namespace URIs for *browse-name
paths*, but stores point addresses as NodeId strings
([device-snapshot.ts](../src/plugins/opcua/device-snapshot.ts#L16)).
That browse path is not a canonical NodeId namespace.

**Proposed:** `[namespaceUri, identifierType, identifierValue]` scoped to
endpoint UUID. Resolve the NodeId namespace index using the actual server
NamespaceArray at the time the configured/observed NodeId was verified. Encode
numeric identifiers as bounded unsigned integers, strings exactly (no trimming
or case folding), GUIDs in canonical value representation, and opaque
identifiers as canonical bytes/base64. Validate namespace and identifier
bounds and reject malformed or unsupported/remote ExpandedNodeIds.
On reconnect, remap URI to the current session index before reading; preserve
the URI-based identity. An index alone cannot establish equivalence after
remapping. Missing, duplicate, unavailable, or historically unverified URI
bindings mean unresolved; do not mint an index-based durable ID and later
guess a merge. Namespace URI alone also does not prove a replaced server is the
same physical source.

**Validate:** Server identity verification, namespace URI capture for legacy
configurations, remote references, explicit `nsu=` parsing, and behavior for
servers with unstable namespace URIs. Phase 1's index-based discovery merge
must remain unchanged until a separately reviewed compatible transition.

### MQTT

**Verified:** `MqttMetricConfig.field` supports dot paths, optional array
index compilation, and display metric names; wildcard subscription filters
match concrete incoming topics. Auto metrics emit top-level primitive fields;
default object handling may emit one `value` or multiple primitive fields.
Missing configured fields are skipped
([types.ts](../src/plugins/mqtt/types.ts#L16),
[adapter.ts](../src/plugins/mqtt/adapter.ts#L221),
[handleMessage](../src/plugins/mqtt/adapter.ts#L1066)).

**Proposed:** `[concreteTopic, valueSelector]`, where `valueSelector` is
explicitly tagged as whole-payload scalar or a typed path of object-key/array-
index tokens. Preserve topic and key bytes/case; do not identify a point by a
`+`/`#` filter. Paths must distinguish a literal dotted key from nested keys
and array index from string key; reject representations the current parser
cannot disambiguate. A topic can yield many point UUIDs. Missing fields are
absence of an observation, not deletion. New dynamic topics/fields create
points only under a bounded, observable policy; do not infer equipment.

**Validate:** Existing scalar versus `{value: ...}` fallback equivalence,
overlapping subscriptions/metrics, retained messages, dynamic cardinality,
path escaping and duplicate projections. Never infer their equivalence from
display metric names.

### Modbus

**Verified:** Config stores `slaveId`, address, function code/type, data type,
count, byte order, scale and offset
([types.ts](../src/plugins/modbus/types.ts#L73)).
Read calls pass `register.address` directly to the client
([client.ts](../src/plugins/modbus/client.ts#L1118)).

**Proposed:** `[unitId, addressSpace, protocolAddress]`, scoped to endpoint
UUID; map read function codes 1/2/3/4 to coils/discrete inputs/holding/input
registers and reject contradictory `type`/functionCode. Use the existing
configured numeric address as the wire address: do not subtract one or
reinterpret 40001-style notation. Unit/slave is protocol addressing, not a
physical DeviceUUID. Width/count, decoding, byte order, scaling and units are
configuration, not automatically a new point. Record them as provenance and
detect conflicting projections at the same address; keep them unresolved
rather than merging them. A deliberate reinterpretation/address move requires
explicit continuity approval.

**Validate:** Whether deployments intentionally configure two distinct
overlapping interpretations at one address, and how to represent them without
silently sharing or regenerating identity.

### BACnet

**Verified:** Config identifies object type, object instance and property;
property defaults to present-value (85), and device instance is in the device
config. The current schema has no point array-index field
([types.ts](../src/plugins/bacnet/types.ts#L44)).
The adapter associates read results by object name, a potential pre-catalog
collision when names repeat ([adapter.ts](../src/plugins/bacnet/adapter.ts#L382)).

**Proposed:** `[deviceInstance, objectType, objectInstance, propertyId,
arraySelector]`; normalize supported object types to their protocol numeric
identity and apply the existing default only when truly omitted. Use a
distinct explicit `whole-property` selector versus an array index, including
index zero. Preserve transport address as connection/evidence, not a substitute
for the device instance or a physical DeviceUUID. Reject unknown representations
and unsupported array selectors rather than treating them as present-value.

**Validate:** Duplicate device instances across BACnet networks, network/routing
scope beyond one endpoint, vendor object/property types and any future array
support. Do not claim array-index support in current adapters.

### Future protocols

**Proposed:** A protocol registry of versioned, typed canonicalizers accepting
validated source configuration plus address provenance and returning
`resolved` or `unresolved(reason)`. S7 can later define area/DB/offset and
projection semantics, but no S7 adapter or speculative key is part of Phase 2.
Unknown protocols remain unresolved until their canonicalizer is reviewed.

### Phase 2B standalone version 1 contract

The standalone resolver in `src/points/canonical-address.ts` emits fixed-order
JSON arrays and caps the UTF-8 encoded key at 8192 bytes. The endpoint UUID and
protocol remain separate database scope columns. Provenance is not part of the
key. Inputs require independently verified namespace bindings for OPC UA,
an explicit assertion that the NodeId was verified with that array, explicit
typed selectors and their source for MQTT, and an independently
verified unique device-instance scope for BACnet. These assertions are caller
evidence, not facts the resolver can establish by itself. Existing adapter
configuration generally does not contain all of that evidence; legacy MQTT
dot paths cannot be converted without disambiguation.

**Verified adapter compatibility and Phase 2C prerequisites:**

- **OPC UA:** `collectOpcuaDeviceSnapshot` reads NamespaceArray at
  `ns=0;i=2255` from a session and checks its status. A future caller must
  obtain and validate the array from the *same trusted server and session*
  that produced the NodeId, verify server identity, namespace zero and URI
  uniqueness, and establish continuity across reconnects. Historical numeric
  namespace indexes alone are insufficient. The resolver rejects library
  ExpandedNodeId-style suffixes that are indistinguishable from local string
  identifiers. It also rejects namespace-zero null NodeIds and OPC UA
  String/ByteString identifiers outside the specification's control-character,
  4096-character or 4096-byte limits, respectively. A string within the protocol limit
  may still exceed the resolver's smaller overall UTF-8 key limit.
- **MQTT:** `compileMetricPath` and `getFieldFast` use unescaped dot/bracket
  paths and JavaScript property access. A numeric segment can mean an object
  key or an array index depending on the payload. Phase 2C must obtain the
  concrete published topic and a typed selector from the actual extraction
  path and observed payload structure, not merely assert a selector from a
  legacy name. Missing fields, payload-shape changes, wildcard expansion and
  fallback value extraction require separate evidence.
- **Modbus:** `inventory.complete: true` is a caller assertion, **not**
  independently verified completeness. `AdapterManager.startModbusAdapter`
  and `startModbusAdapterGroup` build effective configurations from endpoint
  rows and `normalizeModbusRegisters`; the former can instead use explicit
  application configuration. Phase 2C must identify the active configuration
  source for the endpoint UUID, snapshot all configured points (including
  disabled points) and relevant units/address spaces consistently, apply the
  same normalization as that adapter path, and detect concurrent changes.
  Discovery samples and a boolean alone are not authoritative. Individual
  client reads use `[address, address + count)` wire addresses, including bits
  in coils and discrete inputs; they do not convert 40001-style notation at
  read time. Batch reads calculate their end from the last point rather than
  the maximum end, so overlapping configurations can also truncate a batch.
  Single-point resolution does not compare projections. In a complete
  inventory, every overlapping range, including duplicates, is unresolved.
  A malformed candidate invalidates the comparison and inventories over
  1024 entries are rejected; splitting one would miss conflicts. Decoder
  settings are not identity keys, and this policy does not prove continuity
  across reconfiguration.
- **BACnet:** The database adapter path filters nine object-type strings but
  forwards truthy numeric property IDs without validating the seven-member
  `BACnetProperty` schema enum. The installed bacstack encoder accepts IDs
  through 4194303; the resolver accepts positive integral IDs in that range
  without claiming that a particular server implements them. Explicit zero is
  unresolved because the adapter substitutes present-value 85. Indexed
  selectors are unsupported by the current adapter, and device-instance
  uniqueness across the network remains caller-supplied evidence.

Neither resolver creates catalog rows. Before any future schema-version change
can create identities, old and new addresses must be reconciled with explicit
evidence; version numbers alone must not create parallel identities.

## 6. Legacy reconciliation

**Proposed:** Migration creates empty tables only. A later, independently
approved and restartable reconciliation reads existing endpoint UUIDs,
configured point addresses, mappings and confirmed evidence without modifying
them. Require all of:

1. A verified endpoint UUID/protocol and canonical address with trustworthy
   source provenance.
2. One-to-one mapping between that address and a legacy record, using recorded
   address-to-reading/config evidence; a matching name alone is insufficient.
3. No conflicting device evidence, locked mapping, duplicate address,
   provisional UUID or other existing alias owner.
4. An atomic insert of point, address and aliases, with a durable checkpoint.

Existing mappings can have NULL source system and duplicated natural keys;
enumerate all candidates, do not use `LIMIT 1` as proof. Preserve every
`provisional_point_id`, normalized name, locked flag, rule version, raw name,
device context and historical record. A mapping whose identity cannot be
uniquely proven remains untouched and unresolved. An existing point without a
reliable address continues through legacy processing without a durable UUID;
surface a reason and allow later explicit resolution. Never use a fresh random
UUID as a temporary name-shaped fallback.

**Proposed:** A legacy alias is an additive bridge, not permission to change
old consumers. A name rename/device reassignment does not alter an existing
point row; a new name mapping can be linked only after proving which point it
describes. Do not auto-merge two UUIDs or auto-transfer anomaly baselines,
historical readings, or device ownership. Conflicting alias insertions stop
that candidate and preserve both sides.

## 7. Migration, lifecycle and rollback

- **Verified:** Native migrations are registered in
  [native-migrations.ts](../src/db/native-migrations.ts) and run one migration
  per immediate transaction under a migration lock
  ([migration-runner.ts](../src/db/migration-runner.ts#L118)).
- **Proposed 2A:** Add only new tables/indexes; register one migration with a
  unique name. No changes to endpoints, devices, evidence, data points,
  mapping rows, anomaly tables, readings, or cloud schemas. Runner history
  prevents normal reruns; `IF NOT EXISTS` must not conceal incompatible
  partially-created schemas—test schema validation and transactional failure.
  Take a tested backup before deployment.
- **Proposed:** An endpoint display rename or point display rename keeps its
  Point UUID because neither is in the address key. A device association
  change updates optional context only through an explicitly authorized,
  provenance-checked operation; it does not rewrite device evidence or
  historical data. A genuine address change is unresolved until a trusted
  explicit readdress operation atomically adds the new address for the same
  point after checking ownership.
- **Proposed:** Endpoint deletion leaves catalog rows as historical records.
  Recreating a source with a new endpoint UUID creates a new scope; never
  automatically attach old identities by matching address/name. Restore of
  the same endpoint UUID plus its SQLite catalog preserves identity. Define
  backup/restore and UUID-reuse governance before release.
- **Proposed:** Application rollback leaves additive tables in place and the
  old binary continues to read the old schemas and payloads. Validate against
  an actual previous binary and database snapshot; do not run a destructive
  down migration. New tables are inert to old code, but an older binary will
  not maintain new aliases/addresses; reconcile intervening configuration
  changes on re-upgrade rather than assume continuity.

## 8. Downstream compatibility and rollout

**Proposed:** In 2A/2B, no runtime contract changes. In 2C, resolve UUIDs
internally and keep the existing `provisionalPointId`, normalized names,
payload formats, device context, topics, anomaly keys and saved-view keys
unchanged. No consumer should treat a new UUID as available unless the
identity was committed and its source/address provenance verified.

**Critical limitation:** Existing telemetry enrichment can still expose an
endpoint UUID as `device_uuid`; leaving payloads unchanged preserves that
legacy behavior, but does **not** satisfy the ultimate requirement that
unidentified telemetry never carry a fabricated physical DeviceUUID. Phase 2C
must not introduce this fallback into the new catalog. Correcting the legacy
wire field requires a separately approved compatibility change and downstream
tests; until then, do not claim end-to-end optional-device behavior.

**Critical integration boundary:** The current IPC JSON projection drops
protocol addresses and CSV cannot carry an additive address without a contract
change. A configured-point catalog can be populated without changing wire
data, but reliable live per-reading resolution requires either a proven
in-process association before serialization or a separately approved,
versioned private transport/reader-before-writer change. No matching by
display name or timing. Unresolved data must continue on the legacy path.
This also applies to MQTT wildcard topics and fields that only become known at
message time, and multi-device OPC UA source provenance.

**Future, separate approvals:** Inventory consumers of all MQTT, socket, HTTP,
TimescaleDB, Databricks, custom/tag/ML and cloud formats; add readers that
accept optional point UUID and missing equipment context before any writer
emits a changed payload. Preserve old topic templates and subscriptions.
Then perform dual-read/compare and phased opt-in writing, with rollback and
observability. Cloud readers, materialized views, `readings_latest` flusher,
raw-reading uniqueness, APIs and dashboards must be updated and validated
before relying on Point UUID or nullable equipment identity. No cloud
migration is authorized here.

**Anomaly and UI:** Keep existing anomaly metric/device keys and baseline
storage intact in 2C. A future adapter must resolve aliases one-to-one and
dual-read/compare existing baselines before changing keys; no auto-copy or
reset. Preserve Data Explorer and ML dataset tuple keys and API contracts;
future UUID keys need dual readers, alias handling and saved-view migration.
Do not silently rekey historical activity or configurations.

## 9. Implementation sequence

Each step requires separate approval and its own tests; no broad refactor.

1. **2A — schema only:** Add migration and registration in
   `src/db/migrations/` and `src/db/native-migrations.ts`; add migration and
   rollback-compatibility tests. No backfill or changed runtime behavior.
2. **2B — canonicalizers:** Add narrowly scoped typed resolver functions and
   tests for OPC UA, MQTT, Modbus and BACnet. Gather URI/topic/field/source
   provenance in test fixtures; do not invent missing address data or change
   adapters/payloads yet. Freeze version 1 only after ambiguity decisions.
3. **2C — catalog integration:** Add a transaction-safe model/service and
   cache; integrate only trustworthy configuration/session paths after the
   transport and endpoint-provenance decision. Support opt-in shadow lookup,
   unresolved diagnostics, and strictly proven legacy aliases. Existing
   discovery merge, device sync, name catalog, anomaly, publishing, saved
   views and external interfaces remain unchanged. Backfill is a separate,
   reviewable operation, not a side effect of migration or partial discovery.
4. **2D — verification:** Run focused canonicalization, concurrent creation,
   migration/restart/rollback, Phase 1 discovery, protocol and downstream
   golden-contract tests. Compare existing DB rows and outputs before/after;
   investigate observed legacy failures separately. No production writes or
   rollout until these gates pass.

Potential later files, **not authorized changes now**, include
`src/points/`, `src/db/models/`, `src/db/migrations/`, protocol adapters and
the IPC transport. Changes to `src/publish/`, anomaly, API, UI or cloud require
their own compatibility approval.

## 10. Regression plan and required fixtures

These are **proposed tests**, not claims of existing support.

| # | Scenario | Required fixture and assertion |
|---|---|---|
| 1 | Restart | File-backed migrated SQLite; commit address, close/reopen, resolve same UUID. |
| 2 | Endpoint rename | Same endpoint UUID and address, change display name; same UUID and old mappings intact. |
| 3 | Point rename | Same address, change display label; same UUID, locked mapping untouched. |
| 4 | DeviceUUID absent | Configured source and address, no equipment evidence; UUID persists with NULL context; legacy output unchanged. |
| 5 | DeviceUUID added | Confirmed association added later; point UUID stable, existing evidence unchanged unless explicitly authorized. |
| 6 | DeviceUUID reassigned | Explicitly authorized context change; UUID stable, historical/evidence records retained; conflicting auto-discovery cannot reassign. |
| 7 | Same name on different endpoints | Two endpoint UUIDs, identical name/address; distinct Point UUIDs and no name-based alias merge. |
| 8 | Same display name, different addresses | One source with distinct addresses; distinct UUIDs, no lost mapping or automatic merge. |
| 9 | OPC UA namespace remapping | Fake session NamespaceArrays with same URI at different indexes; verified URI yields same UUID; missing/ambiguous old URI stays unresolved. Test all NodeId types. |
| 10 | MQTT structured fields | Wildcard filter, two concrete topics, nested fields, literal dotted key and arrays; distinct typed selectors; missing field does not delete. |
| 11 | Modbus unit/register spaces | Multiple slaves, same address in all four spaces; distinct UUIDs; conflicting type/function and overlapping projections rejected; no address offset. |
| 12 | BACnet object/property | Same device/object with different properties and selectors; distinct keys; unsupported array selectors unresolved. |
| 13 | Partial/failed discovery | Existing Phase 1 mixed/throw/partial fixtures; no catalog deletion, pruning, device/evidence or point-list loss. |
| 14 | Ambiguous legacy backfill | Duplicate names, NULL source system, conflicting address/alias and missing address; unresolved, no row rewrites or merge. |
| 15 | Locked name | Existing locked mapping and a rules-version mismatch; compare full row and emitted legacy name across lookup/restart. |
| 16 | Anomaly history | Seed actual baseline/config/observed metric keys; shadow catalog lookup and restart leave lookup/results and rows unchanged. |
| 17 | Existing identified publishing | Golden MQTT topic/payload, direct TimescaleDB and representative cloud ingestion fixture; compare byte/field contracts, agent and equipment UUIDs. |
| 18 | Concurrent resolution | Separate SQLite connections/processes race for one address; one committed UUID; busy/error path cannot return a nonpersistent UUID. |
| 19 | Existing-data migration | Realistic pre-2A snapshot with endpoints, points, names, devices, evidence and baselines; migration rerun/failure leaves rows byte-equivalent. |
| 20 | Application rollback | Start previous binary against migrated copy, exercise old reads/writes; re-upgrade without dropping data, flag any stale identity aliases. |

Add edge cases for UUID/endpoint deletion and recreation, explicit readdress,
version upgrades, transaction crash points, MQTT cardinality and transport
projection. Tests that require a cloud deployment or real OPC UA server are
integration gates and must not be represented as already validated.

## 11. Risks and unresolved decisions

1. **Identity provenance:** Multi-device OPC UA source UUID and protocol
   addresses are not consistently carried through IPC. Choose a safe transport
   strategy and approve any contract change before live 2C integration.
2. **Legacy fallback:** Existing payloads sometimes label endpoint UUIDs as
   equipment UUIDs. Preserving payload compatibility and eliminating that
   fallback are distinct goals; a reader-before-writer transition is required.
3. **Namespace continuity:** Missing historical URI evidence and server
   replacement cannot be solved by an index or name heuristic.
4. **Projection ambiguity:** Decide Modbus overlapping decodes, MQTT scalar
   versus field semantics and BACnet network/array scoping before finalizing v1.
5. **Historical collisions:** Cloud readings and latest views are name-keyed;
   a local UUID cannot repair pre-existing collisions or make device-less rows
   appear in device-filtered views.
6. **Names and anomalies:** Locked mapping reuse across rules versions and
   baseline aliasing need dedicated tests and explicit compatibility design;
   Phase 2 does not change anomaly history or naming behavior.
7. **Operational safety:** Bound dynamic MQTT catalog growth, protect against
   SQLite contention, retain source deletion history, and verify backup/restore
   and old-binary compatibility. Explicit readdressing and alias conflict
   workflows require operator authorization and audit.
8. **Working-tree baseline:** Phase 1 changes are currently uncommitted and
   must be reviewed/merged or otherwise pinned before implementing 2A; do not
   accidentally omit them or treat historical audit findings as current behavior.
