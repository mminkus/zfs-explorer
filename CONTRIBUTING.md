# Contributing to ZFS Explorer

Thanks for helping improve `zfs-explorer`.

## Development Setup

Use the canonical build script:

```bash
./build/build.sh
```

Fast local loop:

```bash
./build/build.sh --quick
```

## Validation Before PR

Run these checks before opening a PR:

```bash
cd native && make
cd ../backend && LD_LIBRARY_PATH=../native:../_deps/openzfs/lib cargo test
cd ../ui && npm run build
```

Also run the manual validation checklist:

- `docs/VALIDATION_CHECKLIST.md`

## Scope and Safety Rules

- Keep all traversal logic read-only.
- Do not add write/import/mutation code paths.
- Preserve localhost bind default for backend.
- If a change affects safety model behavior, update `README.md` and `PLAN.md`.

## Reporting Bugs

Use the bug report template and include:

- backend debug bundle from Inspector `Copy debug`
- failing endpoint/path/object id (if known)
- pool + OpenZFS context
- reproduction steps

## Commit Style

Preferred commit body sections:

- `Native:`
- `Backend:`
- `UI:`
- optionally `Build:` / `Docs:` / `Repo:`
