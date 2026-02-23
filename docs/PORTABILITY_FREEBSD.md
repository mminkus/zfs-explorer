# FreeBSD Portability Notes

## Status

FreeBSD support is implemented for local development workflows.

What is currently working:

- Bootstrapping host dependencies via `build/bootstrap-freebsd.sh`
- Building vendored OpenZFS userland
- Building native library and backend on FreeBSD
- Building UI assets
- Corpus create/test matrix runs (same scripts used on Linux)

## FreeBSD-Specific Build Notes

- Use `gmake` (GNU make) on FreeBSD.
- Build defaults include:
  - `CPPFLAGS=-I/usr/local/include`
  - `LDFLAGS=-L/usr/local/lib`
  - `LIBS=-lintl`
- `python3` and `jq` are required by corpus scripts.
- `llvm`/`libclang` are required for backend bindgen.

Bootstrap command:

```bash
./build/bootstrap-freebsd.sh
```

Typical build command:

```bash
env MAKE=gmake build/build.sh --bootstrap-openzfs
```

## Runtime Notes

- Kernel module version detection uses:
  - `sysctl -n vfs.zfs.version.module`
- Backend API defaults remain:
  - bind: `127.0.0.1:9000`

## Validation Expectations

Recommended quick validation on FreeBSD host:

1. Build all layers (`build/build.sh`).
2. Start backend and verify:
   - `GET /api/version`
   - `GET /api/pools`
3. Run fixture matrix:
   - `build/create-corpus-matrix.sh`
   - `sudo build/test-corpus-matrix.sh`

## Remaining Caveats

- CI coverage for FreeBSD is not in place yet.
- Host-to-host variance in system packages/toolchain versions can still
  require small bootstrap adjustments.
