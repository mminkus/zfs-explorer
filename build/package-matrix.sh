#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="release"
VERSION_LABEL="auto"
OUTPUT_ROOT="$ROOT_DIR/dist/releases/$(date -u +%Y%m%dT%H%M%SZ)"
DOCKER_BIN="${DOCKER_BIN:-docker}"
SKIP_LINUX=0
SKIP_FREEBSD=1
SKIP_UI_BUILD=0
KEEP_INTERMEDIATE=0

LINUX_TARGETS=(debian12 debian13 ubuntu2204 ubuntu2404 ubuntu2504 rocky9 alma10)
FREEBSD_HOST=""
FREEBSD_REPO_PATH="/home/martin/development/zfs-explorer"
FREEBSD_SSH_OPTS=""

usage() {
  cat <<'EOF'
Usage: build/package-matrix.sh [options]

Build release bundles for a distro matrix:
- Linux targets built in Docker containers
- Optional FreeBSD build via SSH

Options:
  --profile <debug|release>     Package profile (default: release)
  --version-label <value>       Version label in artifact names (default: auto)
  --output-root <path>          Output root (default: dist/releases/<utc-ts>)
  --linux-targets <csv>         Linux targets:
                                debian12,debian13,ubuntu2204,ubuntu2404,
                                ubuntu2504,rocky9,alma10
                                (default: all)
  --skip-linux                  Skip Linux Docker builds
  --skip-freebsd                Skip FreeBSD remote build (default: skipped)
  --freebsd-host <host>         FreeBSD SSH host
                                (required to enable FreeBSD build)
  --freebsd-repo <path>         Repo path on FreeBSD host
                                (default: /home/martin/development/zfs-explorer)
  --freebsd-ssh-opts <string>   Extra ssh/scp options
  --skip-ui-build               Skip local UI build check/build
                                (requires ui/dist to exist)
  --keep-intermediate           Keep intermediate dist/package-matrix outputs
  -h, --help                    Show help

Examples:
  build/package-matrix.sh
  build/package-matrix.sh --linux-targets debian13,ubuntu2404 --skip-freebsd
  build/package-matrix.sh --version-label v1.0.0-rc1
  build/package-matrix.sh --freebsd-host freebsd.example.net
  build/package-matrix.sh --output-root dist/releases/rc1
EOF
}

parse_csv() {
  local input="$1"
  local -n out_ref="$2"
  out_ref=()
  IFS=',' read -r -a raw <<<"$input"
  for item in "${raw[@]}"; do
    item="${item//[[:space:]]/}"
    [[ -n "$item" ]] && out_ref+=("$item")
  done
}

validate_linux_target() {
  case "$1" in
    debian12|debian13|ubuntu2204|ubuntu2404|ubuntu2504|rocky9|alma10) ;;
    *)
      echo "error: unsupported linux target '$1'" >&2
      exit 2
      ;;
  esac
}

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log() {
  echo "[$(timestamp)] $*"
}

ensure_tool() {
  local tool="$1"
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: required tool '$tool' not found in PATH" >&2
    exit 1
  fi
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
  printf '%s\n' "$raw" | sed -E 's/[^A-Za-z0-9._-]+/-/g; s/^-+//; s/-+$//'
}

ensure_docker_access() {
  if "$DOCKER_BIN" version >/dev/null 2>&1; then
    return
  fi
  cat >&2 <<'EOF'
error: docker is installed but not accessible for this user.
hint:
  - add your user to the docker group, then re-login/newgrp:
      sudo usermod -aG docker "$USER"
      newgrp docker
  - then verify:
      docker version
EOF
  exit 1
}

join_for_summary() {
  local arr=("$@")
  if [[ "${#arr[@]}" -eq 0 ]]; then
    echo "-"
    return
  fi
  local joined=""
  local item
  for item in "${arr[@]}"; do
    if [[ -z "$joined" ]]; then
      joined="$item"
    else
      joined="$joined, $item"
    fi
  done
  echo "$joined"
}

