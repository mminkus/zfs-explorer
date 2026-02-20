#!/usr/bin/env bash
set -euo pipefail

ZFS_TREE="zfs"
ZTS_SCRIPT="$ZFS_TREE/scripts/zfs-tests.sh"
FILEDIR="/tmp/zts-zfs-explorer"
SIZE="2G"
PROFILE="corpus"
KEEP_GOING=0
LIST_ONLY=0
TESTS_CSV=""
CLEANUP_ALL=0

declare -a PASSTHRU_ARGS=()

declare -a CORE_TESTS=(
  "tests/functional/cli_root/zpool_import/zpool_import_001_pos.ksh"
  "tests/functional/dedup/dedup_legacy_create.ksh"
  "tests/functional/features/large_dnode/large_dnode_001_pos.ksh"
  "tests/functional/vdev_zaps/vdev_zaps_001_pos.ksh"
)

declare -a CORPUS_EXTRA_TESTS=(
  "tests/functional/log_spacemap/log_spacemap_import_logs.ksh"
  "tests/functional/raidz/raidz_002_pos.ksh"
)

declare -a EXTENDED_EXTRA_TESTS=(
  "tests/functional/cli_root/zpool_import/zpool_import_encrypted.ksh"
  "tests/functional/cli_root/zfs_load-key/zfs_load-key.ksh"
  "tests/functional/block_cloning/block_cloning_copyfilerange.ksh"
  "tests/functional/zvol/zvol_cli/zvol_cli_001_pos.ksh"
)

usage() {
  cat <<'USAGE'
Usage: build/run-zts-smoke.sh [options] [-- <extra zfs-tests.sh args>]

Run a focused OpenZFS ZTS smoke set to validate fixture-oriented features.

Options:
  --profile <name>     core|corpus|extended (default: corpus)
  --tests <csv>        Comma-separated explicit test paths (overrides profile)
  --zfs-tree <path>    OpenZFS tree root (default: zfs)
  --filedir <path>     World-writable vdev temp dir (default: /tmp/zts-zfs-explorer)
  --size <value>       File-vdev size passed to zfs-tests.sh -s (default: 2G)
  --keep-going         Continue after failures and summarize at the end
  --cleanup-all        Run zfs-tests.sh -x once before tests (unsafe)
  --list               Print selected tests and exit
  -h, --help           Show this help

Notes:
- zfs-tests.sh must run as a non-root user with passwordless sudo.
- Tests run with: -q -f (quiet output + sparse files as vdevs).
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      shift
      PROFILE="${1:-}"
      ;;
    --tests)
      shift
      TESTS_CSV="${1:-}"
      ;;
    --zfs-tree)
      shift
      ZFS_TREE="${1:-}"
      ;;
    --filedir)
      shift
      FILEDIR="${1:-}"
      ;;
    --size)
      shift
      SIZE="${1:-}"
      ;;
    --keep-going)
      KEEP_GOING=1
      ;;
    --cleanup-all)
      CLEANUP_ALL=1
      ;;
    --list)
      LIST_ONLY=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      PASSTHRU_ARGS+=("$@")
      break
      ;;
    *)
      echo "error: unknown option '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ -z "$ZFS_TREE" ]]; then
  echo "error: zfs tree path cannot be empty" >&2
  exit 2
fi

ZTS_SCRIPT="$ZFS_TREE/scripts/zfs-tests.sh"
if [[ ! -x "$ZTS_SCRIPT" ]]; then
  echo "error: zfs-tests.sh not found or not executable: $ZTS_SCRIPT" >&2
  exit 1
fi

mkdir -p "$FILEDIR"
chmod 1777 "$FILEDIR" 2>/dev/null || true

if [[ ! -w "$FILEDIR" ]]; then
  echo "error: filedir is not writable: $FILEDIR" >&2
  exit 1
fi

declare -a TESTS=()

if [[ -n "$TESTS_CSV" ]]; then
  IFS=',' read -r -a TESTS <<<"$TESTS_CSV"
else
  case "$PROFILE" in
    core)
      TESTS=("${CORE_TESTS[@]}")
      ;;
    corpus)
      TESTS=("${CORE_TESTS[@]}" "${CORPUS_EXTRA_TESTS[@]}")
      ;;
    extended)
      TESTS=(
        "${CORE_TESTS[@]}"
        "${CORPUS_EXTRA_TESTS[@]}"
        "${EXTENDED_EXTRA_TESTS[@]}"
      )
      ;;
    *)
      echo "error: unsupported profile '$PROFILE' (use core|corpus|extended)" >&2
      exit 2
      ;;
  esac
fi

if [[ "${#TESTS[@]}" -eq 0 ]]; then
  echo "error: no tests selected" >&2
  exit 2
fi

echo "Selected ZTS tests (${#TESTS[@]}):"
for t in "${TESTS[@]}"; do
  echo "  - $t"
done

if [[ "$LIST_ONLY" -eq 1 ]]; then
  exit 0
fi

if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  echo "error: run as non-root user (zfs-tests.sh requires passwordless sudo)" >&2
  exit 1
fi

if ! sudo -n true >/dev/null 2>&1; then
  echo "error: passwordless sudo is required for zfs-tests.sh" >&2
  exit 1
fi

if [[ "$CLEANUP_ALL" -eq 1 ]]; then
  echo
  echo "==> Running unsafe cleanup (-x) before smoke set"
  "$ZTS_SCRIPT" -q -f -x -d "$FILEDIR" -s "$SIZE" "${PASSTHRU_ARGS[@]}"
fi

echo
pass_count=0
fail_count=0
idx=0
total="${#TESTS[@]}"

for test_path in "${TESTS[@]}"; do
  idx=$((idx + 1))
  echo "==> [$idx/$total] $test_path"

  set +e
  "$ZTS_SCRIPT" -q -f -d "$FILEDIR" -s "$SIZE" -t "$test_path" "${PASSTHRU_ARGS[@]}"
  rc=$?
  set -e

  if [[ "$rc" -eq 0 ]]; then
    pass_count=$((pass_count + 1))
    echo "PASS: $test_path"
  else
    fail_count=$((fail_count + 1))
    echo "FAIL: $test_path (exit $rc)" >&2
    if [[ "$KEEP_GOING" -ne 1 ]]; then
      echo
      echo "Stopping on first failure. Re-run with --keep-going to continue." >&2
      exit "$rc"
    fi
  fi

  echo

done

echo "ZTS smoke summary: pass=$pass_count fail=$fail_count total=$total"
if [[ "$fail_count" -ne 0 ]]; then
  exit 1
fi
