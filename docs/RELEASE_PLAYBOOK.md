# Release Playbook (1.0 RC)

This is the maintainer checklist for building, validating, and publishing
`zfs-explorer` release artifacts.

## 1) Preconditions

- Local branch is committed.
- Commit is pushed to origin (required for FreeBSD matrix parity checks).
- Docker is available on the Linux build host.
- FreeBSD builder host is reachable via passwordless SSH.
- Pre-release test gate passed on the release commit:
  - `./build/test-quick.sh` (backend + native unit suites, optional UI build)
  - `sudo build/test-corpus-matrix.sh` (fixture semantics gate)

## 2) Build Release Matrix

Run from repo root:

```bash
./build/package-matrix.sh --profile release --freebsd-host freebsd.example.net
```

This produces:

- `dist/releases/<timestamp>/linux/...` backend tarballs
- `dist/releases/<timestamp>/freebsd/...` backend tarball
- `dist/releases/<timestamp>/zfs-explorer-webui-<version-label>.tar.gz`
- `dist/releases/<timestamp>/SHA256SUMS.txt`
- `dist/releases/<timestamp>/MATRIX_SUMMARY.txt`
- `dist/releases/<timestamp>/matrix-logs-<timestamp>.tar.gz`

## 3) Smoke-Test Required 1.0 Platforms

Required release-gate platforms:

- Debian 13
- Ubuntu 24.04
- FreeBSD 15
- AlmaLinux 10 (EL10)

For each required tarball:

1. Verify archive structure and version metadata:

```bash
tar -tzf <backend-tarball> | head
tar -xzf <backend-tarball> -C /tmp
grep -E '^(bundle|version_label|git_sha)=' /tmp/<bundle-dir>/VERSION.txt
```

2. On the target OS host, run backend smoke startup:

```bash
cd /tmp/<bundle-dir>
sudo ./run-backend.sh
curl -s http://127.0.0.1:9000/api/version | jq .
```

3. Confirm API responds and reports expected backend/OpenZFS metadata.

## 4) Publish Artifacts

Create GitHub release and upload:

- Required backend tarballs (gate platforms)
- Optional additional backend tarballs (compat coverage)
- `zfs-explorer-webui-<version-label>.tar.gz`
- `SHA256SUMS.txt`

## 5) Attach Validation Evidence

For release notes/support triage, retain and/or attach:

- `MATRIX_SUMMARY.txt`
- `matrix-logs-<timestamp>.tar.gz`
- Any platform-specific smoke-test notes

## 6) Post-Publish Sanity Check

- Verify GitHub release download links.
- Verify checksums against uploaded artifacts.
- Re-run one quick startup test from downloaded artifacts.
