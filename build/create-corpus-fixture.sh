#!/usr/bin/env bash
set -euo pipefail

POOL="zdx_corpus"
LAYOUT="mirror"
PROFILE="baseline"
ROOT_DIR="fixtures/corpus"
SIZE="512M"
FORCE=0

usage() {
  cat <<'EOF'
Usage: build/create-corpus-fixture.sh [options]

Options:
  --pool <name>        Pool name (default: zdx_corpus)
  --layout <type>      Vdev layout: single|mirror|raidz1|raidz2|raidz3
                       (default: mirror)
  --profile <name>     Feature profile: baseline|dedup|embedded-zstd
                       (default: baseline)
  --root <path>        Corpus root directory (default: fixtures/corpus)
  --size <value>       Per-vdev image size for truncate (default: 512M)
  --force              Overwrite existing fixture directory contents
  -h, --help           Show this help

Creates an exported, file-backed pool fixture under:
  <root>/vdevtype=<layout>/features=<profile>/<pool>

Writes:
  - vdev image files
  - manifest.json (layout, features, properties, known file checksums)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pool)
      shift
      POOL="${1:-}"
      ;;
    --layout)
      shift
      LAYOUT="${1:-}"
      ;;
    --profile)
      shift
      PROFILE="${1:-}"
      ;;
    --root)
      shift
      ROOT_DIR="${1:-}"
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

if [[ -z "$ROOT_DIR" ]]; then
  echo "error: root directory cannot be empty" >&2
  exit 2
fi

case "$LAYOUT" in
  single|mirror|raidz1|raidz2|raidz3) ;;
  *)
    echo "error: unsupported layout '$LAYOUT'" >&2
    exit 2
    ;;
esac

case "$PROFILE" in
  baseline|dedup|embedded-zstd) ;;
  *)
    echo "error: unsupported profile '$PROFILE'" >&2
    exit 2
    ;;
esac

for cmd in zpool zfs truncate mktemp jq sha256sum python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: missing required command '$cmd'" >&2
    exit 2
  fi
done

if sudo zpool list -H -o name "$POOL" >/dev/null 2>&1; then
  echo "error: pool '$POOL' is already imported; export/destroy it first" >&2
  exit 1
fi

FIXTURE_DIR="$ROOT_DIR/vdevtype=$LAYOUT/features=$PROFILE/$POOL"
mkdir -p "$FIXTURE_DIR"
FIXTURE_DIR="$(cd "$FIXTURE_DIR" && pwd)"
MANIFEST="$FIXTURE_DIR/manifest.json"

if [[ "$FORCE" -eq 1 ]]; then
  rm -f "$FIXTURE_DIR"/vdev-*.img "$MANIFEST"
fi

if compgen -G "$FIXTURE_DIR/vdev-*.img" >/dev/null; then
  echo "error: fixture images already exist under $FIXTURE_DIR (use --force)" >&2
  exit 1
fi

MNT="$(mktemp -d /tmp/zdx-corpus-mnt.XXXXXX)"
POOL_CREATED=0

cleanup() {
  if [[ "$POOL_CREATED" -eq 1 ]] && sudo zpool list -H -o name "$POOL" >/dev/null 2>&1; then
    sudo zpool export "$POOL" >/dev/null 2>&1 || true
  fi
  rm -rf "$MNT"
}
trap cleanup EXIT

vdev_count=1
create_tokens=()
case "$LAYOUT" in
  single)
    vdev_count=1
    ;;
  mirror)
    vdev_count=2
    create_tokens+=(mirror)
    ;;
  raidz1)
    vdev_count=3
    create_tokens+=(raidz1)
    ;;
  raidz2)
    vdev_count=4
    create_tokens+=(raidz2)
    ;;
  raidz3)
    vdev_count=5
    create_tokens+=(raidz3)
    ;;
esac

vdev_paths=()
for i in $(seq 0 $((vdev_count - 1))); do
  img="$FIXTURE_DIR/vdev-$i.img"
  echo "==> Creating vdev image: $img ($SIZE)"
  truncate -s "$SIZE" "$img"
  vdev_paths+=("$img")
done

echo "==> Creating pool '$POOL' ($LAYOUT)"
sudo zpool create -f -R "$MNT" -o cachefile=none "$POOL" \
  "${create_tokens[@]}" "${vdev_paths[@]}"
POOL_CREATED=1

echo "==> Seeding datasets/files"
sudo zfs create "$POOL/data"
sudo zfs create "$POOL/data/docs"
sudo zfs create "$POOL/data/media"

compression="lz4"
recordsize="128K"
dedup="off"

case "$PROFILE" in
  baseline)
    compression="lz4"
    recordsize="128K"
    dedup="off"
    ;;
  dedup)
    compression="lz4"
    recordsize="128K"
    dedup="on"
    ;;
  embedded-zstd)
    compression="zstd-5"
    recordsize="16K"
    dedup="off"
    ;;
esac

sudo zfs set compression="$compression" "$POOL/data"
sudo zfs set recordsize="$recordsize" "$POOL/data"
sudo zfs set dedup="$dedup" "$POOL/data"
sudo zfs set atime=off "$POOL/data"
sudo zfs set xattr=sa "$POOL/data"

