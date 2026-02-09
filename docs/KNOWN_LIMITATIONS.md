# Known Limitations and Failure Modes

This document captures current constraints for `zfs-explorer` (live imported-pool mode).

## Scope and Mode Limits

- Live mode only: pool must already be imported on the host.
- Offline/exported pool inspection is not implemented yet.
- Backend requires sufficient privileges to access ZFS internals (commonly root).

## Encryption and Access Limits

- Encrypted datasets may expose metadata while payload-level traversal can be limited.
- If keys are unavailable/locked, some object/directory paths can fail or appear incomplete.

## Pool/Layout/Feature Caveats

- Advanced pool layouts and feature combinations may have partial decoding coverage.
- Behavior can vary on pools with uncommon feature usage, large metadata fan-out, or edge-case object types.

## Performance and Scaling Limits

- UI and API use pagination/caps to avoid runaway traversal.
- Very large directories, ZAPs, or graph neighborhoods can still feel heavy and require iterative loading.
- Graph exploration is intentionally bounded (1-hop plus explicit expansions) to reduce explosion.

## Expected “No Data” Object Cases

Some objects naturally have little/no readable payload in a given view. This is expected for cases like:

- holes/unallocated objects
- `maxblkid = 0` objects
- objects with empty or metadata-only payload patterns
- entries that resolve to structure-only metadata without user payload bytes

## DVA/Block Read Caveats

- `"No readable DVA found"` can be expected for holes, unallocated objects, or objects without addressable payload blocks.
- Raw block reads are bounded by request limits and may return truncated results by design.

## Error Surface Notes

- API errors are returned as JSON envelopes with an `error` field for UI/debug tooling.
- FFI/library errors can still be backend-originated (for example, pool/object traversal failures) and should be treated as diagnostic signals, not always fatal corruption indicators.
