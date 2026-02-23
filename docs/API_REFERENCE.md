# ZFS Explorer API Reference

This document lists every backend API route currently registered in
`backend/src/main.rs`.

- Base URL: `http://127.0.0.1:9000`
- Content type: JSON for all endpoints except file download endpoint
  (`/api/pools/{pool}/zpl/path/{*zpl_path}`)
- Error format: JSON envelope with fields like
  `code`, `error`, `message`, `hint`, and `recoverable`

## Common Parameter Notes

- Pagination (`cursor`, `limit`) defaults:
  - `cursor`: `0`
  - `limit`: `200` (clamped to `1..10000`)
- Block-tree query defaults:
  - `max_depth`: `4` (max `16`)
  - `max_nodes`: `2000` (clamped to `1..50000`)
- Objset data reads:
  - `limit` default `65536` bytes (max `1048576`)
- Dataset tree defaults:
  - `depth`: `4`
  - `limit`: `500`
- Snapshot lineage defaults:
  - `max_prev`: `64` (clamped to `1..4096`)
  - `max_next`: `64` (clamped to `1..4096`)
- Spacemap ranges defaults:
  - `limit`: `200` (clamped to `1..2000`)
  - `op`: `all` (`all`, `alloc`, `free`)
- Spacemap bins defaults:
  - `bin_size`: `1048576` (`512..4294967296`)
  - `limit`: `256` (clamped to `1..2048`)
  - `op`: `all` (`all`, `alloc`, `free`)

## Service and Runtime Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/version` | Build/runtime info, OpenZFS commit, kernel module version source, mode metadata |
| `GET` | `/api/mode` | Current pool-open mode and configured offline pool/search-path settings |
| `PUT` | `/api/mode` | Switch mode at runtime. Body: `{ "mode": "live" | "offline" }` |
| `GET` | `/api/pools` | List pools visible in current mode |

## Live Telemetry Endpoints

These return `400` in offline mode.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/perf/arc` | ARC/L2ARC runtime summary |
| `GET` | `/api/perf/vdev_iostat?pool={pool}` | Per-vdev iostat sample from `zpool iostat -vH -p` |
| `GET` | `/api/perf/txg` | TXG runtime indicators |
| `GET` | `/api/pools/{pool}/dedup` | DDT summary from `zpool status -D -p` |
| `GET` | `/api/pools/{pool}/space-amplification` | Logical-vs-physical usage hints |

## Pool and Dataset Catalog Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/pools/{pool}/summary` | Pool summary including vdev tree, features-for-read, uberblock |
| `GET` | `/api/pools/{pool}/errors?cursor=&limit=&resolve_paths=` | Persistent pool error log entries |
| `GET` | `/api/pools/{pool}/datasets` | Dataset list for pool |
| `GET` | `/api/pools/{pool}/datasets/tree?depth=&limit=` | Hierarchical DSL dataset tree |
| `GET` | `/api/pools/{pool}/dsl/root` | Root DSL dir object id |
| `GET` | `/api/pools/{pool}/dsl/dir/{objid}/children` | Child DSL dirs under a given DSL dir |
| `GET` | `/api/pools/{pool}/dsl/dir/{objid}/head` | Head dataset object for a DSL dir |
| `GET` | `/api/pools/{pool}/dataset/{objid}/head` | Resolve DSL dir -> head dataset -> objset mapping |
| `GET` | `/api/pools/{pool}/dataset/{objid}/objset` | Same resolution mapping as `.../head` |
| `GET` | `/api/pools/{pool}/dataset/{objid}/snapshots` | Snapshots under DSL dir |
| `GET` | `/api/pools/{pool}/dataset/{objid}/snapshot-count` | Snapshot count for DSL dir |
| `GET` | `/api/pools/{pool}/snapshot/{dsobj}/objset` | Snapshot dataset object -> objset |
| `GET` | `/api/pools/{pool}/snapshot/{dsobj}/lineage?max_prev=&max_next=` | Snapshot lineage around target snapshot |