sudo sh -c "echo 'zfs-explorer corpus fixture (${LAYOUT}/${PROFILE})' > '$MNT/$POOL/data/docs/readme.txt'"
sudo dd if=/dev/urandom of="$MNT/$POOL/data/media/seed.bin" bs=1M count=8 status=none

if [[ "$PROFILE" == "dedup" ]]; then
  for i in $(seq 1 16); do
    sudo cp "$MNT/$POOL/data/media/seed.bin" "$MNT/$POOL/data/media/clone-$i.bin"
  done
fi

sudo zfs snapshot "$POOL/data@seed"

known_lines_file="$(mktemp /tmp/zdx-corpus-known.XXXXXX)"
feature_lines_file="$(mktemp /tmp/zdx-corpus-features.XXXXXX)"
trap 'rm -f "$known_lines_file" "$feature_lines_file"; cleanup' EXIT

add_known_file() {
  local rel_path="$1"
  local full_path="$2"
  local hash
  hash="$(sha256sum "$full_path" | awk '{print $1}')"
  printf '%s|%s\n' "$rel_path" "$hash" >>"$known_lines_file"
}

add_known_file "$POOL/data/docs/readme.txt" "$MNT/$POOL/data/docs/readme.txt"
add_known_file "$POOL/data/media/seed.bin" "$MNT/$POOL/data/media/seed.bin"
if [[ "$PROFILE" == "dedup" ]]; then
  add_known_file "$POOL/data/media/clone-1.bin" "$MNT/$POOL/data/media/clone-1.bin"
fi

sudo zpool get -H -o property,value all "$POOL" \
  | awk -F'\t' '$1 ~ /^feature@/ && $2 != "disabled" {sub(/^feature@/, "", $1); printf "%s|%s\n", $1, $2}' \
  | sort >"$feature_lines_file"

pool_guid="$(sudo zpool get -H -o value guid "$POOL")"
ddt_entries="$(sudo zpool status -D -p "$POOL" | awk '/dedup: DDT entries/ {print $4; exit}' || true)"
if [[ -z "$ddt_entries" ]]; then
  ddt_entries="0"
fi

echo "==> Exporting pool '$POOL'"
sudo zpool export "$POOL"
POOL_CREATED=0

export POOL LAYOUT PROFILE SIZE FIXTURE_DIR MANIFEST compression recordsize dedup pool_guid ddt_entries
export KNOWN_LINES_FILE="$known_lines_file"
export FEATURE_LINES_FILE="$feature_lines_file"

python3 <<'PY'
import json
import os
from datetime import datetime, timezone

pool = os.environ["POOL"]
layout = os.environ["LAYOUT"]
profile = os.environ["PROFILE"]
size = os.environ["SIZE"]
fixture_dir = os.environ["FIXTURE_DIR"]
manifest_path = os.environ["MANIFEST"]
compression = os.environ["compression"]
recordsize = os.environ["recordsize"]
dedup = os.environ["dedup"]
pool_guid = os.environ["pool_guid"]
ddt_entries = int(os.environ["ddt_entries"])

known_files = []
with open(os.environ["KNOWN_LINES_FILE"], "r", encoding="utf-8") as fh:
    for line in fh:
        line = line.strip()
        if not line:
            continue
        path, sha256 = line.split("|", 1)
        known_files.append({"path": path, "sha256": sha256})

features = []
with open(os.environ["FEATURE_LINES_FILE"], "r", encoding="utf-8") as fh:
    for line in fh:
        line = line.strip()
        if not line:
            continue
        name, state = line.split("|", 1)
        features.append({"name": name, "state": state})

manifest = {
    "schema": 1,
    "created_at_utc": datetime.now(timezone.utc).isoformat(),
    "pool": {
        "name": pool,
        "guid": pool_guid,
        "layout": layout,
        "profile": profile,
    },
    "fixture": {
        "search_paths": fixture_dir,
        "vdev_glob": "vdev-*.img",
        "per_vdev_size": size,
    },
    "dataset_properties": {
        "compression": compression,
        "recordsize": recordsize,
        "dedup": dedup,
        "atime": "off",
        "xattr": "sa",
    },
    "features_for_read": features,
    "known_files": known_files,
    "invariants": {
        "ddt_entries": ddt_entries,
    },
}

with open(manifest_path, "w", encoding="utf-8") as fh:
    json.dump(manifest, fh, indent=2)
    fh.write("\n")
PY

echo
echo "Corpus fixture created:"
echo "  Pool:      $POOL"
echo "  Layout:    $LAYOUT"
echo "  Profile:   $PROFILE"
echo "  Directory: $FIXTURE_DIR"
echo "  Manifest:  $MANIFEST"
echo
echo "Offline run example:"
echo "  ZFS_EXPLORER_POOL_MODE=offline \\"
echo "  ZFS_EXPLORER_OFFLINE_POOLS=$POOL \\"
echo "  ZFS_EXPLORER_OFFLINE_PATHS=$FIXTURE_DIR \\"
echo "  sudo ./dist/zfs-explorer-debug-linux-x86_64/run-backend.sh"
