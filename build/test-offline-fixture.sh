#!/usr/bin/env bash
set -euo pipefail

POOL=""
SEARCH_PATHS=""
BACKEND_BIN="./backend/target/debug/zfs-explorer"
BASE_URL="http://127.0.0.1:9000"
RUST_LOG_LEVEL="${RUST_LOG:-warn}"

usage() {
  cat <<'EOF'
Usage: sudo build/test-offline-fixture.sh --pool <name> --search-paths <paths> [options]

Required:
  --pool <name>             Pool name to open in offline mode
  --search-paths <paths>    Colon-separated search paths (fixture directory/device paths)

Optional:
  --backend <path>          Backend binary path (default: ./backend/target/debug/zfs-explorer)
  --base-url <url>          Backend base URL (default: http://127.0.0.1:9000)
  -h, --help                Show this help

This script starts a backend in offline mode and runs a small API smoke suite.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pool)
      shift
      POOL="${1:-}"
      ;;
    --search-paths)
      shift
      SEARCH_PATHS="${1:-}"
      ;;
    --backend)
      shift
      BACKEND_BIN="${1:-}"
      ;;
    --base-url)
      shift
      BASE_URL="${1:-}"
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

if [[ -z "$POOL" || -z "$SEARCH_PATHS" ]]; then
  echo "error: --pool and --search-paths are required" >&2
  usage >&2
  exit 2
fi

if [[ ! -x "$BACKEND_BIN" ]]; then
  echo "error: backend binary not executable: $BACKEND_BIN" >&2
  exit 1
fi

for cmd in curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: missing required command '$cmd'" >&2
    exit 2
  fi
done

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "error: run this script as root (backend requires privileged pool access)" >&2
  exit 1
fi

LOG_FILE="$(mktemp /tmp/zdx-offline-backend.XXXXXX.log)"
PID=""

cleanup() {
  if [[ -n "$PID" ]]; then
    kill "$PID" >/dev/null 2>&1 || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -f "$LOG_FILE"
}
trap cleanup EXIT

echo "==> Starting backend in offline mode"
(
  export ZFS_EXPLORER_POOL_MODE=offline
  export ZFS_EXPLORER_OFFLINE_POOLS="$POOL"
  export ZFS_EXPLORER_OFFLINE_PATHS="$SEARCH_PATHS"
  export RUST_LOG="$RUST_LOG_LEVEL"
  exec "$BACKEND_BIN"
) >"$LOG_FILE" 2>&1 &
PID="$!"

echo "==> Waiting for backend readiness at $BASE_URL"
for _ in $(seq 1 60); do
  if curl -sS "$BASE_URL/api/version" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if ! curl -sS "$BASE_URL/api/version" >/dev/null 2>&1; then
  echo "error: backend did not become ready" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

echo "==> Running offline smoke checks"

VERSION_JSON="$(curl -fsS "$BASE_URL/api/version")"
echo "$VERSION_JSON" | jq -e '.pool_open.mode == "offline"' >/dev/null \
  || { echo "error: /api/version does not report offline mode" >&2; exit 1; }

POOLS_JSON="$(curl -fsS "$BASE_URL/api/pools")"
echo "$POOLS_JSON" | jq -e --arg pool "$POOL" 'index($pool) != null' >/dev/null \
  || { echo "error: pool '$POOL' missing from /api/pools in offline mode" >&2; exit 1; }

DSL_ROOT_JSON="$(curl -fsS "$BASE_URL/api/pools/$POOL/dsl/root")"
echo "$DSL_ROOT_JSON" | jq -e '.root_dir_obj | type == "number"' >/dev/null \
  || { echo "error: /api/pools/$POOL/dsl/root missing numeric root_dir_obj" >&2; exit 1; }

MOS_LIST_JSON="$(curl -fsS "$BASE_URL/api/pools/$POOL/mos/objects?start=0&limit=32")"
echo "$MOS_LIST_JSON" | jq -e '.objects | type == "array"' >/dev/null \
  || { echo "error: /api/pools/$POOL/mos/objects did not return an objects array" >&2; exit 1; }

FIRST_OBJ="$(
  curl -fsS "$BASE_URL/api/pools/$POOL/mos/objects?start=0&limit=1" \
    | jq -r '.objects[0].id // empty'
)"
if [[ -n "$FIRST_OBJ" ]]; then
  OBJ_JSON="$(curl -fsS "$BASE_URL/api/pools/$POOL/obj/$FIRST_OBJ")"
  echo "$OBJ_JSON" \
    | jq -e --argjson id "$FIRST_OBJ" '((.id? // .object.id?) == $id)' >/dev/null \
    || { echo "error: /api/pools/$POOL/obj/$FIRST_OBJ id mismatch" >&2; exit 1; }
fi
echo
echo "Offline fixture smoke checks passed."