## MOS / DMU Object Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/mos/types` | DMU type table |
| `GET` | `/api/pools/{pool}/mos/objects?type=&start=&limit=` | List MOS objects (optional type filter) |
| `GET` | `/api/pools/{pool}/obj/{objid}` | MOS object metadata |
| `GET` | `/api/pools/{pool}/obj/{objid}/full` | Combined object view |
| `GET` | `/api/pools/{pool}/obj/{objid}/blkptrs` | MOS object block pointers |
| `GET` | `/api/pools/{pool}/obj/{objid}/block-tree?max_depth=&max_nodes=` | Traversed MOS block tree |
| `GET` | `/api/pools/{pool}/obj/{objid}/zap/info` | ZAP metadata for object |
| `GET` | `/api/pools/{pool}/obj/{objid}/zap?cursor=&limit=` | ZAP entries for object |
| `GET` | `/api/pools/{pool}/graph/from/{objid}?depth=&include=` | 1-hop graph slice; include can contain `semantic`, `physical`, `zap` |

## Objset / ZPL Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/pools/{pool}/objset/{objset_id}/root` | Root znode for objset |
| `GET` | `/api/pools/{pool}/objset/{objset_id}/objects?type=&start=&limit=` | List objects inside objset |
| `GET` | `/api/pools/{pool}/objset/{objset_id}/dir/{dir_obj}/entries?cursor=&limit=` | Directory entries |
| `GET` | `/api/pools/{pool}/objset/{objset_id}/walk?path=/a/b` | Walk path from objset root |
| `GET` | `/api/pools/{pool}/objset/{objset_id}/stat/{objid}` | ZPL-style stat for object |
| `GET` | `/api/pools/{pool}/objset/{objset_id}/obj/{objid}` | Object metadata |
| `GET` | `/api/pools/{pool}/objset/{objset_id}/obj/{objid}/full` | Combined object + blkptrs + optional ZAP data |
| `GET` | `/api/pools/{pool}/objset/{objset_id}/obj/{objid}/blkptrs` | Object block pointers |
| `GET` | `/api/pools/{pool}/objset/{objset_id}/obj/{objid}/block-tree?max_depth=&max_nodes=` | Traversed object block tree |
| `GET` | `/api/pools/{pool}/objset/{objset_id}/obj/{objid}/zap/info` | ZAP metadata |
| `GET` | `/api/pools/{pool}/objset/{objset_id}/obj/{objid}/zap?cursor=&limit=` | ZAP entries |
| `GET` | `/api/pools/{pool}/objset/{objset_id}/obj/{objid}/data?offset=&limit=` | Hex payload slice for object data |
| `GET` | `/api/pools/{pool}/zpl/path/{*zpl_path}` | File download by dataset/path; supports single HTTP `Range` |

## Spacemap and Raw Block Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/pools/{pool}/spacemap/{objid}/summary` | Spacemap summary |
| `GET` | `/api/pools/{pool}/spacemap/{objid}/ranges?cursor=&limit=&op=&min_length=&txg_min=&txg_max=` | Paginated spacemap ranges |
| `GET` | `/api/pools/{pool}/spacemap/{objid}/bins?bin_size=&cursor=&limit=&op=&min_length=&txg_min=&txg_max=` | Binned spacemap histogram view |
| `GET` | `/api/pools/{pool}/block?vdev=&offset=&asize=&limit=` | Raw block read (hex dump) |

## Notes

- Internal DSL datasets like `$FREE`, `$MOS`, and `$ORIGIN` are not
  filesystem-browseable via ZPL path endpoints.
- `/api/pools/{pool}/zpl/path/{*zpl_path}` returns bytes directly and
  sets response headers such as `Content-Type`, `Content-Disposition`,
  `Accept-Ranges`, `X-Zfs-Dataset`, and `X-Zfs-Relpath`.
- `graph/from` currently serves a one-hop graph slice; the `depth`
  query parameter is accepted for forward compatibility.
