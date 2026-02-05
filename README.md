# ZFS Explorer

A web-based ZFS on-disk structure explorer ("Wireshark for ZFS").

**Current Status:** Milestone 0 (Proof of Life) - Complete ✅

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

## Testing on nexus Host

Since the LXC container doesn't have direct ZFS access, test on the nexus host:

### 1. Copy the build to nexus

From the container:
```bash
# Copy the entire project (or just backend + native + _deps)
rsync -av /home/martin/development/zfs-explorer martin@nexus:/home/martin/development/
```

### 2. Copy files to nexus

From the container:
```bash
rsync -av /home/martin/development/zfs-explorer/native martin@nexus:/nexus/local/home/martin/development/zfs-explorer/
rsync -av /home/martin/development/zfs-explorer/_deps martin@nexus:/nexus/local/home/martin/development/zfs-explorer/
rsync -av /home/martin/development/zfs-explorer/backend/target martin@nexus:/nexus/local/home/martin/development/zfs-explorer/backend/
```

### 3. Run the backend on nexus

```bash
ssh martin@nexus
cd /nexus/local/home/martin/development/zfs-explorer/backend

# Just run it - rpath is baked into the binary!
sudo ./target/debug/zfs-explorer
```

> **Note:** RUNPATH is baked into both the binary and `libzdbdecode.so` (via `.cargo/config.toml` and `native/Makefile`), so they automatically find all shared libraries without needing `LD_LIBRARY_PATH`.

Expected output:
```
2026-02-05T05:45:00.000000Z  INFO zfs_explorer: Initializing ZFS library...
2026-02-05T05:45:00.000000Z  INFO zfs_explorer: ZFS Explorer starting (OpenZFS 21bbe7cb6)
2026-02-05T05:45:00.000000Z  INFO zfs_explorer: API server listening on 127.0.0.1:9000
```

### 4. Test the API

From nexus (in another terminal):
```bash
curl http://127.0.0.1:9000/api/pools
```

Expected response:
```json
["nexus","rpool"]
```

### 5. Run the UI

From the container (or nexus):
```bash
cd /home/martin/development/zfs-explorer/ui
npm run dev
```

Then access via SSH tunnel:
```bash
# From your local machine:
ssh -L 8080:127.0.0.1:8080 -L 9000:127.0.0.1:9000 martin@nexus
# Open http://localhost:8080 in your browser
```

Or directly on nexus if it has a browser.

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

## API Endpoints (M0)

- `GET /api/pools` - List all imported pools (returns JSON array of strings)

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

- Backend binds to **127.0.0.1:8080** only (localhost)
- Access via SSH tunnel for remote use
- Requires root privileges (or ZFS capabilities) to access pools

## Next Steps (Milestone 1)

- Pool opening (`zdx_pool_open`)
- MOS object listing
- Dnode inspection
- Block pointer decoding

## Tech Stack

| Component | Technology |
|-----------|------------|
| Native | C + ZFS libraries |
| Backend | Rust + axum |
| Frontend | React 19 + TypeScript + Vite |

## References

- [Implementation Plan](/.claude/plans/wiggly-frolicking-lampson.md)
- [zfs-comphist](../zfs-comphist) - Reference implementation
- OpenZFS commit: [21bbe7cb6](https://github.com/openzfs/zfs/commit/21bbe7cb6)
