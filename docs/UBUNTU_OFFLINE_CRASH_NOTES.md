# Ubuntu Offline Crash Notes

## Summary
On Ubuntu 24.04, offline corpus reads crash the backend with an OpenZFS
assert. The same code path and same fixtures pass on Debian 13 and
FreeBSD 15.

This appears to be an Ubuntu-specific runtime failure in vendored
OpenZFS/libzpool interaction during dataset/objset access, not a fixture
content issue.

## Environment
- Host: Ubuntu 24.04 LTS
- ZFS Explorer backend/native built from this repo
- Vendored OpenZFS commit tested: `d11c66154`
- Offline mode:
  - `ZFS_EXPLORER_POOL_MODE=offline`
  - `ZFS_EXPLORER_OFFLINE_POOLS=zdx_single_baseline`
  - `ZFS_EXPLORER_OFFLINE_PATHS=<fixture dir>`

## Repro
1. Start backend in offline mode against a single baseline fixture.
2. Call either:
   - `GET /api/pools/<pool>/dataset/69/head`
   - `GET /api/pools/<pool>/zpl/path/<pool>/data/docs/readme.txt`
3. Backend aborts.

## Failure Signatures
- Common pre-crash errors:
  - `dmu_objset_from_ds failed: No such file or directory`
  - (in some experiments) `dmu_objset_hold('...') failed: No such file or directory`
- Crash:
  - `ASSERT at lib/libspl/list.c:81:list_destroy()`
  - thread name: `dbu_evict`
- Stack includes:
  - `libzpool.so.7(+0x12450d)`
  - resolved to `zfs/module/zfs/dsl_deadlist.c:970` (`dsl_deadlist_move_bpobj`)

### Latest confirmation (2026-02-22)
- Reproducible with backend started as `root` (not a non-root access artifact).
- Single API call is sufficient to trigger crash:
  - `GET /api/pools/zdx_single_baseline/dataset/69/head`
- Backend logs immediately before abort:
  - `resolved dataset head: dsl_dir_obj=69 head_dataset_obj=72`
  - `dataset_objset failed ... dmu_objset_from_ds failed: No such file or directory`
- Process then aborts with same `list_destroy()` assert in `dbu_evict`.

## Cross-Host Comparison
- Debian and Ubuntu report the same DSL dataset tree for the same fixture:
  - `zdx_single_baseline/data/docs` is `dsl_dir_obj=69`, head dataset `72`
- Vendored `zdb` on Ubuntu can open dataset by name and prints:
  - `Dataset zdx_single_baseline/data/docs [ZPL], ID 72`
- Debian passes corpus matrix (including fixtures copied from Ubuntu/FreeBSD).
- Ubuntu fails on all tested fixture origins (Debian/Ubuntu/FreeBSD).

## Ruled Out
- Wrong library linkage:
  - `ldd backend/target/debug/zfs-explorer` points to vendored
    `libzfs/libzpool/libnvpair/libzdbdecode`.
- Fixture provenance differences:
  - Ubuntu fails even when using Debian-created fixtures that pass on Debian.
- Pool readability by host kernel tools:
  - Ubuntu can `zpool import` fixture read-only and files are visible.
- Pure path parsing mistake:
  - Path and DSL resolution were corrected; crash still reproduces.

## Troubleshooting Attempted
1. Backend dataset/path resolution refactors in `backend/src/api/mod.rs`.
   - Improved candidate selection and internal dataset filtering.
   - Result: reduced some API mismatches, did not resolve Ubuntu crash.

2. Native build ABI flag alignment (`-DDEBUG -UNDEBUG -DZFS_DEBUG`) and
   include path cleanup.
   - Result: fixed intermediate regressions, crash persisted.

3. OpenZFS version checks and rebuilds.
   - Tested with vendored `d11c66154`.
   - Result: crash persisted.

4. Dataset open strategy experiments in native:
   - `dmu_objset_from_ds` path.
   - fallback to `dmu_objset_hold(name)`.
   - switching hot paths between these approaches.
   - keeping DSL dataset hold alive through op.
   - Result: both approaches still hit the same assert on Ubuntu.

5. SA lifecycle cleanup change:
   - Removed per-request `sa_tear_down(os)` in `objset_stat`.
   - Result: crash persisted.

