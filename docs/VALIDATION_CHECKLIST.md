# Validation Checklist

Use this checklist before closing a milestone or preparing a release candidate.

## 1. Build + Test

- [ ] Backend unit tests pass:

```bash
cd backend
LD_LIBRARY_PATH=../native:../_deps/openzfs/lib cargo test
```

- [ ] UI production build passes:

```bash
cd ui
npm run build
```

## 2. API Smoke Checks

- [ ] Pools endpoint responds:

```bash
curl -sS http://127.0.0.1:9000/api/pools
```

- [ ] DMU type endpoint responds:

```bash
curl -sS http://127.0.0.1:9000/api/mos/types
```

- [ ] Dataset tree endpoint responds for a selected pool:

```bash
curl -sS "http://127.0.0.1:9000/api/pools/<pool>/datasets/tree?depth=4&limit=500"
```

## 3. Manual Browser Validation

- [ ] Datasets -> FS -> MOS handoff works from both directions.
- [ ] FS navigation can `cd` through multiple levels without full-page reload.
- [ ] MOS list pagination works beyond first page (`Load more` repeatedly).
- [ ] Browser back/forward works in MOS and FS flows.
- [ ] Inspector long values do not overflow cards (dataset name, mount path, object labels).
- [ ] `Raw` tab opens and hex view loads for readable DVAs.
- [ ] `Open as object` from FS selection jumps to matching MOS object.
- [ ] `Open in FS` from DSL dataset inspector opens the expected dataset root.

## 4. Error Handling Spot Checks

- [ ] Trigger a known bad request (e.g., invalid object id) and confirm UI shows backend JSON error text.
- [ ] Confirm no silent hangs in browser Network tab (requests should settle with response or clear error).

## 5. Optional Regression Notes

- [ ] Record pool(s) used for manual validation.
- [ ] Record commit hash tested.
- [ ] Record any known non-blocking issues.
