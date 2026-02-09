# Offline Mode Design (Milestone O.1)

## Goal
Enable read-only exploration of **exported/non-imported** pools without requiring a kernel import on the host system.

## Safety Model
- Offline mode is strictly read-only.
- No dataset/property mutation APIs are exposed in native or backend.
- Open/import operations use read-only userland OpenZFS plumbing.
- UI and API must clearly show mode (`live` vs `offline`).
- Default bind remains `127.0.0.1`; no remote exposure by default.

## Architecture

### Live mode (current)
- Open by pool name with `spa_open()` against imported pools.
- Uses MOS/DSL/ZAP traversal through existing native APIs.

### Offline mode (target)
- Discover pool config from supplied device/file search paths using `libzutil` (`zpool_find_config`).
- Import pool in-process with `spa_import(..., ZFS_IMPORT_SKIP_MMP)`.
- Open with `spa_open()` and reuse existing MOS/DSL/ZAP traversal APIs.
- On handle close, export in-process import when we imported it.

## Offline open primitive (added in O.2)
- C API: `zdx_pool_open_offline(name, search_paths, err)`
- `search_paths` format: colon-separated directories/devices/files.
- `search_paths == NULL` uses OpenZFS default import search paths.

## Failure/edge handling
- Return errno-style errors for import/open failures.
- Support already-imported namespace case (`EEXIST`/`EALREADY`) by continuing with `spa_open()`.
- If import succeeded but open/alloc fails, attempt cleanup export.

## v1 Compatibility Matrix

| Area | v1 Target | Status | Notes |
|---|---|---|---|
| Exported pool import | Yes | In progress | Primitive added; backend runtime mode wired |
| MOS object browse | Yes | In progress | Runtime mode can open pools via offline primitive |
| DSL traversal | Yes | Planned | Same APIs after offline open |
| ZAP decode | Yes | Planned | Same APIs after offline open |
| FS navigator | Yes | Planned | Depends on objset traversal parity |
| Checkpoint rewind policies | Optional | Not in v1 | Design reserved for later |
| Encrypted datasets (locked) | Partial | Expected limitation | Metadata visibility depends on key state |
| Damaged/missing devices | Partial | Expected limitation | Graceful errors; no recovery tooling in v1 |
| RAIDZ/dRAID/special vdevs | Best effort | Planned | Depends on imported config quality and labels |

## Implementation sequence
1. Native primitive (done): offline open by search paths.
2. Backend mode-aware pool handle management (done via env-config runtime mode).
3. API parameterization (`mode=live|offline`, optional search paths).
4. DSL/ZAP parity checks against live mode (scripted baseline added).
5. UI mode selector + mode badge and warnings.
6. Test fixtures and regression coverage.

## Current validation helper (O.2)

- Script: `build/check-offline-parity.sh`
- Purpose: compare normalized JSON output from a live-mode backend and an
  offline-mode backend for selected MOS/DSL/ZAP endpoints.
- Typical usage:
  - Run live backend at `:9000`
  - Run offline backend at `:9001`
  - Execute:
    `LIVE_BASE_URL=http://127.0.0.1:9000 OFFLINE_BASE_URL=http://127.0.0.1:9001 build/check-offline-parity.sh <pool> 1 32 34`

## Out of scope for O.1/O.2
- Automatic damaged-pool recovery workflows.
- Write operations or repair actions.
- FreeBSD portability work (tracked in Milestone P).
