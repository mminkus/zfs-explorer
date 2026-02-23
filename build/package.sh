#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="debug"
OUTPUT_DIR="$ROOT_DIR/dist"
SKIP_BUILD=0
VERSION_LABEL="auto"
HOST_OS="$(uname -s 2>/dev/null || echo unknown)"

if [[ -n "${MAKE:-}" ]]; then
  MAKE_CMD="$MAKE"
elif [[ "$HOST_OS" == "FreeBSD" ]] && command -v gmake >/dev/null 2>&1; then
  MAKE_CMD="gmake"
else
  MAKE_CMD="make"
fi

print_usage() {
  cat <<'EOF'
Usage: build/package.sh [options]

Options:
  --profile <debug|release>   Backend build profile to package (default: debug)
  --version-label <value>     Version label in artifact names (default: auto)
  --output-dir <path>         Output directory for bundles/tarballs (default: ./dist)
  --skip-build                Do not rebuild native/backend/ui before packaging
  -h, --help                  Show this help

Examples:
  build/package.sh
  build/package.sh --profile release
  build/package.sh --version-label v1.0.0-rc1
  build/package.sh --profile release --skip-build
EOF
}

ensure_cargo() {
  if command -v cargo >/dev/null 2>&1; then
    return
  fi
  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1090
    source "$HOME/.cargo/env"
  fi
  if ! command -v cargo >/dev/null 2>&1; then
    echo "error: cargo not found (install rustup/cargo first)." >&2
    exit 1
  fi
}

ensure_npm() {
  if command -v npm >/dev/null 2>&1; then
    return
  fi
  echo "error: npm not found (install Node.js/npm first)." >&2
  exit 1
}

ensure_make_tool() {
  if command -v "$MAKE_CMD" >/dev/null 2>&1; then
    return
  fi
  echo "error: build tool '$MAKE_CMD' not found in PATH." >&2
  if [[ "$HOST_OS" == "FreeBSD" ]]; then
    echo "hint: install gmake (sudo pkg install -y gmake) or set MAKE=<tool>." >&2
  else
    echo "hint: install make/build-essential or set MAKE=<tool>." >&2
  fi
  exit 1
}

git_build_version() {
  local version
  version="$(git -C "$ROOT_DIR" describe --tags --dirty --always 2>/dev/null || true)"
  if [[ -z "$version" ]]; then
    version="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  fi
  printf '%s\n' "$version"
}

sanitize_version_label() {
  local raw="$1"
  # Keep filename-safe characters only.
  printf '%s\n' "$raw" | sed -E 's/[^A-Za-z0-9._-]+/-/g; s/^-+//; s/-+$//'
}

version_gt() {
  [[ "$(printf '%s\n' "$1" "$2" | sort -V | tail -n1)" == "$1" && "$1" != "$2" ]]
}

host_glibc_version() {
  local ver
  ver="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')"
  if [[ -z "${ver:-}" ]]; then
    ver="$(ldd --version 2>/dev/null | head -n1 | grep -oE '[0-9]+\.[0-9]+' | head -n1)"
  fi
  echo "${ver:-}"
}

required_glibc_for_vendored_openzfs() {
  local max_ver=""
  local lib
  for lib in "$ROOT_DIR/_deps/openzfs/lib/libzfs.so" \
             "$ROOT_DIR/_deps/openzfs/lib/libzpool.so" \
             "$ROOT_DIR/_deps/openzfs/lib/libnvpair.so"; do
    [[ -f "$lib" ]] || continue
    while IFS= read -r sym; do
      local cur
      cur="${sym#GLIBC_}"
      if [[ -z "$max_ver" ]] || version_gt "$cur" "$max_ver"; then
        max_ver="$cur"
      fi
    done < <(readelf -V "$lib" 2>/dev/null | grep -oE 'GLIBC_[0-9]+\.[0-9]+' | sort -u)
  done
  echo "$max_ver"
}

