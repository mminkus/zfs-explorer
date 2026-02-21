#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPENZFS_SRC_DIR="$ROOT_DIR/zfs"
OPENZFS_PREFIX_DIR="$ROOT_DIR/_deps/openzfs"
HOST_OS="$(uname -s 2>/dev/null || echo unknown)"

if [[ -n "${MAKE:-}" ]]; then
  MAKE_CMD="$MAKE"
elif [[ "$HOST_OS" == "FreeBSD" ]] && command -v gmake >/dev/null 2>&1; then
  MAKE_CMD="gmake"
else
  MAKE_CMD="make"
fi

if command -v nproc >/dev/null 2>&1; then
  DEFAULT_JOBS="$(nproc)"
else
  DEFAULT_JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
fi

JOBS="$DEFAULT_JOBS"
QUICK_MODE=0
BOOTSTRAP_OPENZFS=0
SKIP_UI_INSTALL=0
OPENZFS_DEBUG=1

print_usage() {
  cat <<'EOF'
Usage: build/build.sh [options]

Options:
  --quick                Fast local loop:
                         (cd native && $MAKE clean && $MAKE)
                         (cd backend && cargo build)
                         (cd ui && npm run build)
  --bootstrap-openzfs    Build/install vendored OpenZFS userland into _deps/openzfs first
  --skip-ui-install      Skip npm install (useful when node_modules is already present)
  --openzfs-debug        Build vendored OpenZFS with debug enabled (default)
  --openzfs-release      Build vendored OpenZFS with debug disabled
  --jobs N               Parallel jobs for OpenZFS make
  -h, --help             Show this help

Examples:
  build/build.sh
  build/build.sh --quick
  build/build.sh --bootstrap-openzfs --jobs 16
  build/build.sh --bootstrap-openzfs --openzfs-release

Environment:
  MAKE                   Override make tool (default: gmake on FreeBSD, make otherwise)
EOF
}

log_step() {
  echo
  echo "==> $*"
}

append_env_once() {
  local var_name="$1"
  local token="$2"
  local current="${!var_name:-}"
  if [[ -z "$current" ]]; then
    printf -v "$var_name" "%s" "$token"
    export "$var_name"
    return
  fi
  if [[ " $current " == *" $token "* ]]; then
    return
  fi
  printf -v "$var_name" "%s %s" "$current" "$token"
  export "$var_name"
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

ensure_openzfs_submodule() {
  if [[ ! -f "$OPENZFS_SRC_DIR/configure.ac" || ! -f "$OPENZFS_SRC_DIR/module/zfs/spa.c" ]]; then
    echo "error: OpenZFS submodule is missing or not initialized at $OPENZFS_SRC_DIR" >&2
    echo "hint: run 'git submodule update --init --recursive' from repo root." >&2
    exit 1
  fi
}

ensure_make_tool() {
  if ! command -v "$MAKE_CMD" >/dev/null 2>&1; then
    echo "error: build tool '$MAKE_CMD' not found in PATH." >&2
    if [[ "$HOST_OS" == "FreeBSD" ]]; then
      echo "hint: install gmake (sudo pkg install -y gmake) or set MAKE=<tool>." >&2
    else
      echo "hint: install make/build-essential or set MAKE=<tool>." >&2
    fi
    exit 1
  fi
}

apply_host_build_defaults() {
  if [[ "$HOST_OS" != "FreeBSD" ]]; then
    return
  fi

  append_env_once CPPFLAGS "-I/usr/local/include"
  append_env_once LDFLAGS "-L/usr/local/lib"
  append_env_once LIBS "-lintl"

  if [[ -z "${LIBCLANG_PATH:-}" ]]; then
    local found
    found="$(
      find /usr/local -maxdepth 6 -type f \( -name 'libclang.so' -o -name 'libclang.so.*' \) \
        2>/dev/null | sort | tail -n1 || true
    )"
    if [[ -n "$found" ]]; then
      export LIBCLANG_PATH
      LIBCLANG_PATH="$(dirname "$found")"
    fi
  fi
}

bootstrap_openzfs() {
  ensure_openzfs_submodule
  ensure_make_tool

  log_step "Bootstrapping vendored OpenZFS userland"
  cd "$OPENZFS_SRC_DIR"

  if [[ ! -f configure ]]; then
    ./autogen.sh
  fi

  local local_dracutdir="$OPENZFS_PREFIX_DIR/lib/dracut"
  local local_udevdir="$OPENZFS_PREFIX_DIR/lib/udev"
  local local_udevruledir="$local_udevdir/rules.d"
  local local_systemdunitdir="$OPENZFS_PREFIX_DIR/lib/systemd/system"
  local local_systemdpresetdir="$OPENZFS_PREFIX_DIR/lib/systemd/system-preset"
  local local_systemdmodulesloaddir="$OPENZFS_PREFIX_DIR/lib/modules-load.d"
  local local_systemdgeneratordir="$OPENZFS_PREFIX_DIR/lib/systemd/system-generators"
  local local_initramfsdir="$OPENZFS_PREFIX_DIR/share/initramfs-tools"
  local local_initconfdir="$OPENZFS_PREFIX_DIR/etc/default"
  local local_bashcompletiondir="$OPENZFS_PREFIX_DIR/share/bash-completion/completions"
  local local_mounthelperdir="$OPENZFS_PREFIX_DIR/sbin"

  ./configure \
    --prefix="$OPENZFS_PREFIX_DIR" \
    --with-config=user \
    --with-dracutdir="$local_dracutdir" \
    --with-udevdir="$local_udevdir" \
    --with-udevruledir="$local_udevruledir" \
    --with-mounthelperdir="$local_mounthelperdir" \
    --with-systemdunitdir="$local_systemdunitdir" \
    --with-systemdpresetdir="$local_systemdpresetdir" \
    --with-systemdmodulesloaddir="$local_systemdmodulesloaddir" \
    --with-systemdgeneratordir="$local_systemdgeneratordir" \
    "$([ "$OPENZFS_DEBUG" -eq 1 ] && echo --enable-debug || echo --disable-debug)"
  "$MAKE_CMD" -j"$JOBS"
  "$MAKE_CMD" install \
    i_tdir="$local_initramfsdir" \
    initconfdir="$local_initconfdir" \
    bashcompletiondir="$local_bashcompletiondir"
}

build_native() {
  ensure_make_tool
  log_step "Building native library"
  cd "$ROOT_DIR/native"
  # Always rebuild native artifacts to avoid stale .so reuse across hosts.
  "$MAKE_CMD" clean
  "$MAKE_CMD"
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
    --openzfs-debug)
      OPENZFS_DEBUG=1
      ;;
    --openzfs-release)
      OPENZFS_DEBUG=0
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

ensure_openzfs_submodule
apply_host_build_defaults
check_openzfs_glibc_compat

build_native
build_backend
build_ui

echo
echo "Build complete."
