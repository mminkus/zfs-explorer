#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SKIP_SUBMODULES=0

usage() {
  cat <<'EOF'
Usage: build/bootstrap-freebsd.sh [options]

Bootstrap a FreeBSD host for zfs-explorer development.

Options:
  --skip-submodules   Do not run git submodule init/update
  -h, --help          Show help

Notes:
  - Installs pkg dependencies only.
  - Rust toolchain install (rustup) remains separate if cargo is missing.
  - build/build.sh auto-uses gmake on FreeBSD and sets /usr/local include/lib.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-submodules)
      SKIP_SUBMODULES=1
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

if [ "$(uname -s 2>/dev/null || echo unknown)" != "FreeBSD" ]; then
  echo "error: this bootstrap script targets FreeBSD hosts only" >&2
  exit 1
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "error: sudo is required" >&2
  exit 1
fi

echo "==> Installing base build dependencies"
sudo pkg update
sudo pkg install -y \
  git bash gmake automake autoconf libtool gettext pkgconf \
  python3 llvm node npm curl jq ksh93

echo "==> Ensuring python build modules for OpenZFS configure"
python3 -m ensurepip --upgrade >/dev/null 2>&1 || true
python3 -m pip install --user --upgrade setuptools packaging cffi >/dev/null

if [ "$SKIP_SUBMODULES" -ne 1 ]; then
  echo "==> Initializing git submodules"
  git -C "$ROOT_DIR" submodule update --init --recursive
fi

echo
if ! command -v cargo >/dev/null 2>&1; then
  echo "Rust toolchain not found (cargo missing). Install with:"
  echo "  curl https://sh.rustup.rs -sSf | sh"
  echo "  source \"\$HOME/.cargo/env\""
  echo
fi

echo "Bootstrap complete."
echo "Next steps:"
echo "  env MAKE=gmake build/build.sh --bootstrap-openzfs"
