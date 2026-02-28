#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_OS="$(uname -s 2>/dev/null || echo unknown)"

if [[ -n "${MAKE:-}" ]]; then
  MAKE_CMD="$MAKE"
elif [[ "$HOST_OS" == "FreeBSD" ]] && command -v gmake >/dev/null 2>&1; then
  MAKE_CMD="gmake"
else
  MAKE_CMD="make"
fi

RUN_UI_BUILD=1

print_usage() {
  cat <<'USAGE'
Usage: build/test-quick.sh [options]

Fast local test loop (no fixture matrix):
  1) backend unit tests
  2) native unit tests
  3) UI build (optional)

Options:
  --skip-ui-build   Skip UI build step
  -h, --help        Show this help
USAGE
}

log_step() {
  echo
  echo "==> $*"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-ui-build)
      RUN_UI_BUILD=0
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      print_usage
      exit 1
      ;;
  esac
  shift
done

log_step "[native] build shim library"
(
  cd "$ROOT_DIR/native"
  "$MAKE_CMD"
)

log_step "[unit] backend (cargo test)"
(
  cd "$ROOT_DIR/backend"
  LD_LIBRARY_PATH=../native:../_deps/openzfs/lib cargo test
)

log_step "[unit] native (make test-native-unit)"
(
  cd "$ROOT_DIR/native"
  "$MAKE_CMD" test-native-unit
)

if [[ "$RUN_UI_BUILD" -eq 1 ]]; then
  log_step "[ui] npm run build"
  (
    cd "$ROOT_DIR/ui"
    npm run build
  )
else
  log_step "[ui] skipped (--skip-ui-build)"
fi

echo
echo "Quick tests passed."
echo "Fixture/matrix checks are separate:"
echo "  build/create-corpus-matrix.sh"
echo "  sudo build/test-corpus-matrix.sh"
