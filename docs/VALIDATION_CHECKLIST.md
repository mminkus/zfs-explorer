# Validation Checklist

Use this checklist before merging major backend/native changes or preparing a
release candidate.

## 0. Preflight

- [ ] Confirm no stale backend process is already bound to `127.0.0.1:9000`.

Linux example:

```bash
ss -ltnp | rg ':9000' || true
```

FreeBSD example:

```bash
sockstat -4 -l | rg ':9000' || true
```

## 1. Build and Unit-Level Validation

- [ ] Native library build succeeds.

Linux:

```bash
cd native && make -j"$(nproc)"
```

FreeBSD:

```bash
cd native && gmake -j"$(sysctl -n hw.ncpu)"
```

- [ ] Backend tests succeed.

```bash
cd backend
LD_LIBRARY_PATH=../native:../_deps/openzfs/lib cargo test
```

- [ ] UI production build succeeds.

```bash
cd ui
npm run build
```

## 2. Backend Smoke Checks

- [ ] Start backend and confirm startup banner includes backend/OpenZFS/version
      metadata.
- [ ] Core endpoints respond:

```bash
curl -sS http://127.0.0.1:9000/api/version | jq
curl -sS http://127.0.0.1:9000/api/mode | jq
curl -sS http://127.0.0.1:9000/api/pools | jq
curl -sS http://127.0.0.1:9000/api/mos/types | jq
```

## 3. Offline Fixture Validation

- [ ] Regenerate corpus fixtures (or targeted subset) if fixture logic changed.

```bash
build/create-corpus-matrix.sh --keep-going
```

- [ ] Run corpus validation matrix.

```bash
sudo build/test-corpus-matrix.sh --keep-going
```

- [ ] Confirm summary reports all passes for selected combinations.

## 4. Manual UI Sanity (Targeted)

- [ ] Dataset tree renders and navigation is stable.
- [ ] Objset walk/stat/object inspector flows work on at least one fixture.
- [ ] ZPL path download works for known files.
- [ ] Error responses are visible and actionable in UI (no silent hangs).

## 5. Optional Cross-Host Verification

Run when changing native/OpenZFS integration or portability-sensitive code.

- [ ] Debian host run completed.
- [ ] Ubuntu host run completed.
- [ ] FreeBSD host run completed.
- [ ] Record matrix summaries in PR notes.

## 6. Release Notes Inputs

- [ ] Record tested commit hash.
- [ ] Record OpenZFS submodule commit hash.
- [ ] Record any known non-blocking issues and workarounds.
