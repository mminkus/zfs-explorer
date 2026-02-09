# ZFS Explorer

**ZFS Explorer** is a web-based, read-only explorer for ZFS on-disk structures —
a visual frontend for `zdb`.

It allows interactive inspection of ZFS internals while preserving full
object-level accuracy. The goal is not to abstract ZFS, but to make its on-disk
format explorable, navigable, and debuggable.

ZFS Explorer currently supports:

- MOS object browsing and inspection
- Dnode and blkptr decoding
- ZAP visualization
- Dataset and DSL graph traversal
- ZPL filesystem walking (directories and files)
- Raw block hex inspection via DVAs

The design is intentionally **read-only**. Long-term goals include supporting
analysis of **unimported or damaged pools**, enabling forensic inspection and
file recovery without ever importing the pool.

You can think of this project as:

- **`zdb`, visualized**
- **A filesystem browser that never lies**
- **A teaching and debugging tool for ZFS internals**
- **A foundation for ZFS recovery and forensic workflows**

**Current Status:** Active development (MOS browser, ZAP decoding, DSL edges, hex dump, dataset tree, FS navigation in progress)

## Architecture

```
React UI (port 8080) → Rust API (port 9000) → libzdbdecode.so → ZFS Libraries
```

## What's Implemented (Milestone 0)

- ✅ Native C library (`libzdbdecode`) with `zdx_list_pools()`
- ✅ Rust backend with axum serving `GET /api/pools`
- ✅ React UI displaying pool list
- ✅ Global mutex for thread-safe ZFS calls
- ✅ FFI with proper memory management (zdx_free_result)

## What's Implemented (Milestone 1)

- ✅ Pool open/close via libzpool (single active pool)
- ✅ MOS object listing with pagination and type filtering
- ✅ MOS object inspector (dnode fields + blkptrs)
- ✅ Basic UI for browsing MOS objects and inspecting metadata

## Running on a Host with ZFS Access

If your UI runs in a container/VM without ZFS access, run the backend on a host
that can see `/dev/zfs`, then tunnel the ports.

### 1. Build on your dev machine

```bash
# Build native + backend
cd native
make clean && make
cd ../backend
cargo build
```

### 2. Copy to the ZFS host (optional)

```bash
# Adjust USER/HOST/PATH to your environment
rsync -av ./native ./_deps ./backend/target USER@HOST:/path/to/zfs-explorer/
```

### 3. Run the backend on the ZFS host

```bash
ssh USER@HOST
cd /path/to/zfs-explorer/backend
sudo ./target/debug/zfs-explorer
```

Expected output:
```
INFO zfs_explorer: Initializing ZFS library...
INFO zfs_explorer: ZFS Explorer starting (OpenZFS 21bbe7cb6)
INFO zfs_explorer: API server listening on 127.0.0.1:9000
```

### 4. Run the UI

```bash
cd ui
npm run dev
```

### 5. Tunnel ports (if UI and backend are on different hosts)

```bash
# From your local machine
ssh -L 8080:127.0.0.1:8080 -L 9000:127.0.0.1:9000 USER@HOST
# Open http://localhost:8080 in your browser
```

## Project Structure

```
zfs-explorer/
├── zfs/                    # OpenZFS submodule (commit 21bbe7cb6)
├── _deps/openzfs/          # Built OpenZFS userland
├── native/                 # C wrapper (libzdbdecode)
│   ├── include/
│   │   └── zdbdecode.h    # Public API
│   ├── src/
│   │   ├── zdbdecode.c    # Implementation
│   │   ├── json.c         # JSON helpers
│   │   └── json.h
│   ├── libzdbdecode.so    # Built library
│   └── Makefile
├── backend/                # Rust server
│   ├── Cargo.toml
│   ├── build.rs           # FFI bindings
│   └── src/
│       ├── main.rs        # Entry point
│       ├── ffi/           # Safe FFI wrappers
│       └── api/           # API handlers
└── ui/                     # React frontend
    ├── package.json
    └── src/
        ├── App.tsx        # Main component
        └── App.css
```

## API Endpoints (Selected)

- `GET /api/pools` - List all imported pools (returns JSON array of strings)
- `GET /api/pools/:pool/mos/objects?type=&start=&limit=` - List MOS objects
- `GET /api/pools/:pool/obj/:objid` - MOS dnode metadata
- `GET /api/pools/:pool/obj/:objid/blkptrs` - MOS block pointers
- `GET /api/pools/:pool/obj/:objid/zap` - ZAP entries
- `GET /api/pools/:pool/graph/from/:objid` - 1-hop graph slice
- `GET /api/pools/:pool/datasets/tree` - Dataset tree
- `GET /api/pools/:pool/dataset/:dsl_dir_obj/head` - Dataset → objset
- `GET /api/pools/:pool/objset/:objset_id/root` - ZPL root znode
- `GET /api/pools/:pool/objset/:objset_id/dir/:dir_obj/entries` - Directory entries
- `GET /api/pools/:pool/objset/:objset_id/walk?path=/a/b` - Path walk
- `GET /api/pools/:pool/objset/:objset_id/stat/:objid` - ZPL stat
- `GET /api/pools/:pool/block?vdev=&offset=&asize=` - Raw block hex dump

## Build from Scratch

If you need to rebuild everything:

```bash
# 1. Build OpenZFS userland (one time)
cd zfs
./autogen.sh
./configure --prefix=$PWD/../_deps/openzfs --with-config=user --enable-debug
make -j$(nproc)
make install
cd ..

# 2. Build native library
cd native
make clean && make
cd ..

# 3. Build Rust backend (with baked-in rpath)
cd backend
source ~/.cargo/env
cargo build
cd ..
# The binary will have rpath set via .cargo/config.toml
# This means it can find its libraries without LD_LIBRARY_PATH

# 4. Install UI dependencies
cd ui
npm install
```

## Security Model

- Backend binds to **127.0.0.1:9000** only (localhost)
- Access via SSH tunnel for remote use
- Requires root privileges (or ZFS capabilities) to access pools

## Validation Checklist

For repeatable milestone/release verification, use:

- `docs/VALIDATION_CHECKLIST.md`

## Next Steps

- Finish FS navigation + graph integration
- Add richer ZPL metadata decoding
- Expand graph tools and inspection workflows

## Tech Stack

| Component | Technology |
|-----------|------------|
| Native | C + ZFS libraries |
| Backend | Rust + axum |
| Frontend | React 19 + TypeScript + Vite |

## References

- OpenZFS commit: [21bbe7cb6](https://github.com/openzfs/zfs/commit/21bbe7cb6)
