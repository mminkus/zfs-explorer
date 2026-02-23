# Known Limitations and Failure Modes

This document tracks practical constraints that still apply to
`zfs-explorer` in both live and offline modes.

## Access and Privilege Constraints

- Backend typically needs elevated privileges (commonly root) to reliably
  inspect pools, vdev images, and kernel ZFS telemetry.
- Running as non-root may work for some metadata paths, but pool access can
  be partial or fail depending on host permissions.

## Read-Only Scope

- `zfs-explorer` is intentionally read-only.
- No repair, mutation, property updates, or pool-management write APIs are
  exposed.

## Live vs Offline Behavior Differences

- Runtime telemetry endpoints are live-mode only and return `400` in
  offline mode:
  - `/api/perf/arc`
  - `/api/perf/vdev_iostat`
  - `/api/perf/txg`
  - `/api/pools/{pool}/dedup`
  - `/api/pools/{pool}/space-amplification`
- Offline mode depends on explicit pool names/search paths and exported media
  visibility on disk.
- Offline open can fail when pools are simultaneously active/imported on the
  host namespace.

## Dataset and Encryption Caveats

- Internal DSL datasets (for example `$FREE`, `$MOS`, `$ORIGIN`) are not
  filesystem-browseable via ZPL path traversal.
- Encrypted datasets can expose metadata while data reads require keys.
  Locked/unavailable keys can produce partial traversal or read failures.

## Corruption and Degraded Pool Expectations

- Degraded/missing-vdev pools are supported for read-only inspection, but
  behavior is best-effort and object reads may still fail by design.
- Corrupt objects/blocks may produce traversal/read errors that are
  diagnostic, not necessarily backend regressions.

## Performance and Scale Boundaries

- Pagination and traversal caps are intentionally enforced to prevent runaway
  scans (MOS listing, ZAP listing, block trees, spacemap ranges/bins).
- Very large directories, ZAPs, and graph neighborhoods can still be heavy
  and may require iterative loading.
- Graph endpoint is currently one-hop focused with bounded include expansion.

## Data Read / Download Limits

- ZPL download endpoint supports a single HTTP `Range` header value.
- Objset raw-data reads and block reads are size-capped for safety.
- Some objects naturally return little/no payload (holes, metadata-only,
  sparse regions).

## Error Surface Notes

- API errors are returned as structured JSON envelopes.
- Native/FFI errors can still originate from pool state, unsupported object
  patterns, missing keys, or host/runtime compatibility issues.