6. Fixture matrix validation across copied fixture roots.
   - Debian passes all tested sets; Ubuntu fails all tested sets.
   - Result: strongly indicates host/runtime issue, not fixture data.

## FULLY RESOLVED (2026-02-22)

Three separate bugs were identified and fixed. All required to reach
full Ubuntu parity. Corpus validation (`build/test-corpus-fixture.sh`)
now passes on Ubuntu 24.04.

---

### Bug 1: `zdx_dataset_objset` unnecessarily opened the objset

**Root cause**: `zdx_dataset_objset` in `native/src/zdx_dsl.c` called
`dmu_objset_from_ds(ds, &os)` solely to obtain the objset ID via
`dmu_objset_id(os)`. Opening the objset triggered background eviction
in the `dbu_evict` thread which asserted in `bpobj_iterate_impl`.

**Fix**: `dmu_objset_id(os) == dsobj` is an invariant in OpenZFS.
Replaced the call with `uint64_t objset_id = dsobj`.

**Effect**: `GET /api/pools/.../dataset/69/head` stopped crashing.

---

### Bug 2: `dmu_objset_open_impl` error path left dangling callbacks

**Root cause**: When `dsl_prop_register` failed partway through
`dmu_objset_open_impl`, the error path freed the `objset_t` without
unregistering already-registered property callbacks. The `dbu_evict`
background thread then accessed those dangling `cbr` records and
asserted in `list_destroy()`.

This is a genuine OpenZFS bug; the fix is worth upstreaming.

**Fix**: Added `dsl_prop_unregister_all(ds, os)` to the error path in
`zfs/module/zfs/dmu_objset.c` before `arc_buf_destroy + kmem_free`.

**Ubuntu-specific trigger**: On Ubuntu 24.04, the system ships ZFS
kernel module v2.2.2 while our vendored userland is ~2.4.x. Because
`libzfs` (Ubuntu's package) is loaded before `libzpool` (vendored) and
wins PLT symbol resolution for `zfs_name_to_prop`, libzfs checks sysfs
for kernel-supported properties. The `prefetch` property is absent from
v2.2.2 sysfs, so `zfs_name_to_prop("prefetch")` → `ZPROP_INVAL` →
`dodefault(ZPROP_INVAL)` → `ENOENT` → `dsl_prop_register` fails.
Debian passes because its kernel module version matches vendored 2.4.x.

**Additional fix**: In `dmu_objset_open_impl`, treat `ENOENT` from
`dsl_prop_register` as non-fatal (older kernel module predates the
property). The unregistered callback field remains zero which is safe
for all DMU read paths.

---

### Bug 3: `dp_config_rwlock` TSD tag mismatch in `zdx_hold_objset_by_dsobj`

**Root cause**: `dp_config_rwlock` is initialized with
`rrw_init(..., B_TRUE)` (track_all mode). In this mode, every
`rrw_enter` records the caller's tag in per-thread TSD, and `rrw_exit`
must use the **identical tag pointer** to find and remove the TSD node.

`zdx_hold_objset_by_dsobj` called `dsl_pool_config_enter` with its own
`FTAG` (`"zdx_hold_objset_by_dsobj"`), but returned with the lock still
held for the caller. The caller (`zdx_objset_walk`, etc.) then called
`dsl_pool_config_exit` with its own `FTAG` (`"zdx_objset_walk"`). The
pointer mismatch caused `rrn_find_and_remove` to return FALSE →
`ASSERT(!rrl->rr_track_all)` → crash.

This bug was latent but only surfaced after Bug 2 was fixed: previously
`dmu_objset_from_ds` always returned an error on Ubuntu, so the helper
always took its own error path (which correctly called `config_exit`
with the matching tag) and the caller's exit was never reached.

**Fix**: Added a `tag` parameter to `zdx_hold_objset_by_dsobj`. All
`dsl_pool_config_enter/exit` calls inside use this tag. Callers pass
their own `FTAG`, so enter and exit are consistent end-to-end.

**Effect**: `GET /api/pools/.../objset/72/walk?path=/readme.txt` stops
crashing. Full corpus validation passes on Ubuntu 24.04.
