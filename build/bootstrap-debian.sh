#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ZFS_PACKAGES=1
INSTALL_ZFS_TEST=1
ADD_BACKPORTS=1
SKIP_SUBMODULES=0

usage() {
  cat <<'EOF'
Usage: build/bootstrap-debian.sh [options]

Bootstrap a fresh Debian/Ubuntu-like host for zfs-explorer development.

Options:
  --skip-zfs-packages   Do not install host OpenZFS runtime packages
  --skip-zfs-test       Do not install zfs-test
  --skip-backports      Do not add Debian backports apt source
  --skip-submodules     Do not run git submodule init/update
  -h, --help            Show help

Notes:
  - This script installs apt dependencies only.
  - Rust toolchain install (rustup) remains a separate step if cargo is missing.
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
    --skip-backports)
      ADD_BACKPORTS=0
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

if [[ -z "${VERSION_CODENAME:-}" ]]; then
  echo "error: VERSION_CODENAME not set in /etc/os-release" >&2
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
  if [[ "$ADD_BACKPORTS" -eq 1 ]]; then
    backports_file="/etc/apt/sources.list.d/backports.list"
    backports_line="deb http://deb.debian.org/debian ${VERSION_CODENAME}-backports main contrib"
    echo "==> Ensuring backports source is configured: $backports_file"
    if ! sudo grep -qF "$backports_line" "$backports_file" 2>/dev/null; then
      echo "$backports_line" | sudo tee "$backports_file" >/dev/null
      sudo apt-get update
    fi
  fi

  echo "==> Installing host OpenZFS runtime packages"
  sudo apt-get install -y -t "${VERSION_CODENAME}-backports" \
    zfsutils-linux zfs-dkms zfs-zed libzfslinux-dev

  if [[ "$INSTALL_ZFS_TEST" -eq 1 ]]; then
    echo "==> Installing zfs-test (optional but recommended for smoke scripts)"
    sudo apt-get install -y -t "${VERSION_CODENAME}-backports" zfs-test
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

echo "Bootstrap complete."
echo "Next steps:"
echo "  ./build/build.sh --bootstrap-openzfs"

