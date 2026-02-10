# Screenshot Capture Guide

This checklist tracks the representative screenshots required for release-readiness.

## Required images

Place captured images in `docs/screenshots/` using these filenames:

1. `01-pool-summary.png`
   - Pool tab with summary cards + vdev tree visible.
2. `02-mos-zap-map.png`
   - MOS mode with a ZAP object selected and map/explore table visible.
3. `03-dataset-tree-fs.png`
   - Datasets tree on left + filesystem center pane populated.
4. `04-persistent-errors.png`
   - Pool tab persistent errors table with paging/actions visible.

Optional:
- `05-offline-mode.png` (offline mode badge + pool summary)
- `06-dsl-dataset-inspector.png` (DSL dataset inspector section and FS handoff)

## Capture notes

- Use real pool data with non-sensitive names where possible.
- Keep browser zoom at `100%`.
- Prefer desktop viewport wide enough to show all 3 panes.
- Verify dark theme contrast remains readable in each screenshot.

## Final wiring

After screenshots are added:

1. Update `README.md` with an image gallery section referencing these files.
2. Mark Milestone `R.4` screenshot task complete in `PLAN.md`.
