#!/usr/bin/env python3
"""Recover files recursively from a dataset or snapshot via zfs-explorer API (zdx-api).

This tool is CLI-first and optimized for bulk recovery workflows:
- Traverses directories through objset metadata APIs.
- Downloads file bytes via streaming ZPL download endpoint when possible.
- Falls back to objset data endpoint when streaming download fails.
- Supports resumable downloads and line-delimited manifest output.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Dict, Iterable, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


class ApiError(RuntimeError):
    """Raised when backend API requests fail."""


class BackendStartError(RuntimeError):
    """Raised when backend auto-start fails."""


class ManifestWriter:
    """Append-only NDJSON writer for per-file recovery records."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = self.path.open("w", encoding="utf-8")

    def write(self, record: Dict[str, object]) -> None:
        self._fh.write(json.dumps(record, sort_keys=False) + "\n")
        self._fh.flush()

    def close(self) -> None:
        self._fh.close()


class ApiClient:
    def __init__(self, base_url: str, timeout: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def get_json(self, path: str, params: Optional[Dict[str, object]] = None) -> object:
        url = f"{self.base_url}{path}"
        if params:
            encoded_params = {
                key: value for key, value in params.items() if value is not None
            }
            if encoded_params:
                url = f"{url}?{urlencode(encoded_params)}"

        request = Request(url, headers={"Accept": "application/json"})
        try:
            with urlopen(request, timeout=self.timeout) as response:
                payload = response.read().decode("utf-8")
        except HTTPError as err:
            payload = err.read().decode("utf-8", errors="replace")
            detail = self._extract_error_message(payload) or payload.strip() or str(err)
            raise ApiError(f"HTTP {err.code} for {path}: {detail}") from err
        except URLError as err:
            raise ApiError(f"request failed for {path}: {err}") from err

        try:
            return json.loads(payload)
        except json.JSONDecodeError as err:
            raise ApiError(f"invalid JSON from {path}: {err}") from err

    def stream_download(
        self,
        path: str,
        output_file,
        *,
        start_offset: int,
        chunk_size: int,
    ) -> Tuple[int, int, Dict[str, str]]:
        url = f"{self.base_url}{path}"
        headers = {"Accept": "application/octet-stream"}
        if start_offset > 0:
            headers["Range"] = f"bytes={start_offset}-"

        request = Request(url, headers=headers)
        try:
            with urlopen(request, timeout=self.timeout) as response:
                status = int(response.getcode())
                response_headers = {
                    key.lower(): value for key, value in response.headers.items()
                }

                written = 0
                while True:
                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    output_file.write(chunk)
                    written += len(chunk)

                return status, written, response_headers
        except HTTPError as err:
            payload = err.read().decode("utf-8", errors="replace")
            detail = self._extract_error_message(payload) or payload.strip() or str(err)
            raise ApiError(f"HTTP {err.code} for {path}: {detail}") from err
        except URLError as err:
            raise ApiError(f"request failed for {path}: {err}") from err

    @staticmethod
    def _extract_error_message(payload: str) -> Optional[str]:
        try:
            obj = json.loads(payload)
        except json.JSONDecodeError:
            return None
        if isinstance(obj, dict):
            for key in ("error", "message", "code"):
                value = obj.get(key)
                if isinstance(value, str) and value:
                    return value
        return None


@dataclass
class FilesystemTarget:
    pool: str
    dataset: str
    snapshot: Optional[str]
    objset_id: int


@dataclass
class RecoverStats:
    discovered_files: int = 0
    downloaded_files: int = 0
    skipped_files: int = 0
    failed_files: int = 0
    bytes_written: int = 0


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Recursively recover files from a dataset/snapshot via zfs-explorer API"
    )
    parser.add_argument(
        "--backend",
        default="http://127.0.0.1:9000",
        help="zfs-explorer backend base URL (default: %(default)s)",
    )
    parser.add_argument(
        "--filesystem",
        required=True,
        help="dataset or snapshot name (pool[/dataset][@snapshot])",
    )
    parser.add_argument(
        "--path",
        default="/",
        help="path within filesystem to recover (default: /)",
    )
    parser.add_argument(
        "--destination",
        required=True,
        help="local destination directory",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=1024 * 1024,
        help=(
            "read chunk size in bytes for HTTP streaming and objset reads "
            "(max 1048576, default: %(default)s)"
        ),
    )
    parser.add_argument(
        "--page-limit",
        type=int,
        default=500,
        help="directory page size for listing calls (default: %(default)s)",
    )
    parser.add_argument(
        "--max-files",
        type=int,
        default=0,
        help="stop after processing this many matched files (0 = unlimited)",
    )
    parser.add_argument(
        "--include",
        action="append",
        default=[],
        help="include glob pattern (can be repeated)",
    )
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        help="exclude glob pattern (can be repeated)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="enumerate only; do not write files",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="overwrite existing files instead of skipping/resuming",
    )
    parser.add_argument(
        "--no-resume",
        action="store_true",
        help="disable resume (default behavior resumes partial files)",
    )
    parser.add_argument(
        "--download-method",
        choices=["auto", "zpl", "objset"],
        default="auto",
        help=(
            "file content download method: auto (prefer zpl streaming, fallback to objset), "
            "zpl, or objset"
        ),
    )
    parser.add_argument(
        "--manifest",
        default="",
        help=(
            "write per-file NDJSON manifest to this path "
            "(default: <destination>/recover-manifest.ndjson)"
        ),
    )
    parser.add_argument(
        "--summary",
        default="",
        help=(
            "write summary JSON to this path "
            "(default: <destination>/recover-summary.json)"
        ),
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=30.0,
        help="request timeout in seconds (default: %(default)s)",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=2,
        help="retries per file download on transient failures (default: %(default)s)",
    )
    parser.add_argument(
        "--start-backend-if-needed",
        action="store_true",
        help="start backend if health check fails",
    )
    parser.add_argument(
        "--start-backend-cmd",
        default="",
        help="command to launch backend when auto-starting",
    )
    parser.add_argument(
        "--backend-ready-timeout",
        type=float,
        default=20.0,
        help="seconds to wait for backend after auto-start (default: %(default)s)",
    )
    parser.add_argument(
        "--leave-backend-running",
        action="store_true",
        help="do not terminate backend if this script auto-started it",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="print verbose progress",
    )

    args = parser.parse_args(argv)

    if args.chunk_size <= 0:
        parser.error("--chunk-size must be > 0")
    if args.page_limit <= 0:
        parser.error("--page-limit must be > 0")
    if args.max_files < 0:
        parser.error("--max-files must be >= 0")
    if args.retries < 0:
        parser.error("--retries must be >= 0")

    # objset data API currently maxes each request at 1 MiB.
    args.chunk_size = min(args.chunk_size, 1024 * 1024)
    return args


