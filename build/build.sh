#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPENZFS_SRC_DIR="$ROOT_DIR/zfs"
OPENZFS_PREFIX_DIR="$ROOT_DIR/_deps/openzfs"

if command -v nproc >/dev/null 2>&1; then
  DEFAULT_JOBS="$(nproc)"
else
  DEFAULT_JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
fi

JOBS="$DEFAULT_JOBS"
QUICK_MODE=0
BOOTSTRAP_OPENZFS=0
SKIP_UI_INSTALL=0

print_usage() {
  cat <<'EOF'
Usage: build/build.sh [options]

Options:
  --quick                Fast local loop:
                         (cd native && make clean && make)
                         (cd backend && cargo build)
                         (cd ui && npm run build)
  --bootstrap-openzfs    Build/install vendored OpenZFS userland into _deps/openzfs first
  --skip-ui-install      Skip npm install (useful when node_modules is already present)
  --jobs N               Parallel jobs for OpenZFS make
  -h, --help             Show this help

Examples:
  build/build.sh
  build/build.sh --quick
  build/build.sh --bootstrap-openzfs --jobs 16
EOF
}

log_step() {
  echo
  echo "==> $*"
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
  for lib in "$OPENZFS_PREFIX_DIR/lib/libzfs.so" \
             "$OPENZFS_PREFIX_DIR/lib/libzpool.so" \
             "$OPENZFS_PREFIX_DIR/lib/libnvpair.so"; do
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

bootstrap_openzfs() {
  if [[ ! -d "$OPENZFS_SRC_DIR" ]]; then
    echo "error: missing OpenZFS source dir: $OPENZFS_SRC_DIR" >&2
    exit 1
  fi

  log_step "Bootstrapping vendored OpenZFS userland"
  cd "$OPENZFS_SRC_DIR"

  if [[ ! -f configure ]]; then
    ./autogen.sh
  fi

  ./configure --prefix="$OPENZFS_PREFIX_DIR" --with-config=user --enable-debug
  make -j"$JOBS"
  make install
}

build_native() {
  log_step "Building native library"
  cd "$ROOT_DIR/native"
  # Always rebuild native artifacts to avoid stale .so reuse across hosts.
  make clean
  make
}

build_backend() {
  log_step "Building backend"
  ensure_cargo
  cd "$ROOT_DIR/backend"
  cargo build
}

build_ui() {
  log_step "Building UI"
  cd "$ROOT_DIR/ui"

  if [[ "$QUICK_MODE" -eq 0 && "$SKIP_UI_INSTALL" -eq 0 ]]; then
    npm install
  fi

  npm run build
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick)
      QUICK_MODE=1
      ;;
    --bootstrap-openzfs)
      BOOTSTRAP_OPENZFS=1
      ;;
    --skip-ui-install)
      SKIP_UI_INSTALL=1
      ;;
    --jobs)
      shift
      if [[ $# -eq 0 ]]; then
        echo "error: --jobs requires a value" >&2
        exit 1
      fi
      JOBS="$1"
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

if [[ "$BOOTSTRAP_OPENZFS" -eq 1 ]]; then
  bootstrap_openzfs
fi

check_openzfs_glibc_compat

build_native
build_backend
build_ui

echo
echo "Build complete."
