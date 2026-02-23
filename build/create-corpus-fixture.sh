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
  --profile <name>     Feature profile:
                       baseline|dedup|embedded-zstd|embedded-data|
                       large-dnode|block-cloning|zvol|bookmarks|
                       encryption-no-key|encryption-with-key|
                       degraded-missing-vdev
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
  baseline|dedup|embedded-zstd|embedded-data|large-dnode|block-cloning|zvol|bookmarks|encryption-no-key|encryption-with-key|degraded-missing-vdev) ;;
  *)
    echo "error: unsupported profile '$PROFILE'" >&2
    exit 2
    ;;
esac

for cmd in zpool zfs truncate mktemp jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: missing required command '$cmd'" >&2
    exit 2
  fi
done

PYTHON_BIN=""
for candidate in python3 python3.12 python3.11 python3.10; do
  if command -v "$candidate" >/dev/null 2>&1; then
    PYTHON_BIN="$candidate"
    break
  fi
done
if [[ -z "$PYTHON_BIN" ]]; then
  echo "error: missing required command 'python3' (or python3.x)" >&2
  exit 2
fi

SHA256_MODE=""
if command -v sha256sum >/dev/null 2>&1; then
  SHA256_MODE="gnu"
elif command -v sha256 >/dev/null 2>&1; then
  SHA256_MODE="bsd"
elif command -v shasum >/dev/null 2>&1; then
  SHA256_MODE="perl"
else
  echo "error: missing sha256 tool (sha256sum, sha256, or shasum)" >&2
  exit 2
fi

if sudo zpool list -H -o name "$POOL" >/dev/null 2>&1; then
  echo "error: pool '$POOL' is already imported; export/destroy it first" >&2
  exit 1
fi

FIXTURE_DIR="$ROOT_DIR/vdevtype=$LAYOUT/features=$PROFILE/$POOL"
mkdir -p "$FIXTURE_DIR"
FIXTURE_DIR="$(cd "$FIXTURE_DIR" && pwd)"
MANIFEST="$FIXTURE_DIR/manifest.json"

if [[ "$FORCE" -eq 1 ]]; then
  rm -f "$FIXTURE_DIR"/vdev-*.img "$FIXTURE_DIR"/vdev-*.img.missing "$MANIFEST"
fi

if compgen -G "$FIXTURE_DIR/vdev-*.img" >/dev/null || compgen -G "$FIXTURE_DIR/vdev-*.img.missing" >/dev/null; then
  echo "error: fixture images already exist under $FIXTURE_DIR (use --force)" >&2
  exit 1
fi

MNT="$(mktemp -d /tmp/zdx-corpus-mnt.XXXXXX)"
POOL_CREATED=0

cleanup() {
  if [[ "$POOL_CREATED" -eq 1 ]] && sudo zpool list -H -o name "$POOL" >/dev/null 2>&1; then
    sudo zpool export "$POOL" >/dev/null 2>&1 || true
  fi
  if [[ "${encrypted_mode:-none}" == "no-key" && -n "${encrypted_keyfile:-}" ]]; then
    rm -f "$encrypted_keyfile" >/dev/null 2>&1 || true
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
dnodesize="legacy"
encrypted_dataset=""
encrypted_keyfile=""
encrypted_mode="none"
degrade_missing_vdev=0
missing_vdev_path=""
missing_vdev_shadow=""
block_clone_mode="none"
large_dnode_xattrs=0
zvol_dataset=""
zvol_size=""
bookmark_names=()

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
  embedded-data)
    compression="lz4"
    recordsize="16K"
    dedup="off"
    ;;
  large-dnode)
    compression="lz4"
    recordsize="128K"
    dedup="off"
    dnodesize="auto"
    ;;
  block-cloning)
    compression="lz4"
    recordsize="1M"
    dedup="off"
    ;;
  zvol)
    compression="lz4"
    recordsize="128K"
    dedup="off"
    zvol_dataset="$POOL/vol0"
    zvol_size="64M"
    ;;
  bookmarks)
    compression="lz4"
    recordsize="128K"
    dedup="off"
    ;;
  encryption-no-key)
    compression="lz4"
    recordsize="128K"
    dedup="off"
    encrypted_dataset="$POOL/enc"
    encrypted_keyfile="$FIXTURE_DIR/enc.key"
    encrypted_mode="no-key"
    ;;
  encryption-with-key)
    compression="lz4"
    recordsize="128K"
    dedup="off"
    encrypted_dataset="$POOL/enc"
    encrypted_keyfile="$FIXTURE_DIR/enc.key"
    encrypted_mode="with-key"
    ;;
  degraded-missing-vdev)
    compression="lz4"
    recordsize="128K"
    dedup="off"
    degrade_missing_vdev=1
    ;;