def normalize_subpath(path: str) -> str:
    text = (path or "/").strip()
    if not text:
        return "/"

    if not text.startswith("/"):
        text = "/" + text

    parts = [part for part in text.split("/") if part]
    if not parts:
        return "/"
    return "/" + "/".join(parts)


def parse_filesystem_spec(spec: str) -> Tuple[str, str, Optional[str]]:
    raw = spec.strip()
    if not raw:
        raise ValueError("filesystem spec cannot be empty")

    dataset = raw
    snapshot = None
    if "@" in raw:
        dataset, snapshot = raw.split("@", 1)
        dataset = dataset.strip()
        snapshot = snapshot.strip() or None

    if not dataset:
        raise ValueError("filesystem is missing dataset name")

    if "/" in dataset:
        pool = dataset.split("/", 1)[0]
    else:
        # Allow root dataset notation like "tank".
        pool = dataset

    if not pool:
        raise ValueError("filesystem is missing pool name")

    return pool, dataset, snapshot


def backend_is_ready(client: ApiClient) -> bool:
    try:
        payload = client.get_json("/api/version")
    except ApiError:
        return False
    return isinstance(payload, dict)


def launch_backend_if_needed(args: argparse.Namespace, client: ApiClient) -> Optional[subprocess.Popen]:
    if backend_is_ready(client):
        print(f"Backend is already reachable at {args.backend}")
        return None

    if not args.start_backend_if_needed and not args.start_backend_cmd:
        raise BackendStartError(
            f"backend is not reachable at {args.backend}; "
            "use --start-backend-if-needed or --start-backend-cmd"
        )

    cmd = args.start_backend_cmd.strip() or "./backend/target/debug/zfs-explorer"
    repo_root = Path(__file__).resolve().parents[1]

    print(f"Backend not reachable, launching: {cmd}")
    proc = subprocess.Popen(  # noqa: S602 - intentional operator-provided command
        cmd,
        shell=True,
        cwd=str(repo_root),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    deadline = time.time() + args.backend_ready_timeout
    while time.time() < deadline:
        if backend_is_ready(client):
            print(f"Backend became ready at {args.backend}")
            return proc
        if proc.poll() is not None:
            output = ""
            if proc.stdout is not None:
                output = proc.stdout.read().strip()
            raise BackendStartError(
                f"backend exited early while starting ({proc.returncode})\n{output}"
            )
        time.sleep(0.5)

    try:
        proc.terminate()
    except Exception:
        pass
    raise BackendStartError(
        f"backend did not become ready within {args.backend_ready_timeout:.1f}s"
    )


def find_dataset_dir_obj(client: ApiClient, pool: str, dataset: str) -> int:
    payload = client.get_json(
        f"/api/pools/{quote(pool, safe='')}/datasets/tree",
        {"depth": 64, "limit": 100000},
    )
    if not isinstance(payload, dict):
        raise ApiError("invalid dataset tree payload")

    root = payload.get("root")
    if not isinstance(root, dict):
        raise ApiError("dataset tree payload missing root")

    def walk(node: Dict[str, object], path_parts: List[str]) -> Optional[int]:
        name = node.get("name")
        if not isinstance(name, str):
            return None
        current = path_parts + [name]
        full_name = "/".join(current)
        if full_name == dataset:
            value = node.get("dsl_dir_obj")
            if isinstance(value, int):
                return value
            if isinstance(value, float):
                return int(value)
            return None

        children = node.get("children")
        if not isinstance(children, list):
            return None
        for child in children:
            if isinstance(child, dict):
                found = walk(child, current)
                if found is not None:
                    return found
        return None

    dsl_dir_obj = walk(root, [])
    if dsl_dir_obj is None:
        raise ApiError(
            f"dataset '{dataset}' not found under pool '{pool}' in /datasets/tree"
        )
    return dsl_dir_obj


def resolve_filesystem_target(client: ApiClient, fs_spec: str) -> FilesystemTarget:
    pool, dataset, snapshot = parse_filesystem_spec(fs_spec)
    dsl_dir_obj = find_dataset_dir_obj(client, pool, dataset)

    if snapshot:
        snapshots_payload = client.get_json(
            f"/api/pools/{quote(pool, safe='')}/dataset/{dsl_dir_obj}/snapshots"
        )
        entries = []
        if isinstance(snapshots_payload, dict):
            raw_entries = snapshots_payload.get("entries")
            if isinstance(raw_entries, list):
                entries = raw_entries

        dsobj = None
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            if entry.get("name") == snapshot:
                value = entry.get("dsobj")
                if isinstance(value, int):
                    dsobj = value
                    break
                if isinstance(value, float):
                    dsobj = int(value)
                    break

        if dsobj is None:
            raise ApiError(
                f"snapshot '{dataset}@{snapshot}' not found via dataset snapshot listing"
            )

        objset_payload = client.get_json(
            f"/api/pools/{quote(pool, safe='')}/snapshot/{dsobj}/objset"
        )
    else:
        objset_payload = client.get_json(
            f"/api/pools/{quote(pool, safe='')}/dataset/{dsl_dir_obj}/objset"
        )

    if not isinstance(objset_payload, dict):
        raise ApiError("invalid objset payload")

    objset_value = objset_payload.get("objset_id")
    if not isinstance(objset_value, (int, float)):
        raise ApiError("objset payload missing objset_id")

    return FilesystemTarget(
        pool=pool,
        dataset=dataset,
        snapshot=snapshot,
        objset_id=int(objset_value),
    )


def api_walk_path(client: ApiClient, target: FilesystemTarget, path: str) -> Dict[str, object]:
    payload = client.get_json(
        f"/api/pools/{quote(target.pool, safe='')}/objset/{target.objset_id}/walk",
        {"path": path},
    )
    if not isinstance(payload, dict):
        raise ApiError("invalid walk payload")
    return payload


def api_stat(client: ApiClient, target: FilesystemTarget, objid: int) -> Dict[str, object]:
    payload = client.get_json(
        f"/api/pools/{quote(target.pool, safe='')}/objset/{target.objset_id}/stat/{objid}"
    )
    if not isinstance(payload, dict):
        raise ApiError(f"invalid stat payload for object {objid}")
    return payload


def iter_directory_entries(
    client: ApiClient,
    target: FilesystemTarget,
    dir_obj: int,
    page_limit: int,
) -> Iterable[Dict[str, object]]:
    cursor: Optional[int] = 0
    while cursor is not None:
        payload = client.get_json(
            f"/api/pools/{quote(target.pool, safe='')}/objset/{target.objset_id}/dir/{dir_obj}/entries",
            {"cursor": cursor, "limit": page_limit},
        )
        if not isinstance(payload, dict):
            raise ApiError(f"invalid dir entries payload for object {dir_obj}")

        entries = payload.get("entries")
        if isinstance(entries, list):
            for entry in entries:
                if isinstance(entry, dict):
                    yield entry

        next_cursor = payload.get("next")
        if next_cursor is None:
            cursor = None
        elif isinstance(next_cursor, (int, float)):
            cursor = int(next_cursor)
        else:
            raise ApiError(f"invalid next cursor while listing directory {dir_obj}")


def should_include_path(rel_path: str, includes: List[str], excludes: List[str]) -> Tuple[bool, str]:
    if includes and not any(fnmatch.fnmatch(rel_path, pattern) for pattern in includes):
        return False, "include-filter"
    if excludes and any(fnmatch.fnmatch(rel_path, pattern) for pattern in excludes):
        return False, "exclude-filter"
    return True, ""


def filesystem_display_name(target: FilesystemTarget) -> str:
    if target.snapshot:
        return f"{target.dataset}@{target.snapshot}"
    return target.dataset


def ensure_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def build_pool_scoped_path(target: FilesystemTarget, filesystem_path: str) -> str:
    # filesystem_path is absolute within target filesystem, e.g. /data/docs/readme.txt
    if not filesystem_path.startswith("/"):
        raise ApiError(f"invalid filesystem path '{filesystem_path}' (expected absolute path)")
    return f"{target.dataset}{filesystem_path}"


def zpl_download_route(target: FilesystemTarget, filesystem_path: str) -> str:
    if not filesystem_path.startswith("/"):
        raise ApiError(f"invalid filesystem path '{filesystem_path}' (expected absolute path)")
    scoped_path = filesystem_path.lstrip("/")
    if not scoped_path:
        raise ApiError("invalid filesystem path '/' (expected file path)")
    pool_part = quote(target.pool, safe="")
    objset_part = quote(str(target.objset_id), safe="")
    path_part = quote(scoped_path, safe="/")
    return f"/api/pools/{pool_part}/objset/{objset_part}/zpl/path/{path_part}"


def write_failed_sidecar(local_path: Path, payload: Dict[str, object]) -> None:
    sidecar_path = local_path.with_name(local_path.name + ".FAILED.json")
    sidecar_path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def posix_join(base: str, name: str) -> str:
    if base == "/":
        return f"/{name}"
    return f"{base.rstrip('/')}/{name}"


def read_object_bytes(
    client: ApiClient,
    target: FilesystemTarget,
    objid: int,
    start_offset: int,
    chunk_size: int,
    output_file,
) -> int:
    offset = start_offset
    written = 0

    while True:
        payload = client.get_json(
            f"/api/pools/{quote(target.pool, safe='')}/objset/{target.objset_id}/obj/{objid}/data",
            {"offset": offset, "limit": chunk_size},
        )
        if not isinstance(payload, dict):
            raise ApiError(f"invalid data payload for object {objid}")

        data_hex = payload.get("data_hex", "")
        if not isinstance(data_hex, str):
            raise ApiError(f"invalid hex payload for object {objid}")

        chunk = bytes.fromhex(data_hex) if data_hex else b""
        if chunk:
            output_file.write(chunk)
            written += len(chunk)
            offset += len(chunk)

        eof = payload.get("eof")
        if bool(eof):
            break

        if not chunk:
            raise ApiError(
                f"empty non-EOF chunk while reading object {objid} at offset {offset}"
            )

    return written


def download_via_zpl(
    client: ApiClient,
    target: FilesystemTarget,
    filesystem_path: str,
    start_offset: int,
    chunk_size: int,
    output_file,
) -> int:
    route = zpl_download_route(target, filesystem_path)
    status, written, _headers = client.stream_download(
        route,
        output_file,
        start_offset=start_offset,
        chunk_size=chunk_size,
    )

    if start_offset > 0 and status != 206:
        raise ApiError(
            f"zpl download did not honor range resume for '{filesystem_path}' "
            f"(HTTP {status})"
        )
    if start_offset == 0 and status not in (200, 206):
        raise ApiError(
            f"unexpected HTTP status {status} while downloading '{filesystem_path}'"
        )

    return written


def choose_download_methods(args: argparse.Namespace, target: FilesystemTarget) -> List[str]:
    _ = target
    if args.download_method == "objset":
        return ["objset"]
    if args.download_method == "zpl":
        return ["zpl"]

    # auto mode: prefer zpl streaming, then fallback to objset reads.
    return ["zpl", "objset"]


def recover(
    args: argparse.Namespace,
    client: ApiClient,
    target: FilesystemTarget,
) -> int:
    start_path = normalize_subpath(args.path)
    destination = Path(args.destination).expanduser().resolve()
    manifest_path = (
        Path(args.manifest).expanduser().resolve()
        if args.manifest
        else destination / "recover-manifest.ndjson"
    )
    summary_path = (
        Path(args.summary).expanduser().resolve()
        if args.summary
        else destination / "recover-summary.json"
    )

    if not args.dry_run:
        ensure_directory(destination)

    walk_payload = api_walk_path(client, target, start_path)
    found = bool(walk_payload.get("found"))
    remaining = walk_payload.get("remaining")
    if not found or (isinstance(remaining, str) and remaining):
        raise ApiError(
            f"path '{start_path}' could not be resolved in {filesystem_display_name(target)}"
        )

    start_objid_raw = walk_payload.get("objid")
    start_type_name = str(walk_payload.get("type_name", "unknown"))
    resolved_base = str(walk_payload.get("resolved", start_path))
    if not isinstance(start_objid_raw, (int, float)):
        raise ApiError("walk payload missing objid")
    start_objid = int(start_objid_raw)

    print(
        "Resolved target:",
        f"filesystem={filesystem_display_name(target)}",
        f"objset_id={target.objset_id}",
        f"path={start_path}",
        f"type={start_type_name}",
    )

    stats = RecoverStats()
    resume_enabled = not args.no_resume
    stop_due_to_max_files = False
    matched_files_processed = 0
    methods = choose_download_methods(args, target)

    ensure_directory(manifest_path.parent)
    manifest = ManifestWriter(manifest_path)

    def record_result(
        *,
        rel_path: str,
        filesystem_path: str,
        objid: int,
        status: str,
        size: Optional[int] = None,
        bytes_written: int = 0,
        reason: str = "",
        method: str = "",
        stat_payload: Optional[Dict[str, object]] = None,
    ) -> None:
        record: Dict[str, object] = {
            "ts_unix": int(time.time()),
            "filesystem": filesystem_display_name(target),
            "pool": target.pool,
            "dataset": target.dataset,
            "snapshot": target.snapshot,
            "objset_id": target.objset_id,
            "relative_path": rel_path,
            "filesystem_path": filesystem_path,
            "pool_scoped_path": build_pool_scoped_path(target, filesystem_path),
            "objid": objid,
            "status": status,
            "size": size,
            "bytes_written": bytes_written,
            "method": method,
            "reason": reason,
        }
        if stat_payload is not None:
            record["stat"] = stat_payload
        manifest.write(record)

    def process_file(objid: int, rel_path: str, filesystem_path: str) -> None:
        nonlocal stop_due_to_max_files
        nonlocal matched_files_processed

        stats.discovered_files += 1

        include_ok, include_reason = should_include_path(rel_path, args.include, args.exclude)
        if not include_ok:
            stats.skipped_files += 1
            record_result(
                rel_path=rel_path,
                filesystem_path=filesystem_path,
                objid=objid,
                status="skipped",
                reason=include_reason,
            )
            if args.verbose:
                print(f"SKIP {rel_path} ({include_reason})")
            return

        if args.max_files and matched_files_processed >= args.max_files:
            stop_due_to_max_files = True
            return
        matched_files_processed += 1

        try:
            stat_payload = api_stat(client, target, objid)
        except Exception as err:  # pylint: disable=broad-except
            stats.failed_files += 1
            record_result(
                rel_path=rel_path,
                filesystem_path=filesystem_path,
                objid=objid,
                status="failed",
                reason=f"stat failed: {err}",
            )
            print(f"FAIL {rel_path}: stat failed: {err}")
            return

        type_name = str(stat_payload.get("type_name", "unknown"))
        size_value = stat_payload.get("size")
        size = int(size_value) if isinstance(size_value, (int, float)) else None

        if type_name != "file":
            stats.skipped_files += 1
            record_result(
                rel_path=rel_path,
                filesystem_path=filesystem_path,
                objid=objid,
                status="skipped",
                size=size,
                reason=f"non-file type: {type_name}",
                stat_payload=stat_payload,
            )
            if args.verbose:
                print(f"SKIP {rel_path} (type={type_name})")
            return

        local_path = destination / rel_path
        local_parent = local_path.parent
        if not args.dry_run:
            ensure_directory(local_parent)

        if args.dry_run:
            stats.skipped_files += 1
            record_result(
                rel_path=rel_path,
                filesystem_path=filesystem_path,
                objid=objid,
                status="dry-run",
                size=size,
                stat_payload=stat_payload,
            )
            if args.verbose:
                print(f"PLAN {rel_path} ({size if size is not None else 'unknown'} bytes)")
            return

        if local_path.exists() and not args.overwrite and not resume_enabled:
            stats.skipped_files += 1
            record_result(
                rel_path=rel_path,
                filesystem_path=filesystem_path,
                objid=objid,
                status="skipped",
                size=size,
                reason="exists (use --overwrite or enable resume)",
                stat_payload=stat_payload,
            )
            if args.verbose:
                print(f"SKIP {rel_path} (exists)")
            return

        if local_path.exists() and args.overwrite:
            local_path.unlink()

        existing_size = local_path.stat().st_size if local_path.exists() else 0
        if local_path.exists() and not args.overwrite and size is not None:
            if existing_size == size:
                stats.skipped_files += 1
                record_result(
                    rel_path=rel_path,
                    filesystem_path=filesystem_path,
                    objid=objid,
                    status="skipped",
                    size=size,
                    reason="already complete",
                    stat_payload=stat_payload,
                )
                if args.verbose:
                    print(f"SKIP {rel_path} (already complete)")
                return
            if existing_size > size:
                stats.failed_files += 1
                reason = (
                    "local file larger than expected size "
                    f"({existing_size} > {size}); remove it or use --overwrite"
                )
                record_result(
                    rel_path=rel_path,
                    filesystem_path=filesystem_path,
                    objid=objid,
                    status="failed",
                    size=size,
                    reason=reason,
                    stat_payload=stat_payload,
                )
                print(f"FAIL {rel_path}: {reason}")
                return

        final_method = ""
        total_written = 0
        last_error: Optional[Exception] = None

        for method_idx, method in enumerate(methods):
            final_method = method
            max_attempts = args.retries + 1
            method_failed = False

            for attempt in range(1, max_attempts + 1):
                try:
                    start_offset = local_path.stat().st_size if local_path.exists() else 0

                    if size is not None and start_offset > size:
                        raise ApiError(
                            f"local file larger than remote size ({start_offset} > {size})"
                        )

                    if size is not None and start_offset == size:
                        # Already complete from prior run or previous retry.
                        break

                    mode = "ab" if start_offset > 0 else "wb"
                    if start_offset > 0 and args.verbose:
                        print(f"RESUME {rel_path} at offset {start_offset} via {method}")

                    with local_path.open(mode) as out_file:
                        if method == "zpl":
                            wrote = download_via_zpl(
                                client,
                                target,
                                filesystem_path,
                                start_offset,
                                args.chunk_size,
                                out_file,
                            )
                        else:
                            wrote = read_object_bytes(
                                client,
                                target,
                                objid,
                                start_offset,
                                args.chunk_size,
                                out_file,
                            )

                    total_written += wrote

                    final_size = local_path.stat().st_size
                    if size is not None and final_size != size:
                        raise ApiError(
                            f"size mismatch (expected {size}, got {final_size})"
                        )

                    stats.downloaded_files += 1
                    stats.bytes_written += total_written
                    record_result(
                        rel_path=rel_path,
                        filesystem_path=filesystem_path,
                        objid=objid,
                        status="downloaded",
                        size=size,
                        bytes_written=total_written,
                        method=method,
                        stat_payload=stat_payload,
                    )
                    print(f"OK   {rel_path} ({final_size} bytes)")
                    return

                except Exception as err:  # pylint: disable=broad-except
                    last_error = err
                    if attempt >= max_attempts:
                        method_failed = True
                        break

                    delay = min(5.0, 0.5 * (2 ** (attempt - 1)))
                    if args.verbose:
                        print(
                            f"WARN {rel_path}: {method} attempt {attempt}/{max_attempts} failed: "
                            f"{err}; retrying in {delay:.1f}s"
                        )
                    time.sleep(delay)

            if not method_failed:
                # Method succeeded.
                return

            if args.verbose and method_idx + 1 < len(methods):
                print(
                    f"WARN {rel_path}: method {method} failed; "
                    f"trying {methods[method_idx + 1]}"
                )

        stats.failed_files += 1
        reason = str(last_error) if last_error is not None else "unknown download error"
        record_result(
            rel_path=rel_path,
            filesystem_path=filesystem_path,
            objid=objid,
            status="failed",
            size=size,
            bytes_written=total_written,
            reason=reason,
            method=final_method,
            stat_payload=stat_payload,
        )

        sidecar_payload = {
            "filesystem": filesystem_display_name(target),
            "pool": target.pool,
            "dataset": target.dataset,
            "snapshot": target.snapshot,
            "objset_id": target.objset_id,
            "relative_path": rel_path,
            "filesystem_path": filesystem_path,
            "pool_scoped_path": build_pool_scoped_path(target, filesystem_path),
            "objid": objid,
            "method": final_method,
            "reason": reason,
            "size": size,
            "partial_local_size": local_path.stat().st_size if local_path.exists() else 0,
            "stat": stat_payload,
            "generated_at_unix": int(time.time()),
        }
        try:
            write_failed_sidecar(local_path, sidecar_payload)
        except Exception as sidecar_err:  # pylint: disable=broad-except
            if args.verbose:
                print(f"WARN {rel_path}: failed to write sidecar: {sidecar_err}")

        print(f"FAIL {rel_path}: {reason}")

    try:
        if start_type_name == "file":
            base_name = PurePosixPath(start_path).name or f"obj-{start_objid}"
            process_file(start_objid, base_name, start_path)
        elif start_type_name == "dir":
            stack: List[Tuple[int, str, str]] = [(start_objid, "", start_path)]
            while stack and not stop_due_to_max_files:
                current_objid, rel_dir, fs_dir = stack.pop()
                for entry in iter_directory_entries(
                    client,
                    target,
                    current_objid,
                    args.page_limit,
                ):
                    name = entry.get("name")
                    if not isinstance(name, str) or not name or name in (".", ".."):
                        continue

                    child_obj_raw = entry.get("objid")
                    if not isinstance(child_obj_raw, (int, float)):
                        continue
                    child_obj = int(child_obj_raw)

                    child_type = str(entry.get("type_name", "unknown"))
                    child_rel = f"{rel_dir}/{name}" if rel_dir else name
                    child_fs = posix_join(fs_dir, name)

                    if child_type == "dir":
                        stack.append((child_obj, child_rel, child_fs))
                        continue

                    if child_type == "file":
                        process_file(child_obj, child_rel, child_fs)
                        if stop_due_to_max_files:
                            break
                        continue

                    stats.skipped_files += 1
                    record_result(
                        rel_path=child_rel,
                        filesystem_path=child_fs,
                        objid=child_obj,
                        status="skipped",
                        reason=f"unsupported type: {child_type}",
                    )
                    if args.verbose:
                        print(f"SKIP {child_rel} (type={child_type})")
        else:
            raise ApiError(
                f"start path '{start_path}' resolved to unsupported type '{start_type_name}'"
            )
    finally:
        manifest.close()

    summary = {
        "backend": args.backend,
        "filesystem": filesystem_display_name(target),
        "pool": target.pool,
        "objset_id": target.objset_id,
        "requested_path": start_path,
        "resolved_path": resolved_base,
        "destination": str(destination),
        "dry_run": bool(args.dry_run),
        "download_method": args.download_method,
        "manifest": str(manifest_path),
        "stats": {
            "discovered_files": stats.discovered_files,
            "downloaded_files": stats.downloaded_files,
            "skipped_files": stats.skipped_files,
            "failed_files": stats.failed_files,
            "bytes_written": stats.bytes_written,
            "stopped_by_max_files": stop_due_to_max_files,
        },
        "generated_at_unix": int(time.time()),
    }

    ensure_directory(summary_path.parent)
    try:
        summary_path.write_text(
            json.dumps(summary, indent=2, sort_keys=False) + "\n",
            encoding="utf-8",
        )
        print(f"Wrote manifest: {manifest_path}")
        print(f"Wrote summary:  {summary_path}")
    except Exception as err:  # pylint: disable=broad-except
        print(f"warning: failed to write summary {summary_path}: {err}", file=sys.stderr)

    print(
        "Summary:",
        f"discovered={stats.discovered_files}",
        f"downloaded={stats.downloaded_files}",
        f"skipped={stats.skipped_files}",
        f"failed={stats.failed_files}",
        f"bytes={stats.bytes_written}",
    )

    return 0 if stats.failed_files == 0 else 2


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    client = ApiClient(args.backend, timeout=args.timeout)

    started_backend: Optional[subprocess.Popen] = None
    try:
        started_backend = launch_backend_if_needed(args, client)
        target = resolve_filesystem_target(client, args.filesystem)
        return recover(args, client, target)
    except (ApiError, BackendStartError, ValueError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    finally:
        if started_backend and not args.leave_backend_running:
            try:
                started_backend.terminate()
                started_backend.wait(timeout=5)
                print("Stopped backend started by this script")
            except Exception:
                try:
                    started_backend.kill()
                except Exception:
                    pass


if __name__ == "__main__":
    raise SystemExit(main())