build_ui_if_needed() {
  if [[ "$SKIP_UI_BUILD" -eq 1 ]]; then
    if [[ ! -d "$ROOT_DIR/ui/dist" ]]; then
      echo "error: --skip-ui-build set but ui/dist is missing" >&2
      exit 1
    fi
    log "Using existing UI build at ui/dist"
    return
  fi

  ensure_tool npm
  log "Building UI once on host for packaging"
  (
    cd "$ROOT_DIR/ui"
    npm install
    npm run build
  )
}

dockerfile_for_target() {
  local target="$1"
  echo "$ROOT_DIR/packaging/docker/$target/Dockerfile"
}

image_for_target() {
  local target="$1"
  echo "zfs-explorer-package-${target}:latest"
}

linux_target_label() {
  local target="$1"
  case "$target" in
    debian12) echo "debian-12" ;;
    debian13) echo "debian-13" ;;
    ubuntu2204) echo "ubuntu-22.04" ;;
    ubuntu2404) echo "ubuntu-24.04" ;;
    ubuntu2504) echo "ubuntu-25.04" ;;
    rocky9) echo "el9" ;;
    alma10) echo "el10" ;;
    *) echo "$target" ;;
  esac
}

build_linux_target() {
  local target="$1"
  local label
  label="$(linux_target_label "$target")"
  local dockerfile
  dockerfile="$(dockerfile_for_target "$target")"
  local image
  image="$(image_for_target "$target")"
  local raw_dir="$ROOT_DIR/dist/package-matrix/$target/raw"
  local target_out_dir="$OUTPUT_ROOT/linux/$target"
  local log_file="$OUTPUT_ROOT/logs/linux-${target}.log"
  local uid gid
  uid="$(id -u)"
  gid="$(id -g)"

  if [[ ! -f "$dockerfile" ]]; then
    echo "error: missing Dockerfile for target '$target': $dockerfile" >&2
    return 1
  fi

  mkdir -p "$target_out_dir"
  mkdir -p "$(dirname "$log_file")"
  rm -rf "$raw_dir"
  mkdir -p "$raw_dir"

  log "Building Docker image for $target ($label)"
  {
    "$DOCKER_BIN" build \
      -f "$dockerfile" \
      -t "$image" \
      "$(dirname "$dockerfile")"
  } >"$log_file" 2>&1

  log "Building backend/package inside container for $target"
  {
    "$DOCKER_BIN" run --rm \
      --user "$uid:$gid" \
      -e HOME="/tmp" \
      -e CARGO_HOME="/tmp/cargo-home" \
      -e RUSTUP_HOME="/usr/local/rustup" \
      -e PATH="/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
      -e PROFILE="$PROFILE" \
      -e VERSION_LABEL="$VERSION_LABEL" \
      -v "$ROOT_DIR:/workspace" \
      -w /workspace \
      "$image" \
      bash -c '
        set -euo pipefail
        WORK_DIR="/tmp/zdx-src"
        OUT_DIR="/tmp/zdx-out"
        rm -rf "$WORK_DIR" "$OUT_DIR"
        mkdir -p "$WORK_DIR" "$OUT_DIR"

        # Build in an isolated workspace copy so each target gets a clean
        # _deps/openzfs tree and does not inherit host/container leftovers.
        rsync -a --delete \
          --exclude "/dist/" \
          --exclude "_deps/" \
          --exclude "backend/target/" \
          --exclude "ui/node_modules/" \
          /workspace/ "$WORK_DIR/"

        # package.sh --skip-build expects ui/dist to be present. We build the
        # UI once on the host and copy that artifact into each isolated build.
        if [[ -d /workspace/ui/dist ]]; then
          mkdir -p "$WORK_DIR/ui/dist"
          cp -a /workspace/ui/dist/. "$WORK_DIR/ui/dist/"
        fi

        ROOT_DIR="$WORK_DIR" PROFILE="$PROFILE" ./packaging/docker/build-release-backend.sh
        (cd "$WORK_DIR" && ./build/package.sh --profile "$PROFILE" --version-label "$VERSION_LABEL" --skip-build --output-dir "$OUT_DIR")
        cp -a "$OUT_DIR/." "/workspace/dist/package-matrix/'"$target"'/raw/"
      '
  } >>"$log_file" 2>&1

  local backend_tar
  backend_tar="$(find "$raw_dir" -maxdepth 1 -type f -name "zfs-explorer-zdx-api-*-${PROFILE}-*.tar.gz" | head -n1 || true)"
  if [[ -z "$backend_tar" ]]; then
    echo "error: backend tarball not found for $target (see $log_file)" >&2
    return 1
  fi

  local backend_base
  backend_base="$(basename "$backend_tar" .tar.gz)"
  local backend_out="$target_out_dir/${backend_base}-${label}.tar.gz"
  cp -f "$backend_tar" "$backend_out"

  local webui_tar
  webui_tar="$(find "$raw_dir" -maxdepth 1 -type f -name "zfs-explorer-webui-*.tar.gz" | head -n1 || true)"
  if [[ -n "$webui_tar" && ! -f "$OUTPUT_ROOT/$(basename "$webui_tar")" ]]; then
    cp -f "$webui_tar" "$OUTPUT_ROOT/$(basename "$webui_tar")"
  fi

  local version_file
  version_file="$(find "$raw_dir" -maxdepth 2 -type f -name VERSION.txt | head -n1 || true)"
  if [[ -f "$version_file" ]]; then
    cp -f "$version_file" "$target_out_dir/VERSION.txt"
  fi

  log "Completed $target -> $(basename "$backend_out")"
}