esac

if [[ "$degrade_missing_vdev" -eq 1 && "$vdev_count" -lt 2 ]]; then
  echo "error: profile '$PROFILE' requires a redundant layout (mirror/raidz*)" >&2
  exit 2
fi

sudo zfs set compression="$compression" "$POOL/data"
sudo zfs set recordsize="$recordsize" "$POOL/data"
sudo zfs set dedup="$dedup" "$POOL/data"
sudo zfs set dnodesize="$dnodesize" "$POOL/data"
sudo zfs set atime=off "$POOL/data"
sudo zfs set xattr=sa "$POOL/data"

if [[ -n "$encrypted_dataset" ]]; then
  if [[ "$encrypted_mode" == "no-key" ]]; then
    echo "==> Creating encrypted dataset '$encrypted_dataset' (key intentionally removed)"
  else
    echo "==> Creating encrypted dataset '$encrypted_dataset' (key retained for offline decode checks)"
  fi
  sudo dd if=/dev/urandom of="$encrypted_keyfile" bs=32 count=1 status=none
  sudo zfs create \
    -o encryption=on \
    -o keyformat=raw \
    -o keylocation="file://$encrypted_keyfile" \
    "$encrypted_dataset"
fi

sudo sh -c "echo 'zfs-explorer corpus fixture (${LAYOUT}/${PROFILE})' > '$MNT/$POOL/data/docs/readme.txt'"
sudo dd if=/dev/urandom of="$MNT/$POOL/data/media/seed.bin" bs=1M count=8 status=none

if [[ "$PROFILE" == "embedded-data" ]]; then
  sudo sh -c "printf 'tiny-embedded-payload-0123456789abcdef' > '$MNT/$POOL/data/docs/embedded.txt'"
fi

if [[ "$PROFILE" == "large-dnode" ]]; then
  large_dnode_file="$MNT/$POOL/data/docs/large-dnode.txt"
  sudo sh -c "printf 'large dnode fixture payload\\n' > '$large_dnode_file'"
  large_dnode_xattrs="$(
    sudo "$PYTHON_BIN" - "$large_dnode_file" <<'PY'
import os
import sys

path = sys.argv[1]
payload = b"x" * 300
count = 0

if hasattr(os, "setxattr"):
    def set_attr(idx: int) -> None:
        os.setxattr(path, f"user.zdx{idx}", payload)
elif hasattr(os, "extattr_set_file"):
    namespace = getattr(os, "EXTATTR_NAMESPACE_USER", None)

    def set_attr(idx: int) -> None:
        attr = f"zdx{idx}"
        attempts = []
        if namespace is not None:
            attempts.append((path, namespace, attr, payload))
        attempts.append((path, f"user.{attr}", payload))
        attempts.append((path, attr, payload))

        last_type_error = None
        for args in attempts:
            try:
                os.extattr_set_file(*args)
                return
            except TypeError as exc:
                last_type_error = exc

        if last_type_error is not None:
            raise last_type_error
else:
    print(0)
    sys.exit(0)

for idx in range(128):
    try:
        set_attr(idx)
        count += 1
    except OSError:
        break

print(count)
PY
  )"
  large_dnode_xattrs="${large_dnode_xattrs//$'\n'/}"
  if [[ "$large_dnode_xattrs" == "0" ]]; then
    echo "warning: large-dnode xattrs unavailable on this host; proceeding with dnodesize=auto only" >&2
  fi
fi

