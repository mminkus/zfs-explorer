#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ZFS_PACKAGES=1
INSTALL_ZFS_TEST=1
SKIP_SUBMODULES=0

usage() {
  cat <<'EOF'
Usage: build/bootstrap-ubuntu.sh [options]

Bootstrap a fresh Ubuntu host for zfs-explorer development.

Options:
  --skip-zfs-packages   Do not install host ZFS runtime packages
  --skip-zfs-test       Do not install zfs-test (if available)
  --skip-submodules     Do not run git submodule init/update
  -h, --help            Show help

Notes:
  - Installs apt dependencies only.
  - Rust toolchain install (rustup) remains a separate step if cargo is missing.
  - Ubuntu's default Node.js may be too old for Vite 7; script warns if so.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-zfs-packages)
      INSTALL_ZFS_PACKAGES=0
      ;;
    --skip-zfs-test)
      INSTALL_ZFS_TEST=0
      ;;
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

if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
else
  echo "error: /etc/os-release not found; unsupported host" >&2
  exit 1
fi

if [[ "${ID:-}" != "ubuntu" ]]; then
  echo "error: this bootstrap script targets Ubuntu (detected ID='${ID:-unknown}')" >&2
  exit 1
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "error: sudo is required" >&2
  exit 1
fi

echo "==> Installing base build dependencies"
sudo apt-get update
sudo apt-get install -y \
  git build-essential autoconf automake libtool pkg-config m4 gawk \
  libssl-dev libelf-dev libudev-dev libblkid-dev uuid-dev zlib1g-dev \
  libzstd-dev libtirpc-dev clang libclang-dev \
  python3 python3-pip python3-setuptools python3-cffi libffi-dev \
  nodejs npm curl jq ksh

if [[ "$INSTALL_ZFS_PACKAGES" -eq 1 ]]; then
  echo "==> Installing host ZFS runtime packages"
  sudo apt-get install -y zfsutils-linux

  if apt-cache show zfs-zed >/dev/null 2>&1; then
    sudo apt-get install -y zfs-zed
  fi

  if [[ "$INSTALL_ZFS_TEST" -eq 1 ]]; then
    if apt-cache show zfs-test >/dev/null 2>&1; then
      echo "==> Installing zfs-test (optional but recommended for smoke scripts)"
      sudo apt-get install -y zfs-test
    else
      echo "note: package 'zfs-test' is not available in configured Ubuntu apt sources; skipping"
    fi
  fi
fi

if [[ "$SKIP_SUBMODULES" -ne 1 ]]; then
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

if command -v node >/dev/null 2>&1; then
  node_major="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
  if [[ "$node_major" -lt 20 ]]; then
    echo "warning: detected Node.js $(node -v); UI build prefers Node.js >= 20.19"
    echo "         current Ubuntu repo node may still build with warnings, but upgrade is recommended."
    echo
  fi
fi

echo "Bootstrap complete."
echo "Next steps:"
echo "  ./build/build.sh --bootstrap-openzfs"
