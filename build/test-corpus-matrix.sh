#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="fixtures/corpus"
BACKEND_BIN="./backend/target/debug/zfs-explorer"
BASE_URL="http://127.0.0.1:9000"
LIST_ONLY=0
STRICT=0
KEEP_GOING=0

LAYOUTS=(single mirror raidz1 raidz2 raidz3)
PROFILES=(
  baseline
  dedup
  embedded-zstd
  encryption-no-key
  encryption-with-key
  degraded-missing-vdev
)

usage() {
  cat <<'EOF'
Usage: sudo build/test-corpus-matrix.sh [options]

Run offline corpus smoke checks across a selected layout/profile matrix by
invoking build/test-corpus-fixture.sh for each discovered manifest.

Options:
  --layouts <csv>      Layouts: single,mirror,raidz1,raidz2,raidz3
                       (default: all)
  --profiles <csv>     Profiles:
                       baseline,dedup,embedded-zstd,encryption-no-key,
                       encryption-with-key,degraded-missing-vdev
                       (default: all)
  --root <path>        Corpus root directory (default: fixtures/corpus)
  --backend <path>     Backend binary path (default: ./backend/target/debug/zfs-explorer)
  --base-url <url>     Backend base URL (default: http://127.0.0.1:9000)
  --strict             Fail if any selected combination has no manifest
  --keep-going         Continue after failures and summarize
  --list               Print selected manifests and exit
  -h, --help           Show help

Examples:
  sudo build/test-corpus-matrix.sh --list
  sudo build/test-corpus-matrix.sh --strict
  sudo build/test-corpus-matrix.sh --layouts mirror,raidz1 --profiles baseline,dedup
EOF
}

parse_csv() {
  local input="$1"
  local -n out_ref="$2"
  out_ref=()
  IFS=',' read -r -a raw <<<"$input"
  for item in "${raw[@]}"; do
    item="${item//[[:space:]]/}"
    [[ -n "$item" ]] && out_ref+=("$item")
  done
}

validate_layout() {
  case "$1" in
    single|mirror|raidz1|raidz2|raidz3) ;;
    *)
      echo "error: unsupported layout '$1'" >&2
      exit 2
      ;;
  esac
}

validate_profile() {
  case "$1" in
    baseline|dedup|embedded-zstd|encryption-no-key|encryption-with-key|degraded-missing-vdev) ;;
    *)
      echo "error: unsupported profile '$1'" >&2
      exit 2
      ;;
  esac
}

profile_supported_on_layout() {
  local layout="$1"
  local profile="$2"
  case "$profile" in
    degraded-missing-vdev)
      [[ "$layout" != "single" ]]
      ;;
    *)
      return 0
      ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --layouts)
      shift
      parse_csv "${1:-}" LAYOUTS
      ;;
    --profiles)
      shift
      parse_csv "${1:-}" PROFILES
      ;;
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
    --keep-going)
      KEEP_GOING=1
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
if [[ "${#LAYOUTS[@]}" -eq 0 || "${#PROFILES[@]}" -eq 0 ]]; then
  echo "error: at least one layout/profile must be selected" >&2
  exit 2
fi

for layout in "${LAYOUTS[@]}"; do
  validate_layout "$layout"
done
for profile in "${PROFILES[@]}"; do
  validate_profile "$profile"
done

declare -a MANIFESTS=()
declare -a MISSING=()
declare -a SKIPPED=()

for layout in "${LAYOUTS[@]}"; do
  for profile in "${PROFILES[@]}"; do
    if ! profile_supported_on_layout "$layout" "$profile"; then
      SKIPPED+=("$layout/$profile")
      continue
    fi
    combo_dir="$ROOT_DIR/vdevtype=$layout/features=$profile"
    if [[ ! -d "$combo_dir" ]]; then
      MISSING+=("$layout/$profile")
      continue
    fi

    mapfile -t combo_manifests < <(
      find "$combo_dir" -mindepth 2 -maxdepth 2 -name manifest.json -print | sort
    )

    if [[ "${#combo_manifests[@]}" -eq 0 ]]; then
      MISSING+=("$layout/$profile")
      continue
    fi

    selected_manifest="$(
      find "$combo_dir" -mindepth 2 -maxdepth 2 -name manifest.json -printf '%T@ %p\n' \
        | sort -rn | awk 'NR==1 {print $2}'
    )"
    if [[ -z "$selected_manifest" ]]; then
      selected_manifest="${combo_manifests[0]}"
    fi
    MANIFESTS+=("$selected_manifest")

    if [[ "${#combo_manifests[@]}" -gt 1 ]]; then
      echo "warning: multiple manifests found for $layout/$profile; using newest:" >&2
      echo "  $selected_manifest" >&2
    fi
  done
done

if [[ "${#SKIPPED[@]}" -gt 0 ]]; then
  echo "note: skipped unsupported combinations:" >&2
  for item in "${SKIPPED[@]}"; do
    echo "  - $item" >&2
  done
fi

if [[ "${#MISSING[@]}" -gt 0 ]]; then
  echo "warning: missing manifests for selected combinations:" >&2
  for item in "${MISSING[@]}"; do
    echo "  - $item" >&2
  done
  if [[ "$STRICT" -eq 1 ]]; then
    exit 1
  fi
fi

if [[ "$LIST_ONLY" -eq 1 ]]; then
  if [[ "${#MANIFESTS[@]}" -eq 0 ]]; then
    echo "No manifests selected from $ROOT_DIR."
  else
    echo "Selected manifests (${#MANIFESTS[@]}):"
    for manifest in "${MANIFESTS[@]}"; do
      echo "  - $manifest"
    done
  fi
  exit 0
fi

if [[ "${#MANIFESTS[@]}" -eq 0 ]]; then
  echo "error: no manifests selected from $ROOT_DIR" >&2
  exit 1
fi

echo "Selected manifests (${#MANIFESTS[@]}):"
for manifest in "${MANIFESTS[@]}"; do
  echo "  - $manifest"
done

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "error: run as root (offline pool/media access is required)" >&2
  exit 1
fi

pass_count=0
fail_count=0

for manifest in "${MANIFESTS[@]}"; do
  echo
  echo "==> Validating $(dirname "$manifest")"
  set +e
  build/test-corpus-fixture.sh \
    --manifest "$manifest" \
    --backend "$BACKEND_BIN" \
    --base-url "$BASE_URL"
  rc=$?
  set -e

  if [[ "$rc" -eq 0 ]]; then
    pass_count=$((pass_count + 1))
    echo "PASS: $manifest"
  else
    fail_count=$((fail_count + 1))
    echo "FAIL: $manifest (exit $rc)" >&2
    if [[ "$KEEP_GOING" -ne 1 ]]; then
      echo
      echo "Stopping on first failure. Re-run with --keep-going to continue." >&2
      exit "$rc"
    fi
  fi
done

echo
echo "Corpus test matrix summary: pass=$pass_count fail=$fail_count total=${#MANIFESTS[@]}"
if [[ "$fail_count" -ne 0 ]]; then
  exit 1
fi
