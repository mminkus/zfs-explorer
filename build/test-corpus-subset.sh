#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="fixtures/corpus"
BACKEND_BIN="./backend/target/debug/zfs-explorer"
BASE_URL="http://127.0.0.1:9000"
STRICT=0
LIST_ONLY=0

usage() {
  cat <<'EOF'
Usage: sudo build/test-corpus-subset.sh [options]

Run the minimal offline corpus subset from Milestone O.5:
  - mirror + baseline
  - raidz1 + baseline
  - encryption-no-key (any vdev layout)

Options:
  --root <path>        Corpus root directory (default: fixtures/corpus)
  --backend <path>     Backend binary path (default: ./backend/target/debug/zfs-explorer)
  --base-url <url>     Backend base URL (default: http://127.0.0.1:9000)
  --strict             Fail if any expected fixture profile is missing
  --list               Print selected manifests and exit
  -h, --help           Show help

Notes:
  - This wrapper calls build/test-corpus-fixture.sh for each selected fixture.
  - Root privileges are required to run offline checks against raw vdev images.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      shift
      ROOT_DIR="${1:-}"
      ;;
    --backend)
      shift
      BACKEND_BIN="${1:-}"
      ;;
    --base-url)
      shift
      BASE_URL="${1:-}"
      ;;
    --strict)
      STRICT=1
      ;;
    --list)
      LIST_ONLY=1
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

if [[ ! -d "$ROOT_DIR" ]]; then
  echo "error: corpus root not found: $ROOT_DIR" >&2
  exit 1
fi

find_first_manifest() {
  local pattern="$1"
  local result=""
  # shellcheck disable=SC2206
  local matches=( $pattern )
  if [[ ${#matches[@]} -gt 0 && -f "${matches[0]}" ]]; then
    result="${matches[0]}"
  fi
  printf '%s' "$result"
}

mirror_manifest="$(
  find_first_manifest \
    "$ROOT_DIR/vdevtype=mirror/features=baseline/*/manifest.json"
)"
raidz1_manifest="$(
  find_first_manifest \
    "$ROOT_DIR/vdevtype=raidz1/features=baseline/*/manifest.json"
)"
encrypted_manifest="$(
  find_first_manifest \
    "$ROOT_DIR/vdevtype=*/features=encryption-no-key/*/manifest.json"
)"

declare -a manifests=()
declare -a missing=()

if [[ -n "$mirror_manifest" ]]; then
  manifests+=("$mirror_manifest")
else
  missing+=("mirror/baseline")
fi

if [[ -n "$raidz1_manifest" ]]; then
  manifests+=("$raidz1_manifest")
else
  missing+=("raidz1/baseline")
fi

if [[ -n "$encrypted_manifest" ]]; then
  manifests+=("$encrypted_manifest")
else
  missing+=("*/encryption-no-key")
fi

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "warning: missing expected corpus fixtures:" >&2
  for item in "${missing[@]}"; do
    echo "  - $item" >&2
  done
  if [[ "$STRICT" -eq 1 ]]; then
    exit 1
  fi
fi

if [[ ${#manifests[@]} -eq 0 ]]; then
  if [[ "$LIST_ONLY" -eq 1 ]]; then
    echo "No fixtures selected." >&2
    exit 0
  fi
  echo "error: no fixtures selected from $ROOT_DIR" >&2
  exit 1
fi

echo "Selected corpus manifests (${#manifests[@]}):"
for manifest in "${manifests[@]}"; do
  echo "  - $manifest"
done

if [[ "$LIST_ONLY" -eq 1 ]]; then
  exit 0
fi

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "error: run as root (offline pool/media access is required)" >&2
  exit 1
fi

for manifest in "${manifests[@]}"; do
  echo
  echo "==> Validating $(dirname "$manifest")"
  build/test-corpus-fixture.sh \
    --manifest "$manifest" \
    --backend "$BACKEND_BIN" \
    --base-url "$BASE_URL"
done

echo
echo "Corpus subset validation passed."
