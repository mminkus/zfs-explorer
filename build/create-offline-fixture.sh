#!/usr/bin/env bash
set -euo pipefail

POOL="zdx_fixture"
FIXTURE_DIR=""
SIZE="512M"
FORCE=0

usage() {
  cat <<'EOF'
Usage: build/create-offline-fixture.sh [options]

Options:
  --pool <name>      Pool name to create (default: zdx_fixture)
  --dir <path>       Fixture directory (default: fixtures/offline/<pool>)
  --size <value>     Backing image size for truncate (default: 512M)
  --force            Overwrite existing fixture image/metadata
  -h, --help         Show this help

This script creates a small file-backed pool, seeds sample datasets/files,
exports the pool, and writes fixture metadata for offline-mode testing.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pool)
      shift
      POOL="${1:-}"
      ;;
    --dir)
      shift
      FIXTURE_DIR="${1:-}"
      ;;
    --size)
      shift
      SIZE="${1:-}"
      ;;
    --force)
      FORCE=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ -z "$POOL" ]]; then
  echo "error: pool name cannot be empty" >&2
  exit 2
fi

if [[ -z "$FIXTURE_DIR" ]]; then
  FIXTURE_DIR="fixtures/offline/$POOL"
fi

for cmd in zpool zfs truncate mktemp; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: missing required command '$cmd'" >&2
    exit 2
  fi
done

if sudo zpool list -H -o name "$POOL" >/dev/null 2>&1; then
  echo "error: pool '$POOL' is already imported; export/destroy it first" >&2
  exit 1
fi

mkdir -p "$FIXTURE_DIR"
FIXTURE_DIR="$(cd "$FIXTURE_DIR" && pwd)"
IMAGE="$FIXTURE_DIR/${POOL}.img"
META="$FIXTURE_DIR/fixture.json"

if [[ -e "$IMAGE" && "$FORCE" -ne 1 ]]; then
  echo "error: fixture image already exists: $IMAGE (use --force to overwrite)" >&2
  exit 1
fi

if [[ "$FORCE" -eq 1 ]]; then
  rm -f "$IMAGE" "$META"
fi

MNT="$(mktemp -d /tmp/zdx-fixture-mnt.XXXXXX)"
POOL_CREATED=0

cleanup() {
  if [[ "$POOL_CREATED" -eq 1 ]] && sudo zpool list -H -o name "$POOL" >/dev/null 2>&1; then
    sudo zpool export "$POOL" >/dev/null 2>&1 || true
  fi
  rm -rf "$MNT"
}
trap cleanup EXIT

echo "==> Creating fixture image: $IMAGE"
truncate -s "$SIZE" "$IMAGE"

echo "==> Creating pool '$POOL' (altroot: $MNT)"
sudo zpool create -f -R "$MNT" -o cachefile=none "$POOL" "$IMAGE"
POOL_CREATED=1

echo "==> Seeding datasets and sample files"
sudo zfs create "$POOL/local"
sudo zfs create "$POOL/local/home"
sudo zfs create "$POOL/local/app"
sudo zfs create "$POOL/replica"

sudo sh -c "echo 'zfs explorer fixture' > '$MNT/$POOL/local/home/hello.txt'"
sudo sh -c "echo '{\"fixture\":true}' > '$MNT/$POOL/local/app/config.json'"
sudo dd if=/dev/zero of="$MNT/$POOL/local/app/payload.bin" bs=1024 count=32 status=none
sudo zfs snapshot "$POOL/local/home@day0"

echo "==> Exporting pool '$POOL' for offline use"
sudo zpool export "$POOL"
POOL_CREATED=0

cat >"$META" <<EOF
{
  "pool": "$POOL",
  "image": "$IMAGE",
  "search_paths": "$FIXTURE_DIR",
  "size": "$SIZE"
}
EOF

echo
echo "Fixture created:"
echo "  Pool:         $POOL"
echo "  Image:        $IMAGE"
echo "  Search paths: $FIXTURE_DIR"
echo "  Metadata:     $META"
echo
echo "Use with offline backend:"
echo "  ZFS_EXPLORER_POOL_MODE=offline"
echo "  ZFS_EXPLORER_OFFLINE_POOLS=$POOL"
echo "  ZFS_EXPLORER_OFFLINE_PATHS=$FIXTURE_DIR"