check_openzfs_glibc_compat() {
  local required host
  required="$(required_glibc_for_vendored_openzfs)"
  host="$(host_glibc_version)"

  if [[ -z "$required" || -z "$host" ]]; then
    return
  fi

  if version_gt "$required" "$host"; then
    echo "error: vendored OpenZFS libs require GLIBC_$required but host provides GLIBC_$host." >&2
    echo "hint: rebuild OpenZFS locally via: build/build.sh --bootstrap-openzfs" >&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      shift
      [[ $# -gt 0 ]] || { echo "error: --profile requires a value" >&2; exit 1; }
      PROFILE="$1"
      ;;
    --version-label)
      shift
      [[ $# -gt 0 ]] || { echo "error: --version-label requires a value" >&2; exit 1; }
      VERSION_LABEL="$1"
      ;;
    --output-dir)
      shift
      [[ $# -gt 0 ]] || { echo "error: --output-dir requires a value" >&2; exit 1; }
      OUTPUT_DIR="$1"
      ;;
    --skip-build)
      SKIP_BUILD=1
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

if [[ "$PROFILE" != "debug" && "$PROFILE" != "release" ]]; then
  echo "error: unsupported profile '$PROFILE' (expected debug or release)" >&2
  exit 1
fi

if [[ "$VERSION_LABEL" == "auto" ]]; then
  VERSION_LABEL="$(git_build_version)"
fi
VERSION_LABEL="$(sanitize_version_label "$VERSION_LABEL")"
if [[ -z "$VERSION_LABEL" ]]; then
  echo "error: computed empty version label" >&2
  exit 1
fi

check_openzfs_glibc_compat

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "==> Building native library"
  cd "$ROOT_DIR/native"
  ensure_make_tool
  "$MAKE_CMD" clean
  "$MAKE_CMD"

  echo "==> Building backend ($PROFILE)"
  ensure_cargo
  cd "$ROOT_DIR/backend"
  if [[ "$PROFILE" == "release" ]]; then
    cargo build --release
  else
    cargo build
  fi

  echo "==> Building UI"
  ensure_npm
  cd "$ROOT_DIR/ui"
  npm install
  npm run build
fi

BINARY_PATH="$ROOT_DIR/backend/target/$PROFILE/zfs-explorer"
if [[ ! -f "$BINARY_PATH" ]]; then
  echo "error: backend binary not found at $BINARY_PATH" >&2
  exit 1
fi

UI_DIST_DIR="$ROOT_DIR/ui/dist"
if [[ ! -d "$UI_DIST_DIR" ]]; then
  echo "error: UI build output not found at $UI_DIST_DIR" >&2
  echo "hint: run 'cd ui && npm install && npm run build' or omit --skip-build." >&2
  exit 1
fi

ARCH="$(uname -m)"
OS_NAME="$(uname -s | tr '[:upper:]' '[:lower:]')"
BACKEND_BUNDLE_NAME="zfs-explorer-zdx-api-${VERSION_LABEL}-${PROFILE}-${OS_NAME}-${ARCH}"
BACKEND_BUNDLE_DIR="$OUTPUT_DIR/$BACKEND_BUNDLE_NAME"
BACKEND_LIB_DIR="$BACKEND_BUNDLE_DIR/lib"
BACKEND_BIN_DIR="$BACKEND_BUNDLE_DIR/bin"
WEBUI_BUNDLE_NAME="zfs-explorer-webui-${VERSION_LABEL}"
WEBUI_BUNDLE_DIR="$OUTPUT_DIR/$WEBUI_BUNDLE_NAME"

echo "==> Preparing backend bundle at $BACKEND_BUNDLE_DIR"
rm -rf "$BACKEND_BUNDLE_DIR"
mkdir -p "$BACKEND_LIB_DIR" "$BACKEND_BIN_DIR"

cp "$BINARY_PATH" "$BACKEND_BIN_DIR/zfs-explorer"
cp "$ROOT_DIR/native/libzdbdecode.so" "$BACKEND_LIB_DIR/"
cp -a "$ROOT_DIR/_deps/openzfs/lib/"*.so* "$BACKEND_LIB_DIR/"

cat > "$BACKEND_BUNDLE_DIR/run-backend.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LD_LIBRARY_PATH="$HERE/lib:${LD_LIBRARY_PATH:-}"
exec "$HERE/bin/zfs-explorer" "$@"
EOF
chmod +x "$BACKEND_BUNDLE_DIR/run-backend.sh"

GIT_SHA="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
cat > "$BACKEND_BUNDLE_DIR/VERSION.txt" <<EOF
bundle=$BACKEND_BUNDLE_NAME
profile=$PROFILE
version_label=$VERSION_LABEL
git_sha=$GIT_SHA
created_utc=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
EOF

echo "==> Preparing web UI bundle at $WEBUI_BUNDLE_DIR"
rm -rf "$WEBUI_BUNDLE_DIR"
mkdir -p "$WEBUI_BUNDLE_DIR"
cp -a "$UI_DIST_DIR/." "$WEBUI_BUNDLE_DIR/"

cat > "$WEBUI_BUNDLE_DIR/run-webui.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-8080}"

if command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$HERE"
fi
if command -v python >/dev/null 2>&1; then
  exec python -m http.server "$PORT" --bind 127.0.0.1 --directory "$HERE"
fi
echo "error: python3/python not found; serve this directory with any static web server." >&2
exit 1
EOF
chmod +x "$WEBUI_BUNDLE_DIR/run-webui.sh"

cat > "$WEBUI_BUNDLE_DIR/VERSION.txt" <<EOF
bundle=$WEBUI_BUNDLE_NAME
version_label=$VERSION_LABEL
git_sha=$GIT_SHA
created_utc=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
EOF

echo "==> Creating tarballs"
mkdir -p "$OUTPUT_DIR"
tar -C "$OUTPUT_DIR" -czf "$OUTPUT_DIR/$BACKEND_BUNDLE_NAME.tar.gz" "$BACKEND_BUNDLE_NAME"
tar -C "$OUTPUT_DIR" -czf "$OUTPUT_DIR/$WEBUI_BUNDLE_NAME.tar.gz" "$WEBUI_BUNDLE_NAME"

echo
echo "Bundles ready:"
echo "  Backend directory: $BACKEND_BUNDLE_DIR"
echo "  Backend tarball:   $OUTPUT_DIR/$BACKEND_BUNDLE_NAME.tar.gz"
echo "  Web UI directory:  $WEBUI_BUNDLE_DIR"
echo "  Web UI tarball:    $OUTPUT_DIR/$WEBUI_BUNDLE_NAME.tar.gz"