if [[ "$PROFILE" == "block-cloning" ]]; then
  clone_target="$MNT/$POOL/data/media/clone-reflink.bin"
  if sudo cp --reflink=always "$MNT/$POOL/data/media/seed.bin" "$clone_target" 2>/dev/null; then
    block_clone_mode="reflink"
  else
    sudo cp "$MNT/$POOL/data/media/seed.bin" "$clone_target"
    block_clone_mode="copy"
  fi
fi

if [[ -n "$zvol_dataset" ]]; then
  echo "==> Creating zvol '$zvol_dataset' ($zvol_size)"
  sudo zfs create -V "$zvol_size" -o volblocksize=8K "$zvol_dataset"
fi

if [[ -n "$encrypted_dataset" ]]; then
  sudo sh -c "echo 'encrypted fixture payload' > '$MNT/$encrypted_dataset/secret.txt'"
fi

if [[ "$PROFILE" == "dedup" ]]; then
  for i in $(seq 1 16); do
    sudo cp "$MNT/$POOL/data/media/seed.bin" "$MNT/$POOL/data/media/clone-$i.bin"
  done
fi

if [[ "$encrypted_mode" == "no-key" && -n "$encrypted_dataset" ]]; then
  sudo zfs unload-key "$encrypted_dataset" >/dev/null 2>&1 || true
  rm -f "$encrypted_keyfile"
fi

sudo zfs snapshot "$POOL/data@seed"

if [[ "$PROFILE" == "bookmarks" ]]; then
  sudo sh -c "echo 'bookmark fixture payload' > '$MNT/$POOL/data/docs/bookmark.txt'"
  sudo zfs snapshot "$POOL/data@bookmark-a"
  sudo zfs bookmark "$POOL/data@seed" "$POOL/data#seed-bm"
  sudo zfs bookmark "$POOL/data@bookmark-a" "$POOL/data#bookmark-a-bm"
  bookmark_names=("$POOL/data#seed-bm" "$POOL/data#bookmark-a-bm")
fi

known_lines_file="$(mktemp /tmp/zdx-corpus-known.XXXXXX)"
feature_lines_file="$(mktemp /tmp/zdx-corpus-features.XXXXXX)"
trap 'rm -f "$known_lines_file" "$feature_lines_file"; cleanup' EXIT

add_known_file() {
  local rel_path="$1"
  local full_path="$2"
  local hash
  case "$SHA256_MODE" in
    gnu)
      hash="$(sha256sum "$full_path" | awk '{print $1}')"
      ;;
    bsd)
      hash="$(sha256 -q "$full_path")"
      ;;
    perl)
      hash="$(shasum -a 256 "$full_path" | awk '{print $1}')"
      ;;
    *)
      echo "error: unknown SHA256_MODE '$SHA256_MODE'" >&2
      exit 2
      ;;
  esac
  printf '%s|%s\n' "$rel_path" "$hash" >>"$known_lines_file"
}

add_known_file "$POOL/data/docs/readme.txt" "$MNT/$POOL/data/docs/readme.txt"
add_known_file "$POOL/data/media/seed.bin" "$MNT/$POOL/data/media/seed.bin"
if [[ "$PROFILE" == "dedup" ]]; then
  add_known_file "$POOL/data/media/clone-1.bin" "$MNT/$POOL/data/media/clone-1.bin"
fi
if [[ "$PROFILE" == "embedded-data" ]]; then
  add_known_file "$POOL/data/docs/embedded.txt" "$MNT/$POOL/data/docs/embedded.txt"
fi
if [[ "$PROFILE" == "large-dnode" ]]; then
  add_known_file "$POOL/data/docs/large-dnode.txt" "$MNT/$POOL/data/docs/large-dnode.txt"
fi
if [[ "$PROFILE" == "block-cloning" ]]; then
  add_known_file "$POOL/data/media/clone-reflink.bin" "$MNT/$POOL/data/media/clone-reflink.bin"
fi
if [[ "$PROFILE" == "bookmarks" ]]; then
  add_known_file "$POOL/data/docs/bookmark.txt" "$MNT/$POOL/data/docs/bookmark.txt"
fi
if [[ "$encrypted_mode" == "with-key" ]]; then
  add_known_file "$encrypted_dataset/secret.txt" "$MNT/$encrypted_dataset/secret.txt"
fi

