#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/workspace}"
PROFILE="${PROFILE:-release}"
OPENZFS_DEBUG="${OPENZFS_DEBUG:-0}"
ALLOW_OPENZFS_DRIFT="${ALLOW_OPENZFS_DRIFT:-0}"
export PATH="/usr/local/cargo/bin:${PATH}"

if [[ "$PROFILE" != "debug" && "$PROFILE" != "release" ]]; then
  echo "error: unsupported PROFILE '$PROFILE' (expected debug or release)" >&2
  exit 2
fi

if [[ ! -d "$ROOT_DIR/zfs" ]]; then
  echo "error: zfs submodule not found under $ROOT_DIR/zfs" >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  if [[ -x /usr/local/cargo/bin/cargo ]]; then
    export PATH="/usr/local/cargo/bin:${PATH}"
  fi
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo not found in container PATH (${PATH})" >&2
  exit 1
fi

jobs="$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 4)"
openzfs_src_dir="$ROOT_DIR/zfs"
openzfs_prefix_dir="$ROOT_DIR/_deps/openzfs"

cd "$ROOT_DIR"
git submodule update --init --recursive
check_args=(--mode error)
if [[ "$ALLOW_OPENZFS_DRIFT" == "1" ]]; then
  check_args+=(--allow-drift)
fi
"$ROOT_DIR/build/check-openzfs-submodule.sh" "${check_args[@]}"

cd "$openzfs_src_dir"
if [[ ! -f configure ]]; then
  ./autogen.sh
fi

local_dracutdir="$openzfs_prefix_dir/lib/dracut"
local_udevdir="$openzfs_prefix_dir/lib/udev"
local_udevruledir="$local_udevdir/rules.d"
local_systemdunitdir="$openzfs_prefix_dir/lib/systemd/system"
local_systemdpresetdir="$openzfs_prefix_dir/lib/systemd/system-preset"
local_systemdmodulesloaddir="$openzfs_prefix_dir/lib/modules-load.d"
local_systemdgeneratordir="$openzfs_prefix_dir/lib/systemd/system-generators"
local_initramfsdir="$openzfs_prefix_dir/share/initramfs-tools"
local_initconfdir="$openzfs_prefix_dir/etc/default"
local_bashcompletiondir="$openzfs_prefix_dir/share/bash-completion/completions"
local_mounthelperdir="$openzfs_prefix_dir/sbin"

./configure \
  --prefix="$openzfs_prefix_dir" \
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

make -j"$jobs"
make install \
  i_tdir="$local_initramfsdir" \
  initconfdir="$local_initconfdir" \
  bashcompletiondir="$local_bashcompletiondir"

cd "$ROOT_DIR/native"
make clean
make -j"$jobs"

cd "$ROOT_DIR/backend"
if [[ "$PROFILE" == "release" ]]; then
  cargo build --release
else
  cargo build
fi
