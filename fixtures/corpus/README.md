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

## Generate a fixture

```bash
build/create-corpus-fixture.sh \
  --pool zdx_mirror_base \
  --layout mirror \
  --profile baseline \
  --force
```

## Validate a fixture

```bash
sudo build/test-corpus-fixture.sh \
  --manifest fixtures/corpus/vdevtype=mirror/features=baseline/zdx_mirror_base/manifest.json
```

Validation does two things:

1. Runs offline API smoke checks.
2. Downloads known files through `/api/pools/:pool/zpl/path/*` and verifies
   `sha256` against `manifest.json`.
