#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="fixtures/corpus"
SIZE="512M"
POOL_PREFIX="zdx"
FORCE=0
KEEP_GOING=0
LIST_ONLY=0

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
Usage: build/create-corpus-matrix.sh [options]

Create a corpus matrix by generating fixture pools for selected
layout/profile combinations.

Options:
  --layouts <csv>      Layouts: single,mirror,raidz1,raidz2,raidz3
                       (default: all)
  --profiles <csv>     Profiles:
                       baseline,dedup,embedded-zstd,encryption-no-key,
                       encryption-with-key,degraded-missing-vdev
                       (default: all)
  --pool-prefix <str>  Pool name prefix (default: zdx)
  --root <path>        Corpus root directory (default: fixtures/corpus)
  --size <value>       Per-vdev image size (default: 512M)
  --force              Overwrite existing fixture contents
  --keep-going         Continue after failures and summarize
  --list               Print planned combinations and exit
  -h, --help           Show help

Pool naming:
  <pool-prefix>_<layout>_<profile-with-dashes-replaced-by-underscores>

Examples:
  build/create-corpus-matrix.sh --list
  build/create-corpus-matrix.sh --force
  build/create-corpus-matrix.sh --layouts mirror,raidz1 --profiles baseline,dedup
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
    --pool-prefix)
      shift
      POOL_PREFIX="${1:-}"
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

if [[ "${#LAYOUTS[@]}" -eq 0 ]]; then
  echo "error: at least one layout must be selected" >&2
  exit 2
fi
if [[ "${#PROFILES[@]}" -eq 0 ]]; then
  echo "error: at least one profile must be selected" >&2
  exit 2
fi
if [[ -z "$POOL_PREFIX" ]]; then
  echo "error: --pool-prefix cannot be empty" >&2
  exit 2
fi

for layout in "${LAYOUTS[@]}"; do
  validate_layout "$layout"
done
for profile in "${PROFILES[@]}"; do
  validate_profile "$profile"
done

declare -a TASKS=()
declare -a SKIPPED=()
for layout in "${LAYOUTS[@]}"; do
  for profile in "${PROFILES[@]}"; do
    if ! profile_supported_on_layout "$layout" "$profile"; then
      SKIPPED+=("$layout/$profile")
      continue
    fi
    profile_pool="${profile//-/_}"
    pool="${POOL_PREFIX}_${layout}_${profile_pool}"
    manifest="$ROOT_DIR/vdevtype=$layout/features=$profile/$pool/manifest.json"
    TASKS+=("$layout|$profile|$pool|$manifest")
  done
done

echo "Planned corpus fixture combinations (${#TASKS[@]}):"
for task in "${TASKS[@]}"; do
  IFS='|' read -r layout profile pool manifest <<<"$task"
  echo "  - $layout / $profile"
  echo "    pool: $pool"
  echo "    manifest: $manifest"
done

if [[ "${#SKIPPED[@]}" -gt 0 ]]; then
  echo "Skipped unsupported combinations (${#SKIPPED[@]}):"
  for item in "${SKIPPED[@]}"; do
    echo "  - $item"
  done
fi

if [[ "$LIST_ONLY" -eq 1 ]]; then
  exit 0
fi

fail_count=0
pass_count=0

for task in "${TASKS[@]}"; do
  IFS='|' read -r layout profile pool manifest <<<"$task"
  echo
  echo "==> Creating $layout / $profile (pool: $pool)"
  args=(
    --pool "$pool"
    --layout "$layout"
    --profile "$profile"
    --root "$ROOT_DIR"
    --size "$SIZE"
  )
  if [[ "$FORCE" -eq 1 ]]; then
    args+=(--force)
  fi

  set +e
  build/create-corpus-fixture.sh "${args[@]}"
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    pass_count=$((pass_count + 1))
    echo "PASS: $layout / $profile"
  else
    fail_count=$((fail_count + 1))
    echo "FAIL: $layout / $profile (exit $rc)" >&2
    if [[ "$KEEP_GOING" -ne 1 ]]; then
      echo
      echo "Stopping on first failure. Re-run with --keep-going to continue." >&2
      exit "$rc"
    fi
  fi
done

echo
echo "Corpus create matrix summary: pass=$pass_count fail=$fail_count total=${#TASKS[@]}"
if [[ "$fail_count" -ne 0 ]]; then
  exit 1
fi
