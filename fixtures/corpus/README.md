# Offline Corpus Fixtures

This directory contains reproducible, **exported** test pools for offline mode.

Layout convention:

```text
fixtures/corpus/
  vdevtype=<layout>/
    features=<profile>/
      <pool>/
        vdev-*.img
        manifest.json
```

Examples:

- `vdevtype=mirror/features=baseline/<pool>`
- `vdevtype=raidz1/features=dedup/<pool>`
- `vdevtype=raidz2/features=embedded-zstd/<pool>`
- `vdevtype=single/features=encryption-no-key/<pool>`
- `vdevtype=mirror/features=encryption-with-key/<pool>`
- `vdevtype=raidz1/features=degraded-missing-vdev/<pool>`

## Generate a fixture

```bash
build/create-corpus-fixture.sh \
  --pool zdx_mirror_base \
  --layout mirror \
  --profile baseline \
  --force

# encrypted dataset fixture (key removed before export)
build/create-corpus-fixture.sh \
  --pool zdx_enc_nokey \
  --layout single \
  --profile encryption-no-key \
  --force

# encrypted dataset fixture with key material retained in fixture dir
build/create-corpus-fixture.sh \
  --pool zdx_enc_key \
  --layout mirror \
  --profile encryption-with-key \
  --force

# degraded offline fixture: one vdev image intentionally removed post-export
build/create-corpus-fixture.sh \
  --pool zdx_degraded \
  --layout raidz1 \
  --profile degraded-missing-vdev \
  --force
```

## Validate a fixture

```bash
sudo build/test-corpus-fixture.sh \
  --manifest fixtures/corpus/vdevtype=mirror/features=baseline/zdx_mirror_base/manifest.json
```

## Validate the default subset

```bash
# mirror + raidz1 + encryption profiles + degraded profile (if present)
sudo build/test-corpus-subset.sh --list
sudo build/test-corpus-subset.sh
```

Validation does two things:

1. Runs offline API smoke checks.
2. Downloads known files through `/api/pools/:pool/zpl/path/*` and verifies
   `sha256` against `manifest.json`.
3. Verifies download protocol behavior (`Content-Length`, `Content-Type`,
   byte-range requests with `206` responses).

Note on `encryption-with-key`:

- Current offline open path does not yet expose explicit key-loading controls.
- The test harness runs a capability probe and will mark encrypted readable
  checks as `SKIP` when decode is unavailable in the current build/runtime.
