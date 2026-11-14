# Point picker identity limitations

The Source-first picker groups catalog entries by persistent endpoint UUID. It
matches a catalog device UUID to its source through the device's `endpoint_id`,
or uses a source UUID directly. Entries without an unambiguous source are not
shown. Existing saved keys are not rewritten.

The picker disables new selection when catalog entries share a key, a source has
multiple configured points with the same raw name, the configured point cannot
be matched or lacks an address, or the key has no protocol. Existing selections
remain intact. This check is conservative: matching a single configured name
does not prove an address-level identity, and a catalog that has already merged
readings may not expose every distinct point. The anomaly rule picker also
requires device metadata because its existing rule contract uses a device name.
If source or configured-point data cannot be loaded, the picker reports an
error instead of permitting new selections.

## Backend limitations and follow-up

- [`src/points/catalog.ts`](../src/points/catalog.ts),
  [`src/points/identity.ts`](../src/points/identity.ts), and
  [`src/db/models/point-name.model.ts`](../src/db/models/point-name.model.ts)
  identify name mappings by protocol, endpoint name, device key, and raw name,
  not protocol address. Same-name readings on one device can already have
  collapsed before reaching the picker.
- [`src/api/point-catalog.ts`](../src/api/point-catalog.ts) exposes a selection
  key based on protocol, endpoint name, and normalized name; distinct catalog
  records can have the same key. The catalog does not expose a verified
  source-address association.
- [`src/api/ml-datasets.ts`](../src/api/ml-datasets.ts) strips the fourth
  component of legacy keys and deduplicates them.
  [`src/publish/core/manager.ts`](../src/publish/core/manager.ts) matches
  dataset points by source name and metric. The live explorer and saved views
  use the corresponding name-based keys in
  [`admin/src/utils/data-explorer-point-key.ts`](../admin/src/utils/data-explorer-point-key.ts).

A separate, approved end-to-end change should propagate verified persistent
source and point identity, or equivalent verified protocol-address evidence,
from adapters through the catalog, live readings, selection APIs, and dataset
publishing. It should introduce versioned selection identifiers and an explicit
compatibility strategy for old saved views and datasets; ambiguous legacy keys
must not be silently mapped to a single point. Cover duplicate names, missing
or deferred identities, reconnects, and existing publishing behavior in
regression tests. This picker change does not implement that work.