run_freebsd_build() {
  local log_file="$OUTPUT_ROOT/logs/freebsd.log"
  local target_out_dir="$OUTPUT_ROOT/freebsd"
  mkdir -p "$target_out_dir"
  mkdir -p "$(dirname "$log_file")"

  log "Building/package on FreeBSD host: $FREEBSD_HOST"
  {
    ssh $FREEBSD_SSH_OPTS "$FREEBSD_HOST" "cd '$FREEBSD_REPO_PATH' && git submodule update --init --recursive"
    ssh $FREEBSD_SSH_OPTS "$FREEBSD_HOST" "cd '$FREEBSD_REPO_PATH' && env MAKE=gmake ./build/build.sh --bootstrap-openzfs --openzfs-release"
    ssh $FREEBSD_SSH_OPTS "$FREEBSD_HOST" "cd '$FREEBSD_REPO_PATH' && env MAKE=gmake ./build/package.sh --profile '$PROFILE' --version-label '$VERSION_LABEL'"
  } >"$log_file" 2>&1

  local remote_backend_tar
  remote_backend_tar="$(ssh $FREEBSD_SSH_OPTS "$FREEBSD_HOST" "cd '$FREEBSD_REPO_PATH' && ls -1 dist/zfs-explorer-zdx-api-*-${PROFILE}-*.tar.gz 2>/dev/null | head -n1" || true)"
  if [[ -z "$remote_backend_tar" ]]; then
    echo "error: no FreeBSD backend tarball found (see $log_file)" >&2
    return 1
  fi

  local local_backend_name
  local_backend_name="$(basename "$remote_backend_tar")"
  scp $FREEBSD_SSH_OPTS "$FREEBSD_HOST:$FREEBSD_REPO_PATH/$remote_backend_tar" "$target_out_dir/$local_backend_name" >>"$log_file" 2>&1

  local remote_webui_tar
  remote_webui_tar="$(ssh $FREEBSD_SSH_OPTS "$FREEBSD_HOST" "cd '$FREEBSD_REPO_PATH' && ls -1 dist/zfs-explorer-webui-*.tar.gz 2>/dev/null | head -n1" || true)"
  if [[ -n "$remote_webui_tar" && ! -f "$OUTPUT_ROOT/$(basename "$remote_webui_tar")" ]]; then
    scp $FREEBSD_SSH_OPTS "$FREEBSD_HOST:$FREEBSD_REPO_PATH/$remote_webui_tar" "$OUTPUT_ROOT/$(basename "$remote_webui_tar")" >>"$log_file" 2>&1 || true
  fi

  log "Completed FreeBSD -> $local_backend_name"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      shift
      PROFILE="${1:-}"
      ;;
    --version-label)
      shift
      VERSION_LABEL="${1:-}"
      ;;
    --output-root)
      shift
      OUTPUT_ROOT="${1:-}"
      ;;
    --linux-targets)
      shift
      parse_csv "${1:-}" LINUX_TARGETS
      ;;
    --skip-linux)
      SKIP_LINUX=1
      ;;
    --skip-freebsd)
      SKIP_FREEBSD=1
      ;;
    --freebsd-host)
      shift
      FREEBSD_HOST="${1:-}"
      SKIP_FREEBSD=0
      ;;
    --freebsd-repo)
      shift
      FREEBSD_REPO_PATH="${1:-}"
      ;;
    --freebsd-ssh-opts)
      shift
      FREEBSD_SSH_OPTS="${1:-}"
      ;;
    --skip-ui-build)
      SKIP_UI_BUILD=1
      ;;
    --keep-intermediate)
      KEEP_INTERMEDIATE=1
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

