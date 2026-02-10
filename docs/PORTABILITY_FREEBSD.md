# FreeBSD Portability Audit (Milestone P.1)

## Scope
This document captures current Linux-specific assumptions in ZFS Explorer and
the abstraction points required to bring up experimental FreeBSD support
without destabilizing Linux.

## Current platform assumptions

| Area | Current behavior | Location |
|---|---|---|
| Native OpenZFS include path | OS-selectable via `ZFS_OS` (`linux` default, auto-detects FreeBSD) | `native/Makefile` |
| Rust backend linker config | Target-specific rustflags only for `x86_64-unknown-linux-gnu` | `backend/.cargo/config.toml` |
| Package artifact naming | Bundle name derives OS from `uname -s` (normalized) | `build/package.sh` |
| Runtime cachefile defaults | Historically expected `/etc/zfs/zpool.cache`; now also probes `/data/zfs/zpool.cache` and `/boot/zfs/zpool.cache` | `native/src/zdx_core.c` |
| Docs/examples | Most examples target Debian/Linux packaging/runtime | `README.md` |

## Observed API/runtime differences to account for

1. `zpool.cache` location differs by distro/platform.
   - Linux commonly: `/etc/zfs/zpool.cache`
   - Some appliance systems: `/data/zfs/zpool.cache`
   - FreeBSD commonly: `/boot/zfs/zpool.cache`
2. OpenZFS source include subtree is OS-specific.
   - Linux today uses `lib/libspl/include/os/linux`
   - FreeBSD expects `lib/libspl/include/os/freebsd`
3. Build/link target flags differ by Rust target triple.
   - Linux target config cannot be reused as-is for FreeBSD.
4. Packaging metadata should not imply Linux-only artifacts once FreeBSD support exists.

## Required abstraction points

### A1. Native include OS selector
- Implemented baseline:
  - `ZFS_OS ?= linux` with `uname -s` auto-detect override for FreeBSD
  - includes `$(ZFS_SRC)/lib/libspl/include/os/$(ZFS_OS)`
- Follow-up:
  - add CI compile check that explicitly builds with `ZFS_OS=freebsd`.

### A2. Rust target-aware linker config
- Move platform-specific linker arguments behind target sections or conditional build logic.
- Keep Linux behavior unchanged.
- Add FreeBSD target section once bring-up is validated.

### A3. Packaging OS identity
- Implemented baseline:
  - bundle OS is derived from `uname -s` (normalized), not hardcoded.
- Follow-up:
  - verify FreeBSD bundle naming/documentation through P.2 host smoke tests.

### A4. Runtime cachefile resolution
- Keep explicit env override first (`ZFS_EXPLORER_ZPOOL_CACHEFILE`, `ZPOOL_CACHE`).
- Maintain platform-aware fallback probing (including FreeBSD path).

### A5. Platform smoke-test entrypoint
- Add a minimal bring-up checklist command sequence (build + backend boot + `/api/pools` + `/api/version`).
- Record expected failures as known limitations during experimental phase.

## Bring-up checklist for Milestone P.2

1. Build vendored OpenZFS userland on FreeBSD host.
2. Build native lib with `ZFS_OS=freebsd`.
3. Build backend for native FreeBSD target.
4. Start backend and verify:
   - `GET /api/version`
   - `GET /api/pools`
   - `GET /api/pools/:pool/summary`
5. Validate one MOS object open and one dataset/objset traversal call.

## Initial support policy (for Milestone P.3)

- FreeBSD support should be marked `experimental` until:
  - native/backend compile succeeds on FreeBSD in CI or repeatable local automation
  - core read-only API smoke tests pass on imported pools
  - known limitations are documented with reproduction notes
