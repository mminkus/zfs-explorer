#!/usr/bin/env bash
set -euo pipefail

if ! command -v curl >/dev/null 2>&1; then
  echo "error: curl is required" >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required" >&2
  exit 2
fi

if [[ $# -lt 1 ]]; then
  cat >&2 <<'USAGE'
Usage:
  build/check-offline-parity.sh <pool> [objid...]

Environment:
  LIVE_BASE_URL     Base URL for live-mode backend (default: http://127.0.0.1:9000)
  OFFLINE_BASE_URL  Base URL for offline-mode backend (default: http://127.0.0.1:9001)

Example:
  LIVE_BASE_URL=http://127.0.0.1:9000 \
  OFFLINE_BASE_URL=http://127.0.0.1:9001 \
  build/check-offline-parity.sh nexus 1 32 34 54
USAGE
  exit 2
fi

POOL="$1"
shift || true

LIVE_BASE_URL="${LIVE_BASE_URL:-http://127.0.0.1:9000}"
OFFLINE_BASE_URL="${OFFLINE_BASE_URL:-http://127.0.0.1:9001}"

if [[ $# -gt 0 ]]; then
  OBJIDS=("$@")
else
  OBJIDS=(1 32 34)
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

normalize_json() {
  local in_file="$1"
  local out_file="$2"

  if jq -S . "$in_file" >/dev/null 2>&1; then
    jq -S . "$in_file" >"$out_file"
  else
    cp "$in_file" "$out_file"
  fi
}

fetch_endpoint() {
  local base_url="$1"
  local path="$2"
  local prefix="$3"

  local raw_file="$WORKDIR/${prefix}.raw"
  local body_file="$WORKDIR/${prefix}.body"
  local norm_file="$WORKDIR/${prefix}.norm"
  local status_file="$WORKDIR/${prefix}.status"

  local status
  if ! status="$(curl -sS -o "$body_file" -w "%{http_code}" "${base_url}${path}")"; then
    status="000"
  fi

  printf "%s" "$status" >"$status_file"
  normalize_json "$body_file" "$norm_file"
  cat "$norm_file" >"$raw_file"
}

compare_path() {
  local path="$1"
  local label="$2"
  local live_prefix="live$(echo "$label" | tr '/:?&=' '_')"
  local off_prefix="off$(echo "$label" | tr '/:?&=' '_')"

  fetch_endpoint "$LIVE_BASE_URL" "$path" "$live_prefix"
  fetch_endpoint "$OFFLINE_BASE_URL" "$path" "$off_prefix"

  local live_status
  local off_status
  live_status="$(cat "$WORKDIR/${live_prefix}.status")"
  off_status="$(cat "$WORKDIR/${off_prefix}.status")"

  if [[ "$live_status" != "$off_status" ]]; then
    echo "MISMATCH: $label (status live=$live_status offline=$off_status)"
    return 1
  fi

  if ! diff -u "$WORKDIR/${live_prefix}.raw" "$WORKDIR/${off_prefix}.raw" >/dev/null; then
    echo "MISMATCH: $label (body differs)"
    diff -u "$WORKDIR/${live_prefix}.raw" "$WORKDIR/${off_prefix}.raw" || true
    return 1
  fi

  echo "OK: $label"
  return 0
}

failures=0

compare_path "/api/pools/${POOL}/dsl/root" "dsl_root" || failures=$((failures + 1))

for objid in "${OBJIDS[@]}"; do
  compare_path "/api/pools/${POOL}/obj/${objid}" "obj_${objid}" || failures=$((failures + 1))
  compare_path "/api/pools/${POOL}/obj/${objid}/full" "obj_full_${objid}" || failures=$((failures + 1))
  compare_path "/api/pools/${POOL}/obj/${objid}/zap/info" "zap_info_${objid}" || failures=$((failures + 1))
  compare_path "/api/pools/${POOL}/obj/${objid}/zap?cursor=0&limit=128" "zap_entries_${objid}" || failures=$((failures + 1))
done

if [[ $failures -ne 0 ]]; then
  echo
  echo "Parity check failed: ${failures} mismatches found."
  exit 1
fi

echo
echo "Parity check passed: live and offline responses match for checked endpoints."
