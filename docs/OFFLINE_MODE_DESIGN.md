# Offline Mode Design and Status

## Current Status

Offline mode is implemented and used in regular fixture validation.

- Backend supports runtime pool-open modes: `live` and `offline`.
- Offline open uses read-only userland OpenZFS import/open plumbing.
- Existing MOS/DSL/ZAP/objset/ZPL APIs run on offline-opened pools.
- Corpus validation currently passes across Debian, Ubuntu, and FreeBSD
  test hosts (local matrix runs).

## Goal

Enable read-only exploration of exported/non-imported pools without requiring
kernel import of the target pool.

## Safety Model

- Offline mode is read-only.
- No dataset/property mutation APIs are exposed.
- Backend binds localhost by default (`127.0.0.1`).
- Mode is visible via startup logs and `/api/mode` / `/api/version`.

## Architecture

### Live mode

- Uses imported pools visible to host ZFS.
- Includes runtime telemetry endpoints (`/api/perf/*`, dedup, space-amplification).

### Offline mode

- Resolves pool config from supplied search paths.
- Imports/opens pools in-process for analysis using userland OpenZFS.
- Reuses the same traversal APIs (MOS/DSL/ZAP/objset/ZPL).
- Does not expose write/repair operations.

## Primary Interfaces

- Native primitive: `zdx_pool_open_offline(name, search_paths, err)`
- Backend controls:
  - env: `ZFS_EXPLORER_POOL_MODE=offline`
  - env: `ZFS_EXPLORER_OFFLINE_POOLS=<csv>`
  - env: `ZFS_EXPLORER_OFFLINE_PATHS=<colon-separated paths>`
  - API: `GET /api/mode`, `PUT /api/mode`

## Validation Tooling

- `build/test-corpus-fixture.sh`
- `build/test-corpus-matrix.sh`
- `build/check-offline-parity.sh`

## Known Offline Constraints

- Telemetry endpoints are unavailable in offline mode.
- Encrypted datasets may require keys for payload-level reads.
- Pools active/imported in host namespace can conflict with offline open.
- Degraded/corrupt pools are best-effort inspection only.

## Out of Scope

- Automatic recovery workflows.
- Any write/repair actions.
- Remote-by-default exposure (service remains localhost-bound by default).
