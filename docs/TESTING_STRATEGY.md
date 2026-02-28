# Testing Strategy

This repo uses a three-layer testing pyramid so we catch regressions quickly
without replacing real OpenZFS behavior checks.

## 1. Unit tests (fast, deterministic)

Run on every local edit loop. No live pools or fixture media required.

- Backend unit tests (`backend`, Rust): parser helpers, pagination/validation,
  API error envelope decisions, and handler behavior with deterministic inputs.
- Native unit tests (`native`, C): pure helper logic only (for example, JSON
  helper shape/escaping behavior).

## 2. Fixture/integration tests (real OpenZFS semantics)

Run against generated/exported fixture pools. These are the correctness gate for
pool traversal semantics and data-path behavior.

- Fixture create/test scripts: `build/create-corpus-fixture.sh`,
  `build/test-corpus-fixture.sh`, `build/test-corpus-subset.sh`

## 3. Matrix validation (cross-platform confidence)

Run matrix jobs for broader platform/layout/profile coverage.

- `build/create-corpus-matrix.sh`
- `sudo build/test-corpus-matrix.sh`

## Ownership: Unit vs Fixture

Use unit tests when logic can be isolated and deterministic.
Use fixture tests when behavior depends on real libzpool/libzfs state.

- Unit tests should cover parsing, normalization, and API envelope mapping.
- Fixture tests should cover on-disk traversal semantics and host/runtime
  interactions.
- Do not replace fixture assertions with mocks for OpenZFS internals.

## Quick local command

Use the quick loop command during development:

```bash
./build/test-quick.sh
```

Canonical build loop (`./build/build.sh --quick`) also runs backend and native
unit suites.

Optional:

```bash
# skip UI build when iterating backend/native only
./build/test-quick.sh --skip-ui-build
```

This command reports unit failures separately from fixture/matrix commands.

### Native unit tests by platform

Linux:

```bash
cd native
make test-native-unit
```

FreeBSD:

```bash
cd native
gmake test-native-unit
```

## Feature contract examples

- `/api/version`:
  - Unit: handler payload/envelope shape.
  - Fixture: runtime metadata sanity on host.
- `/api/perf/txg`:
  - Unit: source-path selection fallback + error envelopes.
  - Fixture: offline-mode rejection assertion in `build/test-offline-fixture.sh`.
- Offline-mode live-route rejection:
  - Unit: BAD_REQUEST envelope for live-only routes in offline mode.
  - Fixture: mode-switch behavior with exported/imported fixtures.

## Feature contract matrix

Update this matrix whenever a major API feature is added. A feature is not
done until both columns have at least one concrete assertion.

| Feature | Backend unit assertion | Fixture/integration assertion |
|---|---|---|
| `/api/version` envelope + mode fields | `backend/src/api/mod.rs` tests (`api_version_handler_returns_pool_open_config`) and router test in `backend/src/main.rs` | `build/test-offline-fixture.sh` checks `/api/version` reports offline mode |
| `/api/perf/txg` source/fallback + envelope behavior | `backend/src/api/mod.rs` tests (`resolve_txg_source_*`, `build_txg_payload_*`) | `build/test-offline-fixture.sh` checks `/api/perf/txg` returns offline rejection envelope in offline mode |
| ZPL download range semantics | `backend/src/api/mod.rs` tests (`parse_range_header_supports_standard_and_suffix_forms`) | `build/test-corpus-fixture.sh` verifies range HTTP status/content-range/payload checksums |
