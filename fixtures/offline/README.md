# Offline Fixtures

This directory holds file-backed pool fixtures used for offline-mode testing.

## Generate a fixture

```bash
build/create-offline-fixture.sh --pool zdx_fixture --force
```

The script creates:

- `fixtures/offline/<pool>/<pool>.img`
- `fixtures/offline/<pool>/fixture.json`

and exports the pool so it can be opened via offline mode.

## Smoke test a fixture

```bash
sudo build/test-offline-fixture.sh \
  --pool zdx_fixture \
  --search-paths "$(pwd)/fixtures/offline/zdx_fixture"
```

## Notes

- Fixture generation requires `zpool`/`zfs` tools and host ZFS support.
- Smoke testing requires root because backend pool access is privileged.
- Fixtures are development artifacts and are not intended for production data.
