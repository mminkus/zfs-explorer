#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
OPENZFS_SRC_DIR="${OPENZFS_SRC_DIR:-$ROOT_DIR/zfs}"
CHECK_MODE="${OPENZFS_SUBMODULE_CHECK_MODE:-error}"
ALLOW_DRIFT="${ALLOW_OPENZFS_DRIFT:-0}"

print_usage() {
  cat <<'EOF'
Usage: build/check-openzfs-submodule.sh [options]

Options:
  --mode <error|warn>   Check mode (default: error)
  --allow-drift         Continue with a warning if zfs/ differs
  -h, --help            Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      shift
      [[ $# -gt 0 ]] || { echo "error: --mode requires a value" >&2; exit 2; }
      CHECK_MODE="$1"
      ;;
    --allow-drift)
      ALLOW_DRIFT=1
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      print_usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ "$CHECK_MODE" != "error" && "$CHECK_MODE" != "warn" ]]; then
  echo "error: unsupported check mode '$CHECK_MODE' (expected error or warn)" >&2
  exit 2
fi

if ! command -v git >/dev/null 2>&1; then
  exit 0
fi

if ! git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

if [[ ! -d "$OPENZFS_SRC_DIR" ]]; then
  echo "error: OpenZFS submodule directory missing at $OPENZFS_SRC_DIR" >&2
  echo "hint: run 'git submodule update --init --recursive' from repo root." >&2
  exit 1
fi

expected_commit="$(git -C "$ROOT_DIR" rev-parse --verify :zfs 2>/dev/null || true)"
if [[ -z "$expected_commit" ]]; then
  expected_commit="$(git -C "$ROOT_DIR" rev-parse --verify HEAD:zfs 2>/dev/null || true)"
fi
actual_commit="$(git -C "$OPENZFS_SRC_DIR" rev-parse --verify HEAD 2>/dev/null || true)"
actual_desc="$(git -C "$OPENZFS_SRC_DIR" describe --always --dirty --tags 2>/dev/null || true)"
actual_branch="$(git -C "$OPENZFS_SRC_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"

if [[ -z "$expected_commit" || -z "$actual_commit" ]]; then
  echo "error: unable to resolve repo-pinned or current OpenZFS commit." >&2
  echo "hint: run 'git submodule update --init --recursive' from repo root." >&2
  exit 1
fi

if [[ "$actual_commit" != "$expected_commit" ]]; then
  level="error"
  exit_code=1
  if [[ "$CHECK_MODE" == "warn" || "$ALLOW_DRIFT" == "1" ]]; then
    level="warning"
    exit_code=0
  fi

  echo "$level: zfs/ is not at the repo-pinned OpenZFS commit." >&2
  echo "  expected: $expected_commit" >&2
  echo "  actual:   $actual_commit (${actual_branch:-unknown} ${actual_desc:-unknown})" >&2
  echo "hint: run 'git submodule update --init --recursive' from repo root." >&2
  echo "note: this repo currently pins an OpenZFS compatibility baseline for" >&2
  echo "older distro kernel modules; building a different zfs/ ref may crash" >&2
  echo "during pool open on Ubuntu and similar hosts." >&2
  if [[ "$ALLOW_DRIFT" == "1" ]]; then
    echo "note: continuing because ALLOW_OPENZFS_DRIFT=1 / --allow-openzfs-drift was set." >&2
  elif [[ "$CHECK_MODE" == "warn" ]]; then
    echo "note: continuing because this caller runs the check in warn mode." >&2
  else
    echo "hint: pass --allow-openzfs-drift to the calling script to override." >&2
  fi
  exit "$exit_code"
fi
