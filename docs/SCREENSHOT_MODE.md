# Screenshot Mode (Demo/Privacy Redaction)

Screenshot mode is a presentation safety toggle intended for demos, bug reports,
and screenshots.

## Enable/Disable

- UI header toggle: `Screenshot Off/On`
- Setting is persisted in browser local storage per client.

## Redacted Fields

When enabled, the UI anonymizes matching JSON fields for this browser session:

- `hostname`
- `hostid`
- keys containing `guid` (for example `guid`, `pool_guid`, `vdev_guid`)
- `path`
- `devid`
- `phys_path`

Redaction is deterministic per value, so repeated values remain consistently
mapped and relationships are still traceable.

## Preserved Fields

The following are intentionally preserved for debugging usefulness:

- Object relationships and structure
- Numeric topology/size/txg metadata
- Dataset/file/object hierarchy
- Non-sensitive labels that are not in the redaction key set

## Notes

- Redaction is applied client-side in the UI workflow.
- Backend/API payloads on the wire are unchanged.
- Binary downloads are not rewritten.