sudo zpool get -H -o property,value all "$POOL" \
  | awk -F'\t' '$1 ~ /^feature@/ && $2 != "disabled" {sub(/^feature@/, "", $1); printf "%s|%s\n", $1, $2}' \
  | sort >"$feature_lines_file"

pool_guid="$(sudo zpool get -H -o value guid "$POOL")"
ddt_entries="$(sudo zpool status -D -p "$POOL" | awk '/dedup: DDT entries/ {print $4; exit}' || true)"
ddt_entries="${ddt_entries//,/}"
ddt_entries="${ddt_entries//[^0-9]/}"
if [[ -z "$ddt_entries" ]]; then
  ddt_entries="0"
fi

echo "==> Exporting pool '$POOL'"
sudo zpool export "$POOL"
POOL_CREATED=0

if [[ "$degrade_missing_vdev" -eq 1 ]]; then
  missing_vdev_path="${vdev_paths[$((vdev_count - 1))]}"
  missing_vdev_shadow="$missing_vdev_path.missing"
  echo "==> Simulating missing vdev for offline import: $(basename "$missing_vdev_path")"
  mv "$missing_vdev_path" "$missing_vdev_shadow"
fi

BOOKMARK_NAMES_CSV="$(IFS=,; echo "${bookmark_names[*]}")"

export POOL LAYOUT PROFILE SIZE FIXTURE_DIR MANIFEST compression recordsize dedup pool_guid ddt_entries encrypted_dataset
export encrypted_mode degrade_missing_vdev missing_vdev_path
export dnodesize block_clone_mode large_dnode_xattrs zvol_dataset
export BOOKMARK_NAMES_CSV
export KNOWN_LINES_FILE="$known_lines_file"
export FEATURE_LINES_FILE="$feature_lines_file"

"$PYTHON_BIN" <<'PY'
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
dnodesize = os.environ.get("dnodesize", "legacy")
pool_guid = os.environ["pool_guid"]
ddt_entries = int(os.environ["ddt_entries"])
encrypted_dataset = os.environ.get("encrypted_dataset", "")
encrypted_mode = os.environ.get("encrypted_mode", "none")
degrade_missing_vdev = os.environ.get("degrade_missing_vdev", "0") == "1"
missing_vdev_path = os.environ.get("missing_vdev_path", "")
block_clone_mode = os.environ.get("block_clone_mode", "none")
large_dnode_xattrs = int(os.environ.get("large_dnode_xattrs", "0") or "0")
zvol_dataset = os.environ.get("zvol_dataset", "")
bookmark_names = [
    item for item in os.environ.get("BOOKMARK_NAMES_CSV", "").split(",") if item
]

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
        "dnodesize": dnodesize,
        "atime": "off",
        "xattr": "sa",
    },
    "features_for_read": features,
    "known_files": known_files,
    "invariants": {
        "ddt_entries": ddt_entries,
    },
}

if encrypted_dataset:
    manifest.setdefault("expectations", {})
    expectation = "blocked" if encrypted_mode == "no-key" else "readable"
    manifest["expectations"]["encrypted_datasets"] = [
        {"name": encrypted_dataset, "expect": expectation}
    ]
    manifest["expectations"]["zap_unreadable_expected"] = encrypted_mode == "no-key"

if encrypted_mode == "with-key":
    manifest["fixture"]["encryption_key_paths"] = ["enc.key"]

if degrade_missing_vdev:
    manifest.setdefault("expectations", {})
    manifest["expectations"]["offline_degraded_expected"] = True
    if missing_vdev_path:
        missing_name = os.path.basename(missing_vdev_path)
        manifest["fixture"]["missing_vdev_images"] = [missing_name]

if block_clone_mode != "none":
    manifest["invariants"]["block_clone_mode"] = block_clone_mode

if large_dnode_xattrs > 0:
    manifest["invariants"]["large_dnode_xattrs"] = large_dnode_xattrs

if zvol_dataset:
    manifest["invariants"]["zvol_dataset"] = zvol_dataset

if bookmark_names:
    manifest["invariants"]["bookmarks"] = bookmark_names

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
echo "  sudo ./dist/zfs-explorer-zdx-api-debug-linux-x86_64/run-backend.sh"
