# Packaging and Static-Link Feasibility

## Summary Decision

For Linux delivery, use a **bundled dynamic artifact** (backend binary + `libzdbdecode.so` + vendored OpenZFS shared libraries), launched through a wrapper that sets `LD_LIBRARY_PATH`.

Full static linking is **not** the primary target right now.

## Why Not Full Static (Current State)

- `libzdbdecode` links against vendored OpenZFS userland libraries that are currently built/used as shared objects.
- Producing a fully static backend would require a static-friendly build of all dependencies and additional toolchain/linker work.
- glibc-static portability is typically brittle across distro/runtime combinations.
- The current deployment model already expects vendored OpenZFS userland and is easiest to preserve with a bundled dynamic approach.

## Recommended Artifact Shape

```
zfs-explorer-<profile>-<os>-<arch>/
  bin/zfs-explorer
  lib/libzdbdecode.so
  lib/libzfs.so.*
  lib/libzpool.so.*
  lib/libnvpair.so.*
  lib/libuutil.so.*
  ...
  run-backend.sh
  VERSION.txt
```

`run-backend.sh` sets `LD_LIBRARY_PATH` to `./lib` and executes the bundled backend.

## Reproducibility Plan

1. Build native + backend for target profile.
2. Collect required shared libraries from vendored `_deps/openzfs/lib`.
3. Produce a deterministic directory layout.
4. Emit a tarball artifact with version metadata.

## Follow-up Work

- Add CI release workflow for packaged artifacts.
- Add checksum/signature generation.
- Evaluate release profile hardening flags.
- Revisit static linking later if distribution constraints require it.
