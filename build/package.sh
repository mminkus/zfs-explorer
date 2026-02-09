#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="debug"
OUTPUT_DIR="$ROOT_DIR/dist"
SKIP_BUILD=0

print_usage() {
  cat <<'EOF'
Usage: build/package.sh [options]

Options:
  --profile <debug|release>   Build profile to package (default: debug)
  --output-dir <path>         Output directory for bundle/tarball (default: ./dist)
  --skip-build                Do not rebuild native/backend before packaging
  -h, --help                  Show this help

Examples:
  build/package.sh
  build/package.sh --profile release
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

check_openzfs_glibc_compat

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "==> Building native library"
  cd "$ROOT_DIR/native"
  make clean
  make

  echo "==> Building backend ($PROFILE)"
  ensure_cargo
  cd "$ROOT_DIR/backend"
  if [[ "$PROFILE" == "release" ]]; then
    cargo build --release
  else
    cargo build
  fi
fi

BINARY_PATH="$ROOT_DIR/backend/target/$PROFILE/zfs-explorer"
if [[ ! -f "$BINARY_PATH" ]]; then
  echo "error: backend binary not found at $BINARY_PATH" >&2
  exit 1
fi

ARCH="$(uname -m)"
BUNDLE_NAME="zfs-explorer-${PROFILE}-linux-${ARCH}"
BUNDLE_DIR="$OUTPUT_DIR/$BUNDLE_NAME"
LIB_DIR="$BUNDLE_DIR/lib"
BIN_DIR="$BUNDLE_DIR/bin"

echo "==> Preparing bundle at $BUNDLE_DIR"
rm -rf "$BUNDLE_DIR"
mkdir -p "$LIB_DIR" "$BIN_DIR"

cp "$BINARY_PATH" "$BIN_DIR/zfs-explorer"
cp "$ROOT_DIR/native/libzdbdecode.so" "$LIB_DIR/"
cp -a "$ROOT_DIR/_deps/openzfs/lib/"*.so* "$LIB_DIR/"

cat > "$BUNDLE_DIR/run-backend.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LD_LIBRARY_PATH="$HERE/lib:${LD_LIBRARY_PATH:-}"
exec "$HERE/bin/zfs-explorer" "$@"
EOF
chmod +x "$BUNDLE_DIR/run-backend.sh"

GIT_SHA="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
cat > "$BUNDLE_DIR/VERSION.txt" <<EOF
bundle=$BUNDLE_NAME
profile=$PROFILE
git_sha=$GIT_SHA
created_utc=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
EOF

echo "==> Creating tarball"
mkdir -p "$OUTPUT_DIR"
tar -C "$OUTPUT_DIR" -czf "$OUTPUT_DIR/$BUNDLE_NAME.tar.gz" "$BUNDLE_NAME"

echo
echo "Bundle ready:"
echo "  Directory: $BUNDLE_DIR"
echo "  Tarball:   $OUTPUT_DIR/$BUNDLE_NAME.tar.gz"