if [[ "$PROFILE" != "debug" && "$PROFILE" != "release" ]]; then
  echo "error: unsupported profile '$PROFILE' (expected debug or release)" >&2
  exit 2
fi

if [[ "$VERSION_LABEL" == "auto" ]]; then
  VERSION_LABEL="$(git_build_version)"
fi
VERSION_LABEL="$(sanitize_version_label "$VERSION_LABEL")"
if [[ -z "$VERSION_LABEL" ]]; then
  echo "error: computed empty version label" >&2
  exit 2
fi

if [[ "$SKIP_LINUX" -eq 0 && "${#LINUX_TARGETS[@]}" -eq 0 ]]; then
  echo "error: at least one linux target is required unless --skip-linux is used" >&2
  exit 2
fi

for target in "${LINUX_TARGETS[@]}"; do
  validate_linux_target "$target"
done

if [[ "$SKIP_LINUX" -eq 1 && "$SKIP_FREEBSD" -eq 1 ]]; then
  echo "error: nothing selected (both --skip-linux and --skip-freebsd were set)" >&2
  exit 2
fi

if [[ "$SKIP_FREEBSD" -eq 0 && -z "$FREEBSD_HOST" ]]; then
  echo "error: --freebsd-host is required unless --skip-freebsd is set" >&2
  exit 2
fi

mkdir -p "$OUTPUT_ROOT/logs"

if [[ "$SKIP_LINUX" -eq 0 ]]; then
  ensure_tool "$DOCKER_BIN"
  ensure_docker_access
fi
if [[ "$SKIP_FREEBSD" -eq 0 ]]; then
  ensure_tool ssh
  ensure_tool scp
fi

if [[ "$SKIP_LINUX" -eq 0 ]]; then
  build_ui_if_needed
fi

declare -a PASSED=()
declare -a FAILED=()

if [[ "$SKIP_LINUX" -eq 0 ]]; then
  for target in "${LINUX_TARGETS[@]}"; do
    echo
    log "==> Linux target: $target"
    set +e
    build_linux_target "$target"
    rc=$?
    set -e
    if [[ "$rc" -eq 0 ]]; then
      PASSED+=("linux/$target")
    else
      FAILED+=("linux/$target")
      log "FAILED linux/$target"
    fi
  done
fi

if [[ "$SKIP_FREEBSD" -eq 0 ]]; then
  echo
  log "==> FreeBSD target: $FREEBSD_HOST"
  set +e
  run_freebsd_build
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    PASSED+=("freebsd/$FREEBSD_HOST")
  else
    FAILED+=("freebsd/$FREEBSD_HOST")
    log "FAILED freebsd/$FREEBSD_HOST"
  fi
fi

if ! find "$OUTPUT_ROOT" -maxdepth 1 -type f -name 'zfs-explorer-webui-*.tar.gz' | grep -q .; then
  echo "warning: no versioned zfs-explorer-webui tarball was collected from any target" >&2
fi

(
  cd "$OUTPUT_ROOT"
  find . -type f -name "*.tar.gz" -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS.txt || true
)

if [[ "$KEEP_INTERMEDIATE" -eq 0 ]]; then
  rm -rf "$ROOT_DIR/dist/package-matrix"
fi

echo
echo "Package matrix summary:"
echo "  Output: $OUTPUT_ROOT"
echo "  Passed: $(join_for_summary "${PASSED[@]}")"
echo "  Failed: $(join_for_summary "${FAILED[@]}")"

if [[ "${#FAILED[@]}" -gt 0 ]]; then
  exit 1
fi

exit 0
