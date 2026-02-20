use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{
        header::{
            ACCEPT_RANGES, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE,
        },
        HeaderMap, HeaderName, HeaderValue, Response, StatusCode,
    },
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::AppState;

const DEFAULT_PAGE_LIMIT: u64 = 200;
const MAX_PAGE_LIMIT: u64 = 10_000;
const SPACEMAP_DEFAULT_LIMIT: u64 = 200;
const SPACEMAP_MAX_LIMIT: u64 = 2_000;
const SPACEMAP_BINS_DEFAULT_LIMIT: u64 = 256;
const SPACEMAP_BINS_MAX_LIMIT: u64 = 2_048;
const SPACEMAP_BINS_DEFAULT_SIZE: u64 = 1 << 20; // 1 MiB
const SPACEMAP_BINS_MIN_SIZE: u64 = 512;
const SPACEMAP_BINS_MAX_SIZE: u64 = 1 << 32; // 4 GiB
const BLOCK_TREE_DEFAULT_DEPTH: u64 = 4;
const BLOCK_TREE_MAX_DEPTH: u64 = 16;
const BLOCK_TREE_DEFAULT_NODES: u64 = 2000;
const BLOCK_TREE_MAX_NODES: u64 = 50_000;
const OBJSET_DATA_DEFAULT_LIMIT: u64 = 64 * 1024;
const OBJSET_DATA_MAX_LIMIT: u64 = 1 << 20;
const ZPL_DOWNLOAD_MAX_BYTES: u64 = 512 * 1024 * 1024;
const BACKEND_NAME: &str = env!("CARGO_PKG_NAME");
const BACKEND_VERSION: &str = env!("CARGO_PKG_VERSION");
const BUILD_GIT_SHA: &str = match option_env!("ZFS_EXPLORER_GIT_SHA") {
    Some(v) => v,
    None => "unknown",
};
const ARCSTATS_PATH: &str = "/proc/spl/kstat/zfs/arcstats";
const TXGS_PATH: &str = "/proc/spl/kstat/zfs/txgs";
type ApiError = (StatusCode, Json<Value>);
type ApiResult = Result<Json<Value>, ApiError>;

fn host_cli_command(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    /*
     * The backend process may run with a custom LD_LIBRARY_PATH so bundled
     * libzfs/libzpool can be used by FFI. External host CLIs (`zpool`, `zfs`)
     * must not inherit that loader path or they can resolve against mismatched
     * libraries and fail with symbol lookup errors.
     */
    cmd.env_remove("LD_LIBRARY_PATH");
    cmd.env_remove("LD_PRELOAD");
    cmd
}

fn api_error(status: StatusCode, message: impl Into<String>) -> ApiError {
    let message = message.into();
    api_error_with(
        status,
        format!("HTTP_{}", status.as_u16()),
        message,
        None,
        status.is_client_error(),
    )
}

fn api_error_with(
    status: StatusCode,
    code: impl Into<String>,
    message: impl Into<String>,
    hint: Option<String>,
    recoverable: bool,
) -> ApiError {
    let message = message.into();
    let mut payload = json!({
        "error": message,
        "message": message,
        "code": code.into(),
        "recoverable": recoverable,
    });

    if let Some(hint) = hint {
        payload["hint"] = Value::String(hint);
    }

    (status, Json(payload))
}

fn is_dataset_user_input_error(err_msg: &str) -> bool {
    err_msg.contains("has no head dataset")
        || err_msg.contains("head dataset bonus unsupported")
        || err_msg.contains("is $ORIGIN")
        || err_msg.contains("no user-visible ZPL objset")
}

fn is_spacemap_user_input_error(err_msg: &str) -> bool {
    err_msg.contains("expected \"space map\"")
        || err_msg.contains("bonus is too small for space map payload")
        || (err_msg.contains("failed to inspect spacemap object")
            && (err_msg.contains("Invalid argument")
                || err_msg.contains("No such file or directory")))
}

fn is_objset_user_input_error(err_msg: &str) -> bool {
    err_msg.contains("dnode_hold failed for object")
        || err_msg.contains("objset is not ZFS")
        || err_msg.contains("dsl_dataset_hold_obj failed")
        || err_msg.contains("dmu_object_next failed")
        || err_msg.contains("dmu_object_info failed for object")
        || err_msg.contains("dmu_read failed for object")
        || err_msg.contains("zap_get_stats failed")
        || err_msg.contains("zap_lookup failed")
        || err_msg.contains("zap_cursor_retrieve failed")
}

fn is_zap_unreadable_error(err_msg: &str) -> bool {
    (err_msg.contains("zap_get_stats failed")
        || err_msg.contains("zap_lookup failed")
        || err_msg.contains("zap_cursor_retrieve failed"))
        && err_msg.contains("Invalid exchange")
}

fn zap_unreadable_hint() -> String {
    "ZAP payload could not be decoded in this context. This commonly happens \
for encrypted dataset contents when key material is unavailable."
        .to_string()
}

fn api_error_for_objset(err_msg: &str) -> ApiError {
    if is_zap_unreadable_error(err_msg) {
        return api_error_with(
            StatusCode::BAD_REQUEST,
            "ZAP_UNREADABLE",
            err_msg.to_string(),
            Some(zap_unreadable_hint()),
            true,
        );
    }

    let status = if is_objset_user_input_error(err_msg) {
        StatusCode::BAD_REQUEST
    } else {
        tracing::error!("FFI error: {}", err_msg);
        StatusCode::INTERNAL_SERVER_ERROR
    };
    api_error(status, err_msg.to_string())
}

fn inline_zap_error_payload(err_msg: &str) -> Option<Value> {
    if !is_zap_unreadable_error(err_msg) {
        return None;
    }

    Some(json!({
        "code": "ZAP_UNREADABLE",
        "message": err_msg,
        "hint": zap_unreadable_hint(),
        "recoverable": true
    }))
}

fn libzfs_error_name(code: i32) -> Option<&'static str> {
    match code {
        0 => Some("EZFS_SUCCESS"),
        2000 => Some("EZFS_NOMEM"),
        2001 => Some("EZFS_BADPROP"),
        2002 => Some("EZFS_PROPREADONLY"),
        2003 => Some("EZFS_PROPTYPE"),
        2004 => Some("EZFS_PROPNONINHERIT"),
        2005 => Some("EZFS_PROPSPACE"),
        2006 => Some("EZFS_BADTYPE"),
        2007 => Some("EZFS_BUSY"),
        2008 => Some("EZFS_EXISTS"),
        2009 => Some("EZFS_NOENT"),
        2010 => Some("EZFS_BADSTREAM"),
        2011 => Some("EZFS_DSREADONLY"),
        2012 => Some("EZFS_VOLTOOBIG"),
        2013 => Some("EZFS_INVALIDNAME"),
        2014 => Some("EZFS_BADRESTORE"),
        2015 => Some("EZFS_BADBACKUP"),
        2016 => Some("EZFS_BADTARGET"),
        2017 => Some("EZFS_NODEVICE"),
        2018 => Some("EZFS_BADDEV"),
        2019 => Some("EZFS_NOREPLICAS"),
        2020 => Some("EZFS_RESILVERING"),
        2021 => Some("EZFS_BADVERSION"),
        2022 => Some("EZFS_POOLUNAVAIL"),
        2023 => Some("EZFS_DEVOVERFLOW"),
        2024 => Some("EZFS_BADPATH"),
        2025 => Some("EZFS_CROSSTARGET"),
        2026 => Some("EZFS_ZONED"),
        2027 => Some("EZFS_MOUNTFAILED"),
        2028 => Some("EZFS_UMOUNTFAILED"),
        2029 => Some("EZFS_UNSHARENFSFAILED"),
        2030 => Some("EZFS_SHARENFSFAILED"),
        2031 => Some("EZFS_PERM"),
        2032 => Some("EZFS_NOSPC"),
        2033 => Some("EZFS_FAULT"),
        2034 => Some("EZFS_IO"),
        2035 => Some("EZFS_INTR"),
        2036 => Some("EZFS_ISSPARE"),
        2037 => Some("EZFS_INVALCONFIG"),
        2038 => Some("EZFS_RECURSIVE"),
        2039 => Some("EZFS_NOHISTORY"),
        2040 => Some("EZFS_POOLPROPS"),
        2041 => Some("EZFS_POOL_NOTSUP"),
        2042 => Some("EZFS_POOL_INVALARG"),
        2043 => Some("EZFS_NAMETOOLONG"),
        2044 => Some("EZFS_OPENFAILED"),
        2045 => Some("EZFS_NOCAP"),
        2046 => Some("EZFS_LABELFAILED"),
        2047 => Some("EZFS_BADWHO"),
        2048 => Some("EZFS_BADPERM"),
        2049 => Some("EZFS_BADPERMSET"),
        2050 => Some("EZFS_NODELEGATION"),
        2051 => Some("EZFS_UNSHARESMBFAILED"),
        2052 => Some("EZFS_SHARESMBFAILED"),
        2053 => Some("EZFS_BADCACHE"),
        2054 => Some("EZFS_ISL2CACHE"),
        2055 => Some("EZFS_VDEVNOTSUP"),
        2056 => Some("EZFS_NOTSUP"),
        2057 => Some("EZFS_ACTIVE_SPARE"),
        2058 => Some("EZFS_UNPLAYED_LOGS"),
        2059 => Some("EZFS_REFTAG_RELE"),
        2060 => Some("EZFS_REFTAG_HOLD"),
        2061 => Some("EZFS_TAGTOOLONG"),
        2062 => Some("EZFS_PIPEFAILED"),
        2063 => Some("EZFS_THREADCREATEFAILED"),
        2064 => Some("EZFS_POSTSPLIT_ONLINE"),
        2065 => Some("EZFS_SCRUBBING"),
        2066 => Some("EZFS_ERRORSCRUBBING"),
        2067 => Some("EZFS_ERRORSCRUB_PAUSED"),
        2068 => Some("EZFS_NO_SCRUB"),
        2069 => Some("EZFS_DIFF"),
        2070 => Some("EZFS_DIFFDATA"),
        2071 => Some("EZFS_POOLREADONLY"),
        2072 => Some("EZFS_SCRUB_PAUSED"),
        2073 => Some("EZFS_SCRUB_PAUSED_TO_CANCEL"),
        2074 => Some("EZFS_ACTIVE_POOL"),
        2075 => Some("EZFS_CRYPTOFAILED"),
        2076 => Some("EZFS_NO_PENDING"),
        2077 => Some("EZFS_CHECKPOINT_EXISTS"),
        2078 => Some("EZFS_DISCARDING_CHECKPOINT"),
        2079 => Some("EZFS_NO_CHECKPOINT"),
        2080 => Some("EZFS_DEVRM_IN_PROGRESS"),
        2081 => Some("EZFS_VDEV_TOO_BIG"),
        2082 => Some("EZFS_IOC_NOTSUPPORTED"),
        2083 => Some("EZFS_TOOMANY"),
        2084 => Some("EZFS_INITIALIZING"),
        2085 => Some("EZFS_NO_INITIALIZE"),
        2086 => Some("EZFS_WRONG_PARENT"),
        2087 => Some("EZFS_TRIMMING"),
        2088 => Some("EZFS_NO_TRIM"),
        2089 => Some("EZFS_TRIM_NOTSUP"),
        2090 => Some("EZFS_NO_RESILVER_DEFER"),
        2091 => Some("EZFS_EXPORT_IN_PROGRESS"),
        2092 => Some("EZFS_REBUILDING"),
        2093 => Some("EZFS_VDEV_NOTSUP"),
        2094 => Some("EZFS_NOT_USER_NAMESPACE"),
        2095 => Some("EZFS_CKSUM"),
        2096 => Some("EZFS_RESUME_EXISTS"),
        2097 => Some("EZFS_SHAREFAILED"),
        2098 => Some("EZFS_RAIDZ_EXPAND_IN_PROGRESS"),
        2099 => Some("EZFS_ASHIFT_MISMATCH"),
        2100 => Some("EZFS_UNKNOWN"),
        _ => None,
    }
}

fn pool_open_error_code(code: i32) -> String {
    if let Some(name) = libzfs_error_name(code) {
        return name.to_string();
    }
    if code > 0 {
        return format!("ERRNO_{code}");
    }
    format!("ZDX_{code}")
}

fn offline_pool_open_hint(pool: &str, code: i32) -> Option<String> {
    let pool_name = pool.to_string();
    if matches!(libzfs_error_name(code), Some("EZFS_NOENT")) || code == libc::ENOENT {
        return Some(format!(
            "Pool '{pool_name}' was not found in the offline search paths. \
Ensure the pool is exported and ZFS_EXPLORER_OFFLINE_PATHS points to parent \
directories (for example /dev/disk/by-id)."
        ));
    }

    if matches!(libzfs_error_name(code), Some("EZFS_PERM"))
        || code == libc::EACCES
        || code == libc::EPERM
    {
        return Some(
            "Permission denied while opening offline media. Run the backend as \
root or grant read access to the underlying devices/images."
                .to_string(),
        );
    }

    if matches!(libzfs_error_name(code), Some("EZFS_ACTIVE_POOL")) || code == libc::EEXIST {
        return Some(format!(
            "Pool '{pool_name}' appears active/imported. Export it before \
opening in offline mode."
        ));
    }

    if matches!(libzfs_error_name(code), Some("EZFS_CRYPTOFAILED")) {
        return Some(
            "The pool appears encrypted and keys are unavailable in offline \
mode. Unlock keys first, or inspect metadata-only views."
                .to_string(),
        );
    }

    None
}

fn pool_open_mode_name(mode: crate::PoolOpenMode) -> &'static str {
    match mode {
        crate::PoolOpenMode::Live => "live",
        crate::PoolOpenMode::Offline => "offline",
    }
}

fn parse_pool_open_mode(raw: &str) -> Option<crate::PoolOpenMode> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "live" => Some(crate::PoolOpenMode::Live),
        "offline" => Some(crate::PoolOpenMode::Offline),
        _ => None,
    }
}

fn pool_open_config(state: &AppState) -> crate::PoolOpenConfig {
    state.pool_open.lock().unwrap().clone()
}

fn build_version_payload(pool_open: &crate::PoolOpenConfig) -> Value {
    json!({
        "project": "zfs-explorer",
        "backend": {
            "name": BACKEND_NAME,
            "version": BACKEND_VERSION,
            "git_sha": BUILD_GIT_SHA,
        },
        "openzfs": {
            "commit": crate::ffi::version(),
        },
        "runtime": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        },
        "pool_open": {
            "mode": pool_open_mode_name(pool_open.mode),
            "offline_search_paths": pool_open.offline_search_paths.clone(),
            "offline_pools": pool_open.offline_pool_names.clone(),
        },
    })
}

fn build_mode_payload(pool_open: &crate::PoolOpenConfig) -> Value {
    json!({
        "mode": pool_open_mode_name(pool_open.mode),
        "offline_search_paths": pool_open.offline_search_paths.clone(),
        "offline_pools": pool_open.offline_pool_names.clone(),
    })
}

fn parse_arcstats(contents: &str) -> HashMap<String, u64> {
    let mut counters = HashMap::new();

    for line in contents.lines() {
        let mut parts = line.split_whitespace();
        let Some(name) = parts.next() else {
            continue;
        };
        let Some(_kind) = parts.next() else {
            continue;
        };
        let Some(value_raw) = parts.next() else {
            continue;
        };

        if name == "name" {
            continue;
        }

        let Some(first) = name.bytes().next() else {
            continue;
        };
        if !first.is_ascii_alphabetic() {
            continue;
        }

        let value = match value_raw.parse::<u64>() {
            Ok(parsed) => parsed,
            Err(_) => match value_raw.parse::<i64>() {
                Ok(parsed) if parsed >= 0 => parsed as u64,
                _ => continue,
            },
        };
        counters.insert(name.to_string(), value);
    }

    counters
}

fn arc_counter(counters: &HashMap<String, u64>, key: &str) -> u64 {
    counters.get(key).copied().unwrap_or(0)
}

fn arc_hit_ratio(hits: u64, misses: u64) -> Option<f64> {
    let total = hits.saturating_add(misses);
    if total == 0 {
        None
    } else {
        Some(hits as f64 / total as f64)
    }
}

fn build_arc_payload(counters: &HashMap<String, u64>) -> Value {
    let hits = arc_counter(counters, "hits");
    let misses = arc_counter(counters, "misses");
    let demand_hits = arc_counter(counters, "demand_data_hits")
        .saturating_add(arc_counter(counters, "demand_metadata_hits"));
    let demand_misses = arc_counter(counters, "demand_data_misses")
        .saturating_add(arc_counter(counters, "demand_metadata_misses"));
    let prefetch_hits = arc_counter(counters, "prefetch_data_hits")
        .saturating_add(arc_counter(counters, "prefetch_metadata_hits"));
    let prefetch_misses = arc_counter(counters, "prefetch_data_misses")
        .saturating_add(arc_counter(counters, "prefetch_metadata_misses"));
    let l2_hits = arc_counter(counters, "l2_hits");
    let l2_misses = arc_counter(counters, "l2_misses");
    let sampled_at_unix_sec = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);

    json!({
        "source": ARCSTATS_PATH,
        "sampled_at_unix_sec": sampled_at_unix_sec,
        "arc": {
            "size_bytes": arc_counter(counters, "size"),
            "target_size_bytes": arc_counter(counters, "c"),
            "target_min_bytes": arc_counter(counters, "c_min"),
            "target_max_bytes": arc_counter(counters, "c_max"),
            "mru_size_bytes": arc_counter(counters, "mru_size"),
            "mfu_size_bytes": arc_counter(counters, "mfu_size"),
            "hits": hits,
            "misses": misses,
            "demand_data_hits": arc_counter(counters, "demand_data_hits"),
            "demand_data_misses": arc_counter(counters, "demand_data_misses"),
            "demand_metadata_hits": arc_counter(counters, "demand_metadata_hits"),
            "demand_metadata_misses": arc_counter(counters, "demand_metadata_misses"),
            "prefetch_data_hits": arc_counter(counters, "prefetch_data_hits"),
            "prefetch_data_misses": arc_counter(counters, "prefetch_data_misses"),
            "prefetch_metadata_hits": arc_counter(counters, "prefetch_metadata_hits"),
            "prefetch_metadata_misses": arc_counter(counters, "prefetch_metadata_misses"),
            "evict_skip": arc_counter(counters, "evict_skip"),
            "memory_throttle_count": arc_counter(counters, "memory_throttle_count"),
        },
        "l2arc": {
            "size_bytes": arc_counter(counters, "l2_size"),
            "asize_bytes": arc_counter(counters, "l2_asize"),
            "hits": l2_hits,
            "misses": l2_misses,
            "read_bytes": arc_counter(counters, "l2_read_bytes"),
            "write_bytes": arc_counter(counters, "l2_write_bytes"),
            "feeds": arc_counter(counters, "l2_feeds"),
        },
        "ratios": {
            "arc_hit_ratio": arc_hit_ratio(hits, misses),
            "demand_hit_ratio": arc_hit_ratio(demand_hits, demand_misses),
            "prefetch_hit_ratio": arc_hit_ratio(prefetch_hits, prefetch_misses),
            "l2arc_hit_ratio": arc_hit_ratio(l2_hits, l2_misses),
        },
        "raw_counter_count": counters.len(),
    })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct VdevIostatRow {
    name: String,
    depth: u64,
    alloc: Option<u64>,
    free: Option<u64>,
    read_ops: Option<u64>,
    write_ops: Option<u64>,
    read_bytes: Option<u64>,
    write_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct DdtClassRow {
    refcount: u64,
    blocks: u64,
    lsize: u64,
    psize: u64,
    dsize: u64,
    referenced_blocks: u64,
    referenced_lsize: u64,
    referenced_psize: u64,
    referenced_dsize: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct DdtSummary {
    entries: Option<u64>,
    size_on_disk: Option<u64>,
    size_in_core: Option<u64>,
    classes: Vec<DdtClassRow>,
    totals: Option<DdtClassRow>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
struct SpaceAmplificationPoolSummary {
    size_bytes: Option<u64>,
    allocated_bytes: Option<u64>,
    free_bytes: Option<u64>,
    frag_percent: Option<f64>,
    dedup_ratio: Option<f64>,
    logical_used_bytes: Option<u64>,
    logical_vs_physical_ratio: Option<f64>,
    physical_vs_logical_ratio: Option<f64>,
    physical_minus_logical_bytes: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
struct SpaceAmplificationDatasetRow {
    name: String,
    kind: String,
    used_bytes: Option<u64>,
    logical_used_bytes: Option<u64>,
    referenced_bytes: Option<u64>,
    logical_referenced_bytes: Option<u64>,
    compress_ratio: Option<f64>,
    logical_vs_physical_ratio: Option<f64>,
    physical_vs_logical_ratio: Option<f64>,
    physical_minus_logical_bytes: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct SpaceAmplificationTotals {
    dataset_count: u64,
    used_bytes: u64,
    logical_used_bytes: u64,
    referenced_bytes: u64,
    logical_referenced_bytes: u64,
}

fn parse_iostat_counter(raw: &str) -> Option<u64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "-" {
        None
    } else {
        trimmed.parse::<u64>().ok()
    }
}

fn parse_optional_u64(raw: &str) -> Option<u64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "-" {
        None
    } else {
        trimmed.parse::<u64>().ok()
    }
}

fn parse_scaled_u64(raw: &str) -> Option<u64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "-" {
        return None;
    }

    if let Ok(value) = trimmed.parse::<u64>() {
        return Some(value);
    }

    let mut body = trimmed;
    let mut unit = '\0';

    if trimmed.len() >= 3 && trimmed.ends_with("iB") {
        let candidate = trimmed.chars().nth(trimmed.len() - 3)?;
        if matches!(candidate, 'K' | 'M' | 'G' | 'T' | 'P' | 'E') {
            unit = candidate;
            body = &trimmed[..trimmed.len() - 3];
        }
    } else if trimmed.len() >= 2 && trimmed.ends_with('B') {
        let candidate = trimmed.chars().nth(trimmed.len() - 2)?;
        if matches!(candidate, 'K' | 'M' | 'G' | 'T' | 'P' | 'E') {
            unit = candidate;
            body = &trimmed[..trimmed.len() - 2];
        }
    } else if let Some(candidate) = trimmed.chars().last() {
        if matches!(candidate, 'K' | 'M' | 'G' | 'T' | 'P' | 'E') {
            unit = candidate;
            body = &trimmed[..trimmed.len() - 1];
        }
    }

    if unit == '\0' {
        return None;
    }

    let numeric = body.parse::<f64>().ok()?;
    if !numeric.is_finite() || numeric.is_sign_negative() {
        return None;
    }

    let power = match unit {
        'K' => 1,
        'M' => 2,
        'G' => 3,
        'T' => 4,
        'P' => 5,
        'E' => 6,
        _ => return None,
    };
    let multiplier = 1024_f64.powi(power);
    let scaled = numeric * multiplier;
    if !scaled.is_finite() || scaled.is_sign_negative() || scaled > u64::MAX as f64 {
        return None;
    }

    Some(scaled.round() as u64)
}

fn parse_ratio_value(raw: &str) -> Option<f64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "-" {
        return None;
    }
    let normalized = trimmed.trim_end_matches(['x', 'X', '%']);
    normalized.parse::<f64>().ok()
}

fn ratio_u64(numerator: Option<u64>, denominator: Option<u64>) -> Option<f64> {
    match (numerator, denominator) {
        (Some(num), Some(den)) if den > 0 => Some(num as f64 / den as f64),
        _ => None,
    }
}

fn signed_delta_i64(lhs: Option<u64>, rhs: Option<u64>) -> Option<i64> {
    let lhs = lhs?;
    let rhs = rhs?;
    let delta = lhs as i128 - rhs as i128;
    Some(delta.clamp(i64::MIN as i128, i64::MAX as i128) as i64)
}

fn parse_vdev_iostat_output(output: &str) -> Vec<VdevIostatRow> {
    output
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim_end();
            if trimmed.trim().is_empty() {
                return None;
            }

            let tab_parts: Vec<&str> = trimmed.split('\t').collect();
            let parts = if tab_parts.len() >= 7 {
                tab_parts
            } else {
                trimmed.split_whitespace().collect::<Vec<_>>()
            };
            if parts.len() < 7 {
                return None;
            }

            let raw_name = parts[0];
            let depth = raw_name
                .chars()
                .take_while(|c| c.is_ascii_whitespace())
                .count() as u64;
            let name = raw_name.trim().to_string();
            if name.is_empty() {
                return None;
            }

            Some(VdevIostatRow {
                name,
                depth,
                alloc: parse_iostat_counter(parts[1]),
                free: parse_iostat_counter(parts[2]),
                read_ops: parse_iostat_counter(parts[3]),
                write_ops: parse_iostat_counter(parts[4]),
                read_bytes: parse_iostat_counter(parts[5]),
                write_bytes: parse_iostat_counter(parts[6]),
            })
        })
        .collect()
}

fn parse_ddt_summary(output: &str) -> DdtSummary {
    let mut entries = None;
    let mut size_on_disk = None;
    let mut size_in_core = None;
    let mut classes = Vec::new();
    let mut totals = None;

    for line in output.lines() {
        let normalized = line.replace(',', " ");
        let tokens = normalized.split_whitespace().collect::<Vec<_>>();
        if tokens.is_empty() {
            continue;
        }

        if normalized.contains("DDT entries")
            && normalized.contains("on disk")
            && normalized.contains("in core")
        {
            if let Some(idx) = tokens.iter().position(|token| *token == "entries") {
                entries = tokens.get(idx + 1).and_then(|raw| parse_scaled_u64(raw));
            }
            if let Some(idx) = tokens.iter().position(|token| *token == "size") {
                size_on_disk = tokens.get(idx + 1).and_then(|raw| parse_scaled_u64(raw));
            }
            if let Some(idx) = tokens.iter().position(|token| *token == "disk") {
                size_in_core = tokens.get(idx + 1).and_then(|raw| parse_scaled_u64(raw));
            }
            continue;
        }

        let is_total = tokens[0].eq_ignore_ascii_case("total");
        let row = if is_total {
            let numeric_count = tokens.len().saturating_sub(1);
            if numeric_count == 8 {
                let parsed = (0..8)
                    .map(|offset| parse_scaled_u64(tokens[1 + offset]))
                    .collect::<Vec<_>>();
                if parsed.iter().any(Option::is_none) {
                    continue;
                }
                DdtClassRow {
                    // zpool status total rows omit the refcount column.
                    refcount: 0,
                    blocks: parsed[0].unwrap_or(0),
                    lsize: parsed[1].unwrap_or(0),
                    psize: parsed[2].unwrap_or(0),
                    dsize: parsed[3].unwrap_or(0),
                    referenced_blocks: parsed[4].unwrap_or(0),
                    referenced_lsize: parsed[5].unwrap_or(0),
                    referenced_psize: parsed[6].unwrap_or(0),
                    referenced_dsize: parsed[7].unwrap_or(0),
                }
            } else if numeric_count >= 9 {
                let parsed = (0..9)
                    .map(|offset| parse_scaled_u64(tokens[1 + offset]))
                    .collect::<Vec<_>>();
                if parsed.iter().any(Option::is_none) {
                    continue;
                }
                DdtClassRow {
                    refcount: parsed[0].unwrap_or(0),
                    blocks: parsed[1].unwrap_or(0),
                    lsize: parsed[2].unwrap_or(0),
                    psize: parsed[3].unwrap_or(0),
                    dsize: parsed[4].unwrap_or(0),
                    referenced_blocks: parsed[5].unwrap_or(0),
                    referenced_lsize: parsed[6].unwrap_or(0),
                    referenced_psize: parsed[7].unwrap_or(0),
                    referenced_dsize: parsed[8].unwrap_or(0),
                }
            } else {
                continue;
            }
        } else if tokens.len() >= 9 {
            let parsed = (0..9)
                .map(|offset| parse_scaled_u64(tokens[offset]))
                .collect::<Vec<_>>();
            if parsed.iter().any(Option::is_none) {
                continue;
            }
            DdtClassRow {
                refcount: parsed[0].unwrap_or(0),
                blocks: parsed[1].unwrap_or(0),
                lsize: parsed[2].unwrap_or(0),
                psize: parsed[3].unwrap_or(0),
                dsize: parsed[4].unwrap_or(0),
                referenced_blocks: parsed[5].unwrap_or(0),
                referenced_lsize: parsed[6].unwrap_or(0),
                referenced_psize: parsed[7].unwrap_or(0),
                referenced_dsize: parsed[8].unwrap_or(0),
            }
        } else {
            continue;
        };

        if is_total {
            totals = Some(row);
        } else {
            classes.push(row);
        }
    }

    DdtSummary {
        entries,
        size_on_disk,
        size_in_core,
        classes,
        totals,
    }
}

fn parse_zfs_space_rows(output: &str) -> Vec<SpaceAmplificationDatasetRow> {
    output
        .lines()
        .filter_map(|line| {
            let parts = line.split('\t').collect::<Vec<_>>();
            if parts.len() < 7 {
                return None;
            }

            let used_bytes = parse_optional_u64(parts[2]);
            let logical_used_bytes = parse_optional_u64(parts[3]);
            let referenced_bytes = parse_optional_u64(parts[4]);
            let logical_referenced_bytes = parse_optional_u64(parts[5]);

            Some(SpaceAmplificationDatasetRow {
                name: parts[0].to_string(),
                kind: parts[1].to_string(),
                used_bytes,
                logical_used_bytes,
                referenced_bytes,
                logical_referenced_bytes,
                compress_ratio: parse_ratio_value(parts[6]),
                logical_vs_physical_ratio: ratio_u64(logical_used_bytes, used_bytes),
                physical_vs_logical_ratio: ratio_u64(used_bytes, logical_used_bytes),
                physical_minus_logical_bytes: signed_delta_i64(used_bytes, logical_used_bytes),
            })
        })
        .collect()
}

fn parse_zpool_space_summary(
    output: &str,
) -> Option<(
    Option<u64>,
    Option<u64>,
    Option<u64>,
    Option<f64>,
    Option<f64>,
)> {
    let line = output.lines().find(|line| !line.trim().is_empty())?;
    let parts = line.split('\t').collect::<Vec<_>>();
    if parts.len() < 5 {
        return None;
    }

    Some((
        parse_optional_u64(parts[0]),
        parse_optional_u64(parts[1]),
        parse_optional_u64(parts[2]),
        parse_ratio_value(parts[3]),
        parse_ratio_value(parts[4]),
    ))
}

fn parse_txgs_rows(contents: &str) -> (Vec<String>, Vec<Value>) {
    let mut columns = Vec::new();
    let mut rows = Vec::new();

    for line in contents.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.is_empty() {
            continue;
        }

        if columns.is_empty() {
            if parts.first() == Some(&"txg") {
                columns = parts.iter().map(|part| (*part).to_string()).collect();
            }
            continue;
        }

        if parts.len() < columns.len() {
            continue;
        }

        let mut row = serde_json::Map::new();
        for (idx, key) in columns.iter().enumerate() {
            let raw = parts[idx];
            let value = if let Ok(parsed) = raw.parse::<u64>() {
                json!(parsed)
            } else if let Ok(parsed) = raw.parse::<i64>() {
                json!(parsed)
            } else {
                json!(raw)
            };
            row.insert(key.clone(), value);
        }
        rows.push(Value::Object(row));
    }

    (columns, rows)
}

/// GET /api/version - Build/runtime info for support bundles
pub async fn api_version(State(state): State<AppState>) -> ApiResult {
    let config = pool_open_config(&state);
    Ok(Json(build_version_payload(&config)))
}

/// GET /api/perf/arc - ARC/L2ARC runtime summary (live mode only)
pub async fn perf_arc(State(state): State<AppState>) -> ApiResult {
    let config = pool_open_config(&state);
    if matches!(config.mode, crate::PoolOpenMode::Offline) {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "runtime telemetry is unavailable in offline mode",
        ));
    }

    let contents = std::fs::read_to_string(ARCSTATS_PATH).map_err(|err| {
        let (status, message) = match err.kind() {
            std::io::ErrorKind::NotFound => (
                StatusCode::NOT_IMPLEMENTED,
                format!("ARC stats file not found: {}", ARCSTATS_PATH),
            ),
            std::io::ErrorKind::PermissionDenied => (
                StatusCode::FORBIDDEN,
                format!("permission denied reading {}", ARCSTATS_PATH),
            ),
            _ => (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed reading {}: {}", ARCSTATS_PATH, err),
            ),
        };
        api_error(status, message)
    })?;

    let counters = parse_arcstats(&contents);
    if counters.is_empty() {
        return Err(api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("no ARC counters parsed from {}", ARCSTATS_PATH),
        ));
    }

    Ok(Json(build_arc_payload(&counters)))
}

#[derive(Debug, Deserialize)]
pub struct PerfVdevIostatQuery {
    pub pool: String,
}

/// GET /api/perf/vdev_iostat?pool= - per-vdev iostat sample (live mode only)
pub async fn perf_vdev_iostat(
    State(state): State<AppState>,
    Query(params): Query<PerfVdevIostatQuery>,
) -> ApiResult {
    let config = pool_open_config(&state);
    if matches!(config.mode, crate::PoolOpenMode::Offline) {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "runtime telemetry is unavailable in offline mode",
        ));
    }

    let pool = params.pool.trim();
    if pool.is_empty() {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "query parameter 'pool' is required",
        ));
    }

    let pool_name = pool.to_string();
    let output = tokio::task::spawn_blocking(move || {
        let mut command = host_cli_command("zpool");
        command
            .arg("iostat")
            .arg("-vH")
            .arg("-p")
            .arg(&pool_name)
            .output()
    })
    .await
    .map_err(|err| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to collect zpool iostat sample: {}", err),
        )
    })?
    .map_err(|err| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to execute zpool iostat: {}", err),
        )
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = if stderr.trim().is_empty() {
            format!("zpool iostat exited with {}", output.status)
        } else {
            stderr.trim().to_string()
        };
        return Err(api_error(StatusCode::BAD_GATEWAY, message));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let rows = parse_vdev_iostat_output(&stdout);
    if rows.is_empty() {
        return Err(api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "zpool iostat returned no parseable rows",
        ));
    }

    let sampled_at_unix_sec = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);

    Ok(Json(json!({
        "pool": pool,
        "sampled_at_unix_sec": sampled_at_unix_sec,
        "rows": rows,
    })))
}

/// GET /api/perf/txg - txg runtime indicators (live mode only)
pub async fn perf_txg(State(state): State<AppState>) -> ApiResult {
    let config = pool_open_config(&state);
    if matches!(config.mode, crate::PoolOpenMode::Offline) {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "runtime telemetry is unavailable in offline mode",
        ));
    }

    let contents = std::fs::read_to_string(TXGS_PATH).map_err(|err| {
        let (status, message) = match err.kind() {
            std::io::ErrorKind::NotFound => (
                StatusCode::NOT_IMPLEMENTED,
                format!("txg stats file not found: {}", TXGS_PATH),
            ),
            std::io::ErrorKind::PermissionDenied => (
                StatusCode::FORBIDDEN,
                format!("permission denied reading {}", TXGS_PATH),
            ),
            _ => (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed reading {}: {}", TXGS_PATH, err),
            ),
        };
        api_error(status, message)
    })?;

    let (columns, rows) = parse_txgs_rows(&contents);
    if rows.is_empty() {
        return Err(api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("no txg rows parsed from {}", TXGS_PATH),
        ));
    }

    let latest = rows
        .iter()
        .filter_map(|row| row["txg"].as_u64().map(|txg| (txg, row)))
        .max_by_key(|(txg, _)| *txg)
        .map(|(_, row)| row.clone())
        .unwrap_or(Value::Null);

    let sampled_at_unix_sec = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);

    Ok(Json(json!({
        "source": TXGS_PATH,
        "sampled_at_unix_sec": sampled_at_unix_sec,
        "columns": columns,
        "count": rows.len(),
        "latest": latest,
        "rows": rows,
    })))
}

/// GET /api/pools/:pool/dedup - DDT summary (`zpool status -D -p`) in live mode
pub async fn pool_dedup_summary(
    State(state): State<AppState>,
    Path(pool): Path<String>,
) -> ApiResult {
    let config = pool_open_config(&state);
    if matches!(config.mode, crate::PoolOpenMode::Offline) {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "dedup summary is unavailable in offline mode",
        ));
    }

    let pool_name = pool.clone();
    let output = tokio::task::spawn_blocking(move || {
        let mut command = host_cli_command("zpool");
        command
            .arg("status")
            .arg("-D")
            .arg("-p")
            .arg(&pool_name)
            .output()
    })
    .await
    .map_err(|err| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to collect zpool dedup summary: {}", err),
        )
    })?
    .map_err(|err| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to execute zpool status: {}", err),
        )
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = if stderr.trim().is_empty() {
            format!("zpool status exited with {}", output.status)
        } else {
            stderr.trim().to_string()
        };
        return Err(api_error(StatusCode::BAD_GATEWAY, message));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let summary = parse_ddt_summary(&stdout);
    let sampled_at_unix_sec = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);

    Ok(Json(json!({
        "pool": pool,
        "sampled_at_unix_sec": sampled_at_unix_sec,
        "ddt": summary,
        "raw": stdout,
    })))
}

/// GET /api/pools/:pool/space-amplification - logical vs physical usage hints
pub async fn pool_space_amplification(
    State(state): State<AppState>,
    Path(pool): Path<String>,
) -> ApiResult {
    let config = pool_open_config(&state);
    if matches!(config.mode, crate::PoolOpenMode::Offline) {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "space amplification is unavailable in offline mode",
        ));
    }

    let pool_name_for_zpool = pool.clone();
    let zpool_output = tokio::task::spawn_blocking(move || {
        let mut command = host_cli_command("zpool");
        command
            .arg("list")
            .arg("-H")
            .arg("-p")
            .arg("-o")
            .arg("size,alloc,free,frag,dedupratio")
            .arg(&pool_name_for_zpool)
            .output()
    })
    .await
    .map_err(|err| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to collect zpool space summary: {}", err),
        )
    })?
    .map_err(|err| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to execute zpool list: {}", err),
        )
    })?;

    if !zpool_output.status.success() {
        let stderr = String::from_utf8_lossy(&zpool_output.stderr);
        let message = if stderr.trim().is_empty() {
            format!("zpool list exited with {}", zpool_output.status)
        } else {
            stderr.trim().to_string()
        };
        return Err(api_error(StatusCode::BAD_GATEWAY, message));
    }

    let pool_summary_raw = String::from_utf8_lossy(&zpool_output.stdout).to_string();
    let (size_bytes, allocated_bytes, free_bytes, frag_percent, dedup_ratio) =
        parse_zpool_space_summary(&pool_summary_raw).ok_or_else(|| {
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "zpool list returned no parseable summary row",
            )
        })?;

    let pool_name_for_zfs = pool.clone();
    let zfs_output = tokio::task::spawn_blocking(move || {
        let mut command = host_cli_command("zfs");
        command
            .arg("list")
            .arg("-H")
            .arg("-p")
            .arg("-r")
            .arg("-t")
            .arg("filesystem,volume")
            .arg("-o")
            .arg("name,type,used,logicalused,referenced,logicalreferenced,compressratio")
            .arg(&pool_name_for_zfs)
            .output()
    })
    .await
    .map_err(|err| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to collect zfs space rows: {}", err),
        )
    })?
    .map_err(|err| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to execute zfs list: {}", err),
        )
    })?;

    if !zfs_output.status.success() {
        let stderr = String::from_utf8_lossy(&zfs_output.stderr);
        let message = if stderr.trim().is_empty() {
            format!("zfs list exited with {}", zfs_output.status)
        } else {
            stderr.trim().to_string()
        };
        return Err(api_error(StatusCode::BAD_GATEWAY, message));
    }

    let dataset_rows_raw = String::from_utf8_lossy(&zfs_output.stdout).to_string();
    let datasets = parse_zfs_space_rows(&dataset_rows_raw);
    if datasets.is_empty() {
        return Err(api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "zfs list returned no parseable dataset rows",
        ));
    }

    let totals = datasets.iter().fold(
        SpaceAmplificationTotals {
            dataset_count: 0,
            used_bytes: 0,
            logical_used_bytes: 0,
            referenced_bytes: 0,
            logical_referenced_bytes: 0,
        },
        |mut acc, row| {
            acc.dataset_count += 1;
            acc.used_bytes = acc.used_bytes.saturating_add(row.used_bytes.unwrap_or(0));
            acc.logical_used_bytes = acc
                .logical_used_bytes
                .saturating_add(row.logical_used_bytes.unwrap_or(0));
            acc.referenced_bytes = acc
                .referenced_bytes
                .saturating_add(row.referenced_bytes.unwrap_or(0));
            acc.logical_referenced_bytes = acc
                .logical_referenced_bytes
                .saturating_add(row.logical_referenced_bytes.unwrap_or(0));
            acc
        },
    );

    let root_dataset = datasets
        .iter()
        .find(|row| row.name == pool)
        .cloned()
        .unwrap_or_else(|| datasets[0].clone());
    let logical_used_bytes = root_dataset.logical_used_bytes;
    let logical_vs_physical_ratio = ratio_u64(logical_used_bytes, allocated_bytes);
    let physical_vs_logical_ratio = ratio_u64(allocated_bytes, logical_used_bytes);
    let physical_minus_logical_bytes = signed_delta_i64(allocated_bytes, logical_used_bytes);

    let sampled_at_unix_sec = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);

    Ok(Json(json!({
        "pool": pool,
        "sampled_at_unix_sec": sampled_at_unix_sec,
        "pool_summary": SpaceAmplificationPoolSummary {
            size_bytes,
            allocated_bytes,
            free_bytes,
            frag_percent,
            dedup_ratio,
            logical_used_bytes,
            logical_vs_physical_ratio,
            physical_vs_logical_ratio,
            physical_minus_logical_bytes,
        },
        "totals": totals,
        "datasets": datasets,
        "source": {
            "zpool": "zpool list -H -p -o size,alloc,free,frag,dedupratio",
            "zfs": "zfs list -H -p -r -t filesystem,volume -o name,type,used,logicalused,referenced,logicalreferenced,compressratio"
        }
    })))
}

/// GET /api/mode - current pool open mode
pub async fn get_mode(State(state): State<AppState>) -> ApiResult {
    let config = pool_open_config(&state);
    Ok(Json(build_mode_payload(&config)))
}

#[derive(Debug, Deserialize)]
pub struct SetModeRequest {
    pub mode: String,
}

/// PUT /api/mode - switch pool open mode at runtime
pub async fn set_mode(
    State(state): State<AppState>,
    Json(request): Json<SetModeRequest>,
) -> ApiResult {
    let Some(next_mode) = parse_pool_open_mode(&request.mode) else {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "mode must be 'live' or 'offline'",
        ));
    };

    let mut changed = false;
    {
        let mut config = state.pool_open.lock().unwrap();
        if config.mode != next_mode {
            config.mode = next_mode;
            changed = true;
        }
    }

    if changed {
        let mut pool_guard = state.pool.lock().unwrap();
        if let Some(old) = pool_guard.take() {
            crate::ffi::pool_close(old.ptr);
        }
    }

    let config = pool_open_config(&state);
    Ok(Json(build_mode_payload(&config)))
}

/// GET /api/pools - List all imported pools
pub async fn list_pools(State(state): State<AppState>) -> ApiResult {
    let pool_open = pool_open_config(&state);

    if matches!(pool_open.mode, crate::PoolOpenMode::Offline)
        && !pool_open.offline_pool_names.is_empty()
    {
        let pools = pool_open
            .offline_pool_names
            .iter()
            .cloned()
            .map(Value::String)
            .collect::<Vec<_>>();
        return Ok(Json(Value::Array(pools)));
    }

    let result = crate::ffi::list_pools();

    if !result.is_ok() {
        let err_msg = result.error_msg().unwrap_or("Unknown error");
        tracing::error!("Failed to list pools: {}", err_msg);
        return Err(api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            err_msg.to_string(),
        ));
    }

    let json_str = result
        .json()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result"))?;
    let value = parse_json_value(json_str)?;

    Ok(Json(value))
}

/// GET /api/pools/:pool/datasets
pub async fn list_pool_datasets(
    State(state): State<AppState>,
    Path(pool): Path<String>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::pool_datasets(pool_ptr);
    json_from_result(result)
}

/// GET /api/pools/:pool/summary
pub async fn pool_summary(State(state): State<AppState>, Path(pool): Path<String>) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::pool_summary(pool_ptr);
    json_from_result(result)
}

#[derive(Debug, Deserialize)]
pub struct PoolErrorsQuery {
    pub cursor: Option<u64>,
    pub limit: Option<u64>,
    pub resolve_paths: Option<bool>,
}

/// GET /api/pools/:pool/errors?cursor=&limit=&resolve_paths=
pub async fn pool_errors(
    State(state): State<AppState>,
    Path(pool): Path<String>,
    Query(params): Query<PoolErrorsQuery>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let (cursor, limit) = normalize_cursor_limit(params.cursor, params.limit);
    let resolve_paths = params.resolve_paths.unwrap_or(true);
    let result = crate::ffi::pool_errors(pool_ptr, cursor, limit, resolve_paths);
    json_from_result(result)
}

#[derive(Debug, Deserialize)]
pub struct MosListQuery {
    #[serde(rename = "type")]
    pub type_filter: Option<i32>,
    pub start: Option<u64>,
    pub limit: Option<u64>,
}

fn parse_json_value(json_str: &str) -> Result<Value, ApiError> {
    serde_json::from_str(json_str).map_err(|e| {
        tracing::error!("Failed to parse JSON: {}", e);
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("JSON parse error: {}", e),
        )
    })
}

fn normalize_limit(limit: Option<u64>) -> u64 {
    limit.unwrap_or(DEFAULT_PAGE_LIMIT).clamp(1, MAX_PAGE_LIMIT)
}

fn normalize_cursor_limit(cursor: Option<u64>, limit: Option<u64>) -> (u64, u64) {
    (cursor.unwrap_or(0), normalize_limit(limit))
}

fn normalize_spacemap_limit(limit: Option<u64>) -> u64 {
    limit
        .unwrap_or(SPACEMAP_DEFAULT_LIMIT)
        .clamp(1, SPACEMAP_MAX_LIMIT)
}

fn normalize_spacemap_cursor_limit(cursor: Option<u64>, limit: Option<u64>) -> (u64, u64) {
    (cursor.unwrap_or(0), normalize_spacemap_limit(limit))
}

fn normalize_spacemap_bins_limit(limit: Option<u64>) -> u64 {
    limit
        .unwrap_or(SPACEMAP_BINS_DEFAULT_LIMIT)
        .clamp(1, SPACEMAP_BINS_MAX_LIMIT)
}

fn normalize_spacemap_bin_size(bin_size: Option<u64>) -> u64 {
    bin_size
        .unwrap_or(SPACEMAP_BINS_DEFAULT_SIZE)
        .clamp(SPACEMAP_BINS_MIN_SIZE, SPACEMAP_BINS_MAX_SIZE)
}

fn normalize_spacemap_bins_cursor_limit(cursor: Option<u64>, limit: Option<u64>) -> (u64, u64) {
    (cursor.unwrap_or(0), normalize_spacemap_bins_limit(limit))
}

fn normalize_block_tree_depth(depth: Option<u64>) -> u64 {
    depth
        .unwrap_or(BLOCK_TREE_DEFAULT_DEPTH)
        .min(BLOCK_TREE_MAX_DEPTH)
}

fn normalize_block_tree_nodes(max_nodes: Option<u64>) -> u64 {
    max_nodes
        .unwrap_or(BLOCK_TREE_DEFAULT_NODES)
        .clamp(1, BLOCK_TREE_MAX_NODES)
}

fn normalize_objset_data_limit(limit: Option<u64>) -> u64 {
    limit
        .unwrap_or(OBJSET_DATA_DEFAULT_LIMIT)
        .clamp(1, OBJSET_DATA_MAX_LIMIT)
}

fn parse_spacemap_op_filter(op: Option<&str>) -> Result<i32, ApiError> {
    let normalized = op.unwrap_or("all").trim().to_ascii_lowercase();
    match normalized.as_str() {
        "" | "all" => Ok(0),
        "alloc" => Ok(1),
        "free" => Ok(2),
        _ => Err(api_error(
            StatusCode::BAD_REQUEST,
            format!("invalid op filter '{normalized}'; expected all, alloc, or free"),
        )),
    }
}

fn parse_graph_include(include: Option<&str>) -> (bool, bool, bool) {
    let include = include.unwrap_or("semantic,physical");
    (
        include.contains("semantic"),
        include.contains("physical"),
        include.contains("zap"),
    )
}

fn parse_dsl_children(value: &Value) -> Vec<(String, u64)> {
    let Some(children) = value["children"].as_array() else {
        return Vec::new();
    };

    children
        .iter()
        .filter_map(|child| {
            let child_objid = child["dir_objid"].as_u64()?;
            if child_objid == 0 {
                return None;
            }
            let child_name = child["name"].as_str().unwrap_or("dataset").to_string();
            Some((child_name, child_objid))
        })
        .collect()
}

fn build_dataset_objset_response(dir_obj: u64, head_obj: u64, objset_value: &Value) -> Value {
    serde_json::json!({
        "dsl_dir_obj": dir_obj,
        "head_dataset_obj": head_obj,
        "objset_id": objset_value["objset_id"],
        "rootbp": objset_value["rootbp"]
    })
}

fn json_from_result(result: crate::ffi::ZdxResult) -> ApiResult {
    if !result.is_ok() {
        let err_msg = result.error_msg().unwrap_or("Unknown error");
        let err_code = result.error_code();
        let code_label = pool_open_error_code(err_code);
        tracing::error!("FFI error: {}", err_msg);
        return Err(api_error_with(
            StatusCode::INTERNAL_SERVER_ERROR,
            code_label,
            err_msg.to_string(),
            None,
            false,
        ));
    }

    let json_str = result
        .json()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result"))?;

    let value = parse_json_value(json_str)?;

    Ok(Json(value))
}

fn ensure_pool(state: &AppState, pool: &str) -> Result<*mut crate::ffi::zdx_pool_t, ApiError> {
    let pool_open = pool_open_config(state);
    let mut guard = state.pool.lock().unwrap();

    if let Some(existing) = guard.as_ref() {
        if existing.name == pool {
            return Ok(existing.ptr);
        }
    }

    if let Some(old) = guard.take() {
        crate::ffi::pool_close(old.ptr);
    }

    let mode = pool_open.mode;
    let mode_name = pool_open_mode_name(mode);
    let handle = match mode {
        crate::PoolOpenMode::Live => crate::ffi::pool_open(pool),
        crate::PoolOpenMode::Offline => {
            crate::ffi::pool_open_offline(pool, pool_open.offline_search_paths.as_deref())
        }
    }
    .map_err(|(code, msg)| {
        let err_code = pool_open_error_code(code);
        let hint = if matches!(mode, crate::PoolOpenMode::Offline) {
            offline_pool_open_hint(pool, code)
        } else if code == libc::EACCES || code == libc::EPERM {
            Some("Run backend with sudo for live imported pools.".to_string())
        } else {
            None
        };

        let expected_client_error = matches!(mode, crate::PoolOpenMode::Offline)
            && matches!(
                libzfs_error_name(code),
                Some("EZFS_NOENT" | "EZFS_PERM" | "EZFS_ACTIVE_POOL" | "EZFS_CRYPTOFAILED")
            )
            || matches!(
                code,
                libc::ENOENT | libc::EACCES | libc::EPERM | libc::EEXIST
            );

        if expected_client_error {
            tracing::warn!(
                "Pool open warning for {} (mode={}, code={}): {}",
                pool,
                mode_name,
                err_code,
                msg
            );
        } else {
            tracing::error!(
                "Failed to open pool {} (mode={}, code={}): {}",
                pool,
                mode_name,
                err_code,
                msg
            );
        }

        let status = if expected_client_error {
            StatusCode::BAD_REQUEST
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };

        api_error_with(
            status,
            err_code,
            format!("pool open failed ({mode_name}): {msg}"),
            hint,
            true,
        )
    })?;

    let ptr = handle.ptr;
    *guard = Some(handle);
    Ok(ptr)
}

/// GET /api/pools/:pool/mos/objects
pub async fn mos_list_objects(
    State(state): State<AppState>,
    Path(pool): Path<String>,
    Query(params): Query<MosListQuery>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;

    let type_filter = params.type_filter.unwrap_or(-1);
    let start = params.start.unwrap_or(0);
    let limit = normalize_limit(params.limit);

    let result = crate::ffi::mos_list_objects(pool_ptr, type_filter, start, limit);
    json_from_result(result)
}

/// GET /api/pools/:pool/objset/:objset_id/objects
pub async fn objset_list_objects(
    State(state): State<AppState>,
    Path((pool, objset_id)): Path<(String, u64)>,
    Query(params): Query<MosListQuery>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;

    let type_filter = params.type_filter.unwrap_or(-1);
    let start = params.start.unwrap_or(0);
    let limit = normalize_limit(params.limit);

    let result = crate::ffi::objset_list_objects(pool_ptr, objset_id, type_filter, start, limit);
    if !result.is_ok() {
        let err_msg = result.error_msg().unwrap_or("Unknown error");
        let status = if is_objset_user_input_error(err_msg) {
            StatusCode::BAD_REQUEST
        } else {
            tracing::error!("FFI error: {}", err_msg);
            StatusCode::INTERNAL_SERVER_ERROR
        };
        return Err(api_error(status, err_msg.to_string()));
    }
    let json_str = result
        .json()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result"))?;
    let value = parse_json_value(json_str)?;
    Ok(Json(value))
}

/// GET /api/pools/:pool/obj/:objid
pub async fn mos_get_object(
    State(state): State<AppState>,
    Path((pool, objid)): Path<(String, u64)>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::mos_get_object(pool_ptr, objid);
    json_from_result(result)
}

/// GET /api/pools/:pool/obj/:objid/blkptrs
pub async fn mos_get_blkptrs(
    State(state): State<AppState>,
    Path((pool, objid)): Path<(String, u64)>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::mos_get_blkptrs(pool_ptr, objid);
    json_from_result(result)
}

#[derive(Debug, Deserialize)]
pub struct BlockTreeQuery {
    pub max_depth: Option<u64>,
    pub max_nodes: Option<u64>,
}

/// GET /api/pools/:pool/obj/:objid/block-tree?max_depth=&max_nodes=
pub async fn mos_block_tree(
    State(state): State<AppState>,
    Path((pool, objid)): Path<(String, u64)>,
    Query(params): Query<BlockTreeQuery>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let max_depth = normalize_block_tree_depth(params.max_depth);
    let max_nodes = normalize_block_tree_nodes(params.max_nodes);
    let result = crate::ffi::mos_block_tree(pool_ptr, objid, max_depth, max_nodes);
    json_from_result(result)
}

/// GET /api/pools/:pool/obj/:objid/full
pub async fn obj_get_full(
    State(state): State<AppState>,
    Path((pool, objid)): Path<(String, u64)>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::obj_get(pool_ptr, objid);
    json_from_result(result)
}

/// GET /api/mos/types
pub async fn list_dmu_types() -> ApiResult {
    let result = crate::ffi::list_dmu_types();
    json_from_result(result)
}

#[derive(Debug, Deserialize)]
pub struct ZapEntriesQuery {
    pub cursor: Option<u64>,
    pub limit: Option<u64>,
}

/// GET /api/pools/:pool/obj/:objid/zap/info
pub async fn zap_info(
    State(state): State<AppState>,
    Path((pool, objid)): Path<(String, u64)>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::zap_info(pool_ptr, objid);
    json_from_result(result)
}

/// GET /api/pools/:pool/obj/:objid/zap
pub async fn zap_entries(
    State(state): State<AppState>,
    Path((pool, objid)): Path<(String, u64)>,
    Query(params): Query<ZapEntriesQuery>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let (cursor, limit) = normalize_cursor_limit(params.cursor, params.limit);
    let result = crate::ffi::zap_entries(pool_ptr, objid, cursor, limit);
    json_from_result(result)
}

/// GET /api/pools/:pool/dsl/dir/:objid/children
pub async fn dsl_dir_children(
    State(state): State<AppState>,
    Path((pool, objid)): Path<(String, u64)>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::dsl_dir_children(pool_ptr, objid);
    json_from_result(result)
}

/// GET /api/pools/:pool/dsl/dir/:objid/head
pub async fn dsl_dir_head(
    State(state): State<AppState>,
    Path((pool, objid)): Path<(String, u64)>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::dsl_dir_head(pool_ptr, objid);
    json_from_result(result)
}

/// GET /api/pools/:pool/dsl/root
pub async fn dsl_root_dir(State(state): State<AppState>, Path(pool): Path<String>) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::dsl_root_dir(pool_ptr);
    json_from_result(result)
}

#[derive(Debug, Deserialize)]
pub struct BlockQuery {
    pub vdev: u64,
    pub offset: u64,
    pub asize: u64,
    pub limit: Option<u64>,
}

/// GET /api/pools/:pool/block?vdev=...&offset=...&asize=...&limit=...
pub async fn read_block(
    State(state): State<AppState>,
    Path(pool): Path<String>,
    Query(params): Query<BlockQuery>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;

    if params.asize == 0 {
        return Err(api_error(StatusCode::BAD_REQUEST, "asize must be > 0"));
    }

    let max_read: u64 = 1 << 20;
    let limit = params.limit.unwrap_or(64 * 1024);
    let mut size = params.asize.min(limit).min(max_read);

    if size == 0 {
        size = params.asize.min(max_read);
    }

    let result = crate::ffi::read_block(pool_ptr, params.vdev, params.offset, size);
    if !result.is_ok() {
        let err_msg = result.error_msg().unwrap_or("Unknown error");
        tracing::error!("FFI error: {}", err_msg);
        return Err(api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            err_msg.to_string(),
        ));
    }

    let json_str = result
        .json()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result"))?;

    let mut value = parse_json_value(json_str)?;

    value["asize"] = Value::from(params.asize);
    value["truncated"] = Value::from(size < params.asize);
    value["requested"] = Value::from(size);

    Ok(Json(value))
}

#[derive(Debug, Deserialize)]
pub struct DatasetTreeQuery {
    pub depth: Option<u8>,
    pub limit: Option<usize>,
}

/// GET /api/pools/:pool/datasets/tree?depth=&limit=
pub async fn dataset_tree(
    State(state): State<AppState>,
    Path(pool): Path<String>,
    Query(params): Query<DatasetTreeQuery>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let max_depth = params.depth.unwrap_or(4);
    let limit = params.limit.unwrap_or(500);

    let root_result = crate::ffi::dsl_root_dir(pool_ptr);
    if !root_result.is_ok() {
        let err_msg = root_result.error_msg().unwrap_or("Unknown error");
        tracing::error!("FFI error: {}", err_msg);
        return Err(api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            err_msg.to_string(),
        ));
    }

    let root_json = root_result
        .json()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result"))?;
    let root_value = parse_json_value(root_json)?;
    let root_dir = root_value["root_dir_obj"]
        .as_u64()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "root_dir_obj missing"))?;

    let mut seen = 0usize;
    let mut truncated = false;

    fn build_node(
        pool_ptr: *mut crate::ffi::zdx_pool_t,
        name: String,
        objid: u64,
        depth: u8,
        seen: &mut usize,
        limit: usize,
        truncated: &mut bool,
    ) -> Result<Value, ApiError> {
        if *seen >= limit {
            *truncated = true;
            return Ok(serde_json::json!({
                "name": name,
                "dsl_dir_obj": objid,
                "head_dataset_obj": null,
                "child_dir_zapobj": null,
                "children": []
            }));
        }
        *seen += 1;

        let head_result = crate::ffi::dsl_dir_head(pool_ptr, objid);
        if !head_result.is_ok() {
            let err_msg = head_result.error_msg().unwrap_or("Unknown error");
            tracing::error!("FFI error: {}", err_msg);
            return Err(api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                err_msg.to_string(),
            ));
        }
        let head_json = head_result.json().ok_or_else(|| {
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Missing JSON in head result",
            )
        })?;
        let head_value = parse_json_value(head_json)?;
        let head_dataset_obj = head_value["head_dataset_obj"]
            .as_u64()
            .filter(|value| *value != 0);

        let children_result = crate::ffi::dsl_dir_children(pool_ptr, objid);
        if !children_result.is_ok() {
            let err_msg = children_result.error_msg().unwrap_or("Unknown error");
            tracing::error!("FFI error: {}", err_msg);
            return Err(api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                err_msg.to_string(),
            ));
        }
        let children_json = children_result.json().ok_or_else(|| {
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Missing JSON in children result",
            )
        })?;
        let children_value = parse_json_value(children_json)?;
        let child_dir_zapobj = children_value["child_dir_zapobj"].as_u64();

        let mut children_nodes: Vec<Value> = Vec::new();
        if depth > 0 {
            for (child_name, child_objid) in parse_dsl_children(&children_value) {
                let node = build_node(
                    pool_ptr,
                    child_name,
                    child_objid,
                    depth - 1,
                    seen,
                    limit,
                    truncated,
                )?;
                children_nodes.push(node);
                if *truncated {
                    break;
                }
            }
        }

        Ok(serde_json::json!({
            "name": name,
            "dsl_dir_obj": objid,
            "head_dataset_obj": head_dataset_obj,
            "child_dir_zapobj": child_dir_zapobj,
            "children": children_nodes
        }))
    }

    let root_node = build_node(
        pool_ptr,
        pool.clone(),
        root_dir,
        max_depth,
        &mut seen,
        limit,
        &mut truncated,
    )?;

    let response = serde_json::json!({
        "root": root_node,
        "depth": max_depth,
        "limit": limit,
        "truncated": truncated,
        "count": seen
    });

    Ok(Json(response))
}

/// GET /api/pools/:pool/dataset/:dsl_dir_obj/head
pub async fn dataset_head(
    State(state): State<AppState>,
    Path((pool, dir_obj)): Path<(String, u64)>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let response = resolve_dataset_objset(pool_ptr, dir_obj)?;
    Ok(Json(response))
}

/// GET /api/pools/:pool/dataset/:dsl_dir_obj/objset
pub async fn dataset_objset(
    State(state): State<AppState>,
    Path((pool, dir_obj)): Path<(String, u64)>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let response = resolve_dataset_objset(pool_ptr, dir_obj)?;
    Ok(Json(response))
}

/// GET /api/pools/:pool/dataset/:dsl_dir_obj/snapshots
pub async fn dataset_snapshots(
    State(state): State<AppState>,
    Path((pool, dir_obj)): Path<(String, u64)>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::dataset_snapshots(pool_ptr, dir_obj);
    if !result.is_ok() {
        let err_msg = result.error_msg().unwrap_or("Unknown error");
        let status = if is_dataset_user_input_error(err_msg) {
            StatusCode::BAD_REQUEST
        } else {
            tracing::error!("FFI error: {}", err_msg);
            StatusCode::INTERNAL_SERVER_ERROR
        };
        return Err(api_error(status, err_msg.to_string()));
    }

    let json_str = result
        .json()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result"))?;

    let value = parse_json_value(json_str)?;
    Ok(Json(value))
}

/// GET /api/pools/:pool/dataset/:dsl_dir_obj/snapshot-count
pub async fn dataset_snapshot_count(
    State(state): State<AppState>,
    Path((pool, dir_obj)): Path<(String, u64)>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::dataset_snapshot_count(pool_ptr, dir_obj);
    if !result.is_ok() {
        let err_msg = result.error_msg().unwrap_or("Unknown error");
        let status = if is_dataset_user_input_error(err_msg) {
            StatusCode::BAD_REQUEST
        } else {
            tracing::error!("FFI error: {}", err_msg);
            StatusCode::INTERNAL_SERVER_ERROR
        };
        return Err(api_error(status, err_msg.to_string()));
    }

    let json_str = result
        .json()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result"))?;

    let value = parse_json_value(json_str)?;
    Ok(Json(value))
}

/// GET /api/pools/:pool/snapshot/:dsobj/objset
pub async fn snapshot_objset(
    State(state): State<AppState>,
    Path((pool, dsobj)): Path<(String, u64)>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::dataset_objset(pool_ptr, dsobj);
    if !result.is_ok() {
        let err_msg = result.error_msg().unwrap_or("Unknown error");
        let status = if is_dataset_user_input_error(err_msg) {
            StatusCode::BAD_REQUEST
        } else {
            tracing::error!("FFI error: {}", err_msg);
            StatusCode::INTERNAL_SERVER_ERROR
        };
        return Err(api_error(status, err_msg.to_string()));
    }

    let json_str = result
        .json()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result"))?;

    let value = parse_json_value(json_str)?;
    Ok(Json(value))
}

#[derive(Debug, Deserialize)]
pub struct SnapshotLineageQuery {
    pub max_prev: Option<u64>,
    pub max_next: Option<u64>,
}

/// GET /api/pools/:pool/snapshot/:dsobj/lineage?max_prev=&max_next=
pub async fn snapshot_lineage(
    State(state): State<AppState>,
    Path((pool, dsobj)): Path<(String, u64)>,
    Query(params): Query<SnapshotLineageQuery>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let max_prev = params.max_prev.unwrap_or(64).clamp(1, 4096);
    let max_next = params.max_next.unwrap_or(64).clamp(1, 4096);
    let result = crate::ffi::dataset_lineage(pool_ptr, dsobj, max_prev, max_next);
    json_from_result(result)
}

fn resolve_dataset_objset(
    pool_ptr: *mut crate::ffi::zdx_pool_t,
    dir_obj: u64,
) -> Result<Value, ApiError> {
    let head_result = crate::ffi::dsl_dir_head(pool_ptr, dir_obj);
    if !head_result.is_ok() {
        let err_msg = head_result.error_msg().unwrap_or("Unknown error");
        tracing::error!("FFI error: {}", err_msg);
        return Err(api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            err_msg.to_string(),
        ));
    }

    let head_json = head_result.json().ok_or_else(|| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Missing JSON in head result",
        )
    })?;
    let head_value = parse_json_value(head_json)?;

    let head_obj = head_value["head_dataset_obj"].as_u64().unwrap_or(0);
    if head_obj == 0 {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            format!(
                "DSL dir {} has no head dataset (special internal dir such as $FREE/$MOS)",
                dir_obj
            ),
        ));
    }

    let objset_result = crate::ffi::dataset_objset(pool_ptr, head_obj);
    if !objset_result.is_ok() {
        let err_msg = objset_result.error_msg().unwrap_or("Unknown error");
        let status = if is_dataset_user_input_error(err_msg) {
            StatusCode::BAD_REQUEST
        } else {
            tracing::error!("FFI error: {}", err_msg);
            StatusCode::INTERNAL_SERVER_ERROR
        };
        return Err(api_error(status, err_msg.to_string()));
    }

    let objset_json = objset_result.json().ok_or_else(|| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Missing JSON in objset result",
        )
    })?;
    let objset_value = parse_json_value(objset_json)?;

    let response = build_dataset_objset_response(dir_obj, head_obj, &objset_value);

    Ok(response)
}

/// GET /api/pools/:pool/objset/:objset_id/root
pub async fn objset_root(
    State(state): State<AppState>,
    Path((pool, objset_id)): Path<(String, u64)>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;

    let result = crate::ffi::objset_root(pool_ptr, objset_id);
    if !result.is_ok() {
        let err_msg = result.error_msg().unwrap_or("Unknown error");
        tracing::error!("FFI error: {}", err_msg);
        return Err(api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            err_msg.to_string(),
        ));
    }

    let json_str = result
        .json()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result"))?;
    let value = parse_json_value(json_str)?;

    Ok(Json(value))
}

#[derive(Debug, Deserialize)]
pub struct DirEntriesQuery {
    pub cursor: Option<u64>,
    pub limit: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct WalkQuery {
    pub path: Option<String>,
}

/// GET /api/pools/:pool/objset/:objset_id/dir/:dir_obj/entries
pub async fn objset_dir_entries(
    State(state): State<AppState>,
    Path((pool, objset_id, dir_obj)): Path<(String, u64, u64)>,
    Query(params): Query<DirEntriesQuery>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let (cursor, limit) = normalize_cursor_limit(params.cursor, params.limit);
    let result = crate::ffi::objset_dir_entries(pool_ptr, objset_id, dir_obj, cursor, limit);
    json_from_result(result)
}

/// GET /api/pools/:pool/objset/:objset_id/walk?path=/a/b/c
pub async fn objset_walk(
    State(state): State<AppState>,
    Path((pool, objset_id)): Path<(String, u64)>,
    Query(params): Query<WalkQuery>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let path = params.path.unwrap_or_else(|| "/".to_string());
    let result = crate::ffi::objset_walk(pool_ptr, objset_id, &path)
        .map_err(|e| api_error(StatusCode::BAD_REQUEST, e))?;
    json_from_result(result)
}

/// GET /api/pools/:pool/objset/:objset_id/stat/:objid
pub async fn objset_stat(
    State(state): State<AppState>,
    Path((pool, objset_id, objid)): Path<(String, u64, u64)>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::objset_stat(pool_ptr, objset_id, objid);
    json_from_result(result)
}

/// GET /api/pools/:pool/objset/:objset_id/obj/:objid
pub async fn objset_get_object(
    State(state): State<AppState>,
    Path((pool, objset_id, objid)): Path<(String, u64, u64)>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::objset_get_object(pool_ptr, objset_id, objid);
    if !result.is_ok() {
        let err_msg = result.error_msg().unwrap_or("Unknown error");
        let status = if is_objset_user_input_error(err_msg) {
            StatusCode::BAD_REQUEST
        } else {
            tracing::error!("FFI error: {}", err_msg);
            StatusCode::INTERNAL_SERVER_ERROR
        };
        return Err(api_error(status, err_msg.to_string()));
    }
    let json_str = result
        .json()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result"))?;
    let value = parse_json_value(json_str)?;
    Ok(Json(value))
}

/// GET /api/pools/:pool/objset/:objset_id/obj/:objid/blkptrs
pub async fn objset_get_blkptrs(
    State(state): State<AppState>,
    Path((pool, objset_id, objid)): Path<(String, u64, u64)>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::objset_get_blkptrs(pool_ptr, objset_id, objid);
    if !result.is_ok() {
        let err_msg = result.error_msg().unwrap_or("Unknown error");
        let status = if is_objset_user_input_error(err_msg) {
            StatusCode::BAD_REQUEST
        } else {
            tracing::error!("FFI error: {}", err_msg);
            StatusCode::INTERNAL_SERVER_ERROR
        };
        return Err(api_error(status, err_msg.to_string()));
    }
    let json_str = result
        .json()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result"))?;
    let value = parse_json_value(json_str)?;
    Ok(Json(value))
}

/// GET /api/pools/:pool/objset/:objset_id/obj/:objid/block-tree?max_depth=&max_nodes=
pub async fn objset_block_tree(
    State(state): State<AppState>,
    Path((pool, objset_id, objid)): Path<(String, u64, u64)>,
    Query(params): Query<BlockTreeQuery>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let max_depth = normalize_block_tree_depth(params.max_depth);
    let max_nodes = normalize_block_tree_nodes(params.max_nodes);
    let result = crate::ffi::objset_block_tree(pool_ptr, objset_id, objid, max_depth, max_nodes);
    if !result.is_ok() {
        let err_msg = result.error_msg().unwrap_or("Unknown error");
        let status = if is_objset_user_input_error(err_msg) {
            StatusCode::BAD_REQUEST
        } else {
            tracing::error!("FFI error: {}", err_msg);
            StatusCode::INTERNAL_SERVER_ERROR
        };
        return Err(api_error(status, err_msg.to_string()));
    }
    let json_str = result
        .json()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result"))?;
    let value = parse_json_value(json_str)?;
    Ok(Json(value))
}

/// GET /api/pools/:pool/objset/:objset_id/obj/:objid/zap/info
pub async fn objset_zap_info(
    State(state): State<AppState>,
    Path((pool, objset_id, objid)): Path<(String, u64, u64)>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::objset_zap_info(pool_ptr, objset_id, objid);
    if !result.is_ok() {
        let err_msg = result.error_msg().unwrap_or("Unknown error");
        return Err(api_error_for_objset(err_msg));
    }
    let json_str = result
        .json()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result"))?;
    let value = parse_json_value(json_str)?;
    Ok(Json(value))
}

/// GET /api/pools/:pool/objset/:objset_id/obj/:objid/zap
pub async fn objset_zap_entries(
    State(state): State<AppState>,
    Path((pool, objset_id, objid)): Path<(String, u64, u64)>,
    Query(params): Query<ZapEntriesQuery>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let (cursor, limit) = normalize_cursor_limit(params.cursor, params.limit);
    let result = crate::ffi::objset_zap_entries(pool_ptr, objset_id, objid, cursor, limit);
    if !result.is_ok() {
        let err_msg = result.error_msg().unwrap_or("Unknown error");
        return Err(api_error_for_objset(err_msg));
    }
    let json_str = result
        .json()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result"))?;
    let value = parse_json_value(json_str)?;
    Ok(Json(value))
}

/// GET /api/pools/:pool/objset/:objset_id/obj/:objid/full
pub async fn objset_get_full(
    State(state): State<AppState>,
    Path((pool, objset_id, objid)): Path<(String, u64, u64)>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;

    let obj_result = crate::ffi::objset_get_object(pool_ptr, objset_id, objid);
    if !obj_result.is_ok() {
        let err_msg = obj_result.error_msg().unwrap_or("Unknown error");
        return Err(api_error_for_objset(err_msg));
    }

    let blk_result = crate::ffi::objset_get_blkptrs(pool_ptr, objset_id, objid);
    if !blk_result.is_ok() {
        let err_msg = blk_result.error_msg().unwrap_or("Unknown error");
        return Err(api_error_for_objset(err_msg));
    }

    let obj_json = obj_result.json().ok_or_else(|| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Missing JSON in object result",
        )
    })?;
    let blk_json = blk_result.json().ok_or_else(|| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Missing JSON in blkptr result",
        )
    })?;

    let obj_value = parse_json_value(obj_json)?;
    let blk_value = parse_json_value(blk_json)?;

    let mut zap_info_value = Value::Null;
    let mut zap_entries_value = Value::Null;
    let mut zap_error_value = Value::Null;
    let is_zap = obj_value
        .get("is_zap")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if is_zap {
        let zinfo_result = crate::ffi::objset_zap_info(pool_ptr, objset_id, objid);
        if !zinfo_result.is_ok() {
            let err_msg = zinfo_result.error_msg().unwrap_or("Unknown error");
            if let Some(payload) = inline_zap_error_payload(err_msg) {
                zap_error_value = payload;
            } else {
                return Err(api_error_for_objset(err_msg));
            }
        } else {
            let zinfo_json = zinfo_result.json().ok_or_else(|| {
                api_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Missing JSON in objset zap info result",
                )
            })?;
            zap_info_value = parse_json_value(zinfo_json)?;
        }

        if zap_error_value.is_null() {
            let zents_result =
                crate::ffi::objset_zap_entries(pool_ptr, objset_id, objid, 0, DEFAULT_PAGE_LIMIT);
            if !zents_result.is_ok() {
                let err_msg = zents_result.error_msg().unwrap_or("Unknown error");
                if let Some(payload) = inline_zap_error_payload(err_msg) {
                    zap_error_value = payload;
                } else {
                    return Err(api_error_for_objset(err_msg));
                }
            } else {
                let zents_json = zents_result.json().ok_or_else(|| {
                    api_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Missing JSON in objset zap entries result",
                    )
                })?;
                zap_entries_value = parse_json_value(zents_json)?;
            }
        }
    }

    Ok(Json(json!({
        "object": obj_value,
        "blkptrs": blk_value,
        "zap_info": zap_info_value,
        "zap_entries": zap_entries_value,
        "zap_error": zap_error_value
    })))
}

#[derive(Debug, Deserialize)]
pub struct ObjsetDataQuery {
    pub offset: Option<u64>,
    pub limit: Option<u64>,
}

/// GET /api/pools/:pool/objset/:objset_id/obj/:objid/data?offset=&limit=
pub async fn objset_read_data(
    State(state): State<AppState>,
    Path((pool, objset_id, objid)): Path<(String, u64, u64)>,
    Query(params): Query<ObjsetDataQuery>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let offset = params.offset.unwrap_or(0);
    let limit = normalize_objset_data_limit(params.limit);
    let result = crate::ffi::objset_read_data(pool_ptr, objset_id, objid, offset, limit);
    if !result.is_ok() {
        let err_msg = result.error_msg().unwrap_or("Unknown error");
        let status = if is_objset_user_input_error(err_msg) {
            StatusCode::BAD_REQUEST
        } else {
            tracing::error!("FFI error: {}", err_msg);
            StatusCode::INTERNAL_SERVER_ERROR
        };
        return Err(api_error(status, err_msg.to_string()));
    }
    let json_str = result
        .json()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result"))?;
    let value = parse_json_value(json_str)?;
    Ok(Json(value))
}

#[derive(Debug, Deserialize)]
struct DatasetCatalogEntry {
    name: String,
    #[serde(rename = "type")]
    dataset_type: String,
    mountpoint: Option<String>,
    mounted: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct ObjsetWalkPayload {
    objid: u64,
    found: bool,
    remaining: String,
}

#[derive(Debug, Deserialize)]
struct ObjsetStatPayload {
    size: u64,
    type_name: String,
}

#[derive(Debug, Deserialize)]
struct ObjsetDataPayload {
    data_hex: String,
}

#[derive(Debug, Clone)]
struct ZplPathContext {
    dataset_name: String,
    objset_id: u64,
    rel_path: String,
    objid: u64,
    file_size: u64,
    filename: String,
}

fn decode_hex_bytes(data_hex: &str) -> Result<Vec<u8>, ApiError> {
    let trimmed = data_hex.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    if trimmed.len() % 2 != 0 {
        return Err(api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "invalid hex payload length from backend read",
        ));
    }

    fn nibble(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }

    let bytes = trimmed.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut idx = 0usize;
    while idx < bytes.len() {
        let hi = nibble(bytes[idx]).ok_or_else(|| {
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "invalid hex payload from backend read",
            )
        })?;
        let lo = nibble(bytes[idx + 1]).ok_or_else(|| {
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "invalid hex payload from backend read",
            )
        })?;
        out.push((hi << 4) | lo);
        idx += 2;
    }

    Ok(out)
}

fn split_clean_path(path: &str) -> Vec<&str> {
    path.split('/')
        .filter(|segment| !segment.is_empty())
        .collect()
}

fn dataset_path_match(dataset: &str, path: &str) -> Option<String> {
    if path == dataset {
        return Some(String::new());
    }

    let prefix = format!("{dataset}/");
    if path.starts_with(&prefix) {
        return Some(path[prefix.len()..].to_string());
    }

    None
}

fn mountpoint_path_match(mountpoint: &str, absolute_path: &str) -> Option<String> {
    if absolute_path == mountpoint {
        return Some(String::new());
    }

    let prefix = format!("{mountpoint}/");
    if absolute_path.starts_with(&prefix) {
        return Some(absolute_path[prefix.len()..].to_string());
    }

    None
}

fn load_dataset_catalog(
    pool_ptr: *mut crate::ffi::zdx_pool_t,
) -> Result<Vec<DatasetCatalogEntry>, ApiError> {
    let datasets_result = crate::ffi::pool_datasets(pool_ptr);
    if !datasets_result.is_ok() {
        let err_msg = datasets_result.error_msg().unwrap_or("Unknown error");
        let err_code = datasets_result.error_code();
        let code = pool_open_error_code(err_code);
        return Err(api_error_with(
            StatusCode::INTERNAL_SERVER_ERROR,
            code,
            format!("failed to list datasets: {err_msg}"),
            None,
            false,
        ));
    }

    let datasets_json = datasets_result
        .json()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result"))?;
    let datasets_value = parse_json_value(datasets_json)?;
    serde_json::from_value::<Vec<DatasetCatalogEntry>>(datasets_value).map_err(|err| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to parse dataset catalog: {err}"),
        )
    })
}

fn resolve_dataset_dir_obj_by_name(
    pool_ptr: *mut crate::ffi::zdx_pool_t,
    pool_name: &str,
    dataset_name: &str,
) -> Result<u64, ApiError> {
    let root_result = crate::ffi::dsl_root_dir(pool_ptr);
    if !root_result.is_ok() {
        let err_msg = root_result.error_msg().unwrap_or("Unknown error");
        return Err(api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to resolve DSL root: {err_msg}"),
        ));
    }
    let root_json = root_result
        .json()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result"))?;
    let root_value = parse_json_value(root_json)?;
    let root_dir_obj = root_value["root_dir_obj"].as_u64().ok_or_else(|| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "root_dir_obj missing in DSL root payload",
        )
    })?;

    if dataset_name == pool_name {
        return Ok(root_dir_obj);
    }

    let pool_prefix = format!("{pool_name}/");
    let suffix = dataset_name.strip_prefix(&pool_prefix).ok_or_else(|| {
        api_error_with(
            StatusCode::BAD_REQUEST,
            "INVALID_DATASET_PATH",
            format!("dataset '{dataset_name}' is not under pool '{pool_name}'"),
            Some("Use paths rooted at the selected pool name.".to_string()),
            true,
        )
    })?;

    let components = split_clean_path(suffix);
    if components.is_empty() {
        return Ok(root_dir_obj);
    }

    let mut current_dir_obj = root_dir_obj;
    for component in components {
        let children_result = crate::ffi::dsl_dir_children(pool_ptr, current_dir_obj);
        if !children_result.is_ok() {
            let err_msg = children_result.error_msg().unwrap_or("Unknown error");
            return Err(api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to enumerate DSL children: {err_msg}"),
            ));
        }
        let children_json = children_result.json().ok_or_else(|| {
            api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result")
        })?;
        let children_value = parse_json_value(children_json)?;
        let children = parse_dsl_children(&children_value);
        let next_obj = children
            .iter()
            .find_map(|(name, obj)| if name == component { Some(*obj) } else { None })
            .ok_or_else(|| {
                api_error_with(
                    StatusCode::NOT_FOUND,
                    "DATASET_NOT_FOUND",
                    format!("dataset component '{component}' not found under '{dataset_name}'"),
                    Some("Refresh dataset tree and verify the dataset path exists.".to_string()),
                    true,
                )
            })?;
        current_dir_obj = next_obj;
    }

    Ok(current_dir_obj)
}

fn resolve_zpl_path_context(
    pool_ptr: *mut crate::ffi::zdx_pool_t,
    pool_name: &str,
    zpl_path: &str,
) -> Result<ZplPathContext, ApiError> {
    let trimmed = zpl_path.trim();
    if trimmed.is_empty() {
        return Err(api_error_with(
            StatusCode::BAD_REQUEST,
            "INVALID_PATH",
            "path is empty",
            Some(
                "Provide a dataset-relative path like pool/dataset/file or an absolute mount path."
                    .to_string(),
            ),
            true,
        ));
    }

    let absolute_path = if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    };
    let normalized_path = trimmed.trim_start_matches('/').to_string();

    let catalog = load_dataset_catalog(pool_ptr)?;
    let mut candidates: Vec<(usize, String, String)> = Vec::new();
    for entry in catalog
        .iter()
        .filter(|entry| entry.dataset_type == "filesystem")
    {
        if let Some(rel) = dataset_path_match(&entry.name, &normalized_path) {
            candidates.push((entry.name.len(), entry.name.clone(), rel));
        }

        if let Some(mountpoint) = entry.mountpoint.as_deref() {
            if entry.mounted != Some(false) {
                if let Some(rel) = mountpoint_path_match(mountpoint, &absolute_path) {
                    candidates.push((mountpoint.len(), entry.name.clone(), rel));
                }
            }
        }
    }

    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    let Some((_, dataset_name, rel_path)) = candidates.into_iter().next() else {
        return Err(api_error_with(
            StatusCode::BAD_REQUEST,
            "DATASET_PATH_UNRESOLVED",
            format!("could not resolve dataset for path '{zpl_path}'"),
            Some(
                "Use either an absolute mounted path (/pool/dataset/file) or a dataset path \
like pool/dataset/file."
                    .to_string(),
            ),
            true,
        ));
    };

    let dir_obj = resolve_dataset_dir_obj_by_name(pool_ptr, pool_name, &dataset_name)?;
    let objset_payload = resolve_dataset_objset(pool_ptr, dir_obj)?;
    let objset_id = objset_payload["objset_id"].as_u64().ok_or_else(|| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "objset_id missing in dataset resolution payload",
        )
    })?;

    let walk_path = if rel_path.is_empty() {
        "/".to_string()
    } else {
        format!("/{rel_path}")
    };
    let walk_result = crate::ffi::objset_walk(pool_ptr, objset_id, &walk_path)
        .map_err(|err| api_error(StatusCode::BAD_REQUEST, err))?;
    if !walk_result.is_ok() {
        let err_msg = walk_result.error_msg().unwrap_or("Unknown error");
        return Err(api_error_with(
            StatusCode::BAD_REQUEST,
            "ZPL_WALK_FAILED",
            format!("failed to walk path '{walk_path}': {err_msg}"),
            Some("Verify the file path and dataset context.".to_string()),
            true,
        ));
    }
    let walk_json = walk_result
        .json()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result"))?;
    let walk_value = parse_json_value(walk_json)?;
    let walk = serde_json::from_value::<ObjsetWalkPayload>(walk_value).map_err(|err| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to parse walk payload: {err}"),
        )
    })?;

    if !walk.found || !walk.remaining.is_empty() {
        return Err(api_error_with(
            StatusCode::NOT_FOUND,
            "PATH_NOT_FOUND",
            format!("path '{walk_path}' could not be fully resolved"),
            Some("The requested file may not exist in this dataset or snapshot state.".to_string()),
            true,
        ));
    }

    let stat_result = crate::ffi::objset_stat(pool_ptr, objset_id, walk.objid);
    if !stat_result.is_ok() {
        let err_msg = stat_result.error_msg().unwrap_or("Unknown error");
        return Err(api_error_with(
            StatusCode::BAD_REQUEST,
            "OBJSET_STAT_FAILED",
            format!("failed to stat object {}: {}", walk.objid, err_msg),
            None,
            true,
        ));
    }
    let stat_json = stat_result
        .json()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result"))?;
    let stat_value = parse_json_value(stat_json)?;
    let stat = serde_json::from_value::<ObjsetStatPayload>(stat_value).map_err(|err| {
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to parse stat payload: {err}"),
        )
    })?;

    if stat.type_name != "file" {
        return Err(api_error_with(
            StatusCode::BAD_REQUEST,
            "NOT_A_FILE",
            format!(
                "resolved path '{walk_path}' is a {} object, not a file",
                stat.type_name
            ),
            Some("Use this endpoint only for file paths.".to_string()),
            true,
        ));
    }

    let filename = split_clean_path(&rel_path)
        .last()
        .map(|segment| (*segment).to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("objset-{objset_id}-obj-{}", walk.objid));

    Ok(ZplPathContext {
        dataset_name,
        objset_id,
        rel_path,
        objid: walk.objid,
        file_size: stat.size,
        filename,
    })
}

fn parse_range_header(headers: &HeaderMap, total_size: u64) -> Result<(u64, u64, bool), ApiError> {
    let Some(range_header) = headers.get(RANGE) else {
        if total_size == 0 {
            return Ok((0, 0, false));
        }
        return Ok((0, total_size - 1, false));
    };

    let header_value = range_header.to_str().map_err(|_| {
        api_error_with(
            StatusCode::BAD_REQUEST,
            "BAD_RANGE",
            "invalid Range header",
            None,
            true,
        )
    })?;
    let trimmed = header_value.trim();
    if !trimmed.starts_with("bytes=") {
        return Err(api_error_with(
            StatusCode::BAD_REQUEST,
            "BAD_RANGE",
            format!("unsupported Range header '{trimmed}'"),
            Some("Use a single byte range, for example: bytes=0-1048575".to_string()),
            true,
        ));
    }

    let range_expr = trimmed.trim_start_matches("bytes=").trim();
    if range_expr.contains(',') {
        return Err(api_error_with(
            StatusCode::BAD_REQUEST,
            "BAD_RANGE",
            "multiple byte ranges are not supported",
            Some("Use a single range request per call.".to_string()),
            true,
        ));
    }

    if total_size == 0 {
        return Err(api_error_with(
            StatusCode::RANGE_NOT_SATISFIABLE,
            "RANGE_NOT_SATISFIABLE",
            "cannot satisfy range for empty file",
            None,
            true,
        ));
    }

    let parts: Vec<&str> = range_expr.splitn(2, '-').collect();
    if parts.len() != 2 {
        return Err(api_error_with(
            StatusCode::BAD_REQUEST,
            "BAD_RANGE",
            format!("invalid Range header '{trimmed}'"),
            None,
            true,
        ));
    }

    let start_raw = parts[0].trim();
    let end_raw = parts[1].trim();

    let (start, end) = if start_raw.is_empty() {
        let suffix_len = u64::from_str(end_raw).map_err(|_| {
            api_error_with(
                StatusCode::BAD_REQUEST,
                "BAD_RANGE",
                format!("invalid suffix range '{trimmed}'"),
                None,
                true,
            )
        })?;
        if suffix_len == 0 {
            return Err(api_error_with(
                StatusCode::RANGE_NOT_SATISFIABLE,
                "RANGE_NOT_SATISFIABLE",
                "suffix length must be greater than zero",
                None,
                true,
            ));
        }
        if suffix_len >= total_size {
            (0, total_size - 1)
        } else {
            (total_size - suffix_len, total_size - 1)
        }
    } else {
        let start = u64::from_str(start_raw).map_err(|_| {
            api_error_with(
                StatusCode::BAD_REQUEST,
                "BAD_RANGE",
                format!("invalid range start '{start_raw}'"),
                None,
                true,
            )
        })?;
        let end = if end_raw.is_empty() {
            total_size - 1
        } else {
            u64::from_str(end_raw).map_err(|_| {
                api_error_with(
                    StatusCode::BAD_REQUEST,
                    "BAD_RANGE",
                    format!("invalid range end '{end_raw}'"),
                    None,
                    true,
                )
            })?
        };
        if start >= total_size || start > end {
            return Err(api_error_with(
                StatusCode::RANGE_NOT_SATISFIABLE,
                "RANGE_NOT_SATISFIABLE",
                format!("range {start}-{end} is outside object size {total_size}"),
                None,
                true,
            ));
        }
        (start, end.min(total_size - 1))
    };

    Ok((start, end, true))
}

fn read_objset_bytes(
    pool_ptr: *mut crate::ffi::zdx_pool_t,
    objset_id: u64,
    objid: u64,
    start: u64,
    end: u64,
) -> Result<Vec<u8>, ApiError> {
    if end < start {
        return Ok(Vec::new());
    }
    let total = end - start + 1;
    if total > ZPL_DOWNLOAD_MAX_BYTES {
        return Err(api_error_with(
            StatusCode::BAD_REQUEST,
            "DOWNLOAD_TOO_LARGE",
            format!(
                "requested byte range is {} bytes; max per request is {} bytes",
                total, ZPL_DOWNLOAD_MAX_BYTES
            ),
            Some("Use HTTP Range requests to download the file in chunks.".to_string()),
            true,
        ));
    }

    let mut out = Vec::with_capacity(total as usize);
    let mut offset = start;
    while offset <= end {
        let remaining = end - offset + 1;
        let chunk_size = remaining.min(OBJSET_DATA_MAX_LIMIT);
        let chunk_result =
            crate::ffi::objset_read_data(pool_ptr, objset_id, objid, offset, chunk_size);
        if !chunk_result.is_ok() {
            let err_msg = chunk_result.error_msg().unwrap_or("Unknown error");
            let status = if is_objset_user_input_error(err_msg) {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            return Err(api_error(
                status,
                format!("failed to read object data at offset {offset}: {err_msg}"),
            ));
        }

        let chunk_json = chunk_result.json().ok_or_else(|| {
            api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result")
        })?;
        let chunk_value = parse_json_value(chunk_json)?;
        let chunk = serde_json::from_value::<ObjsetDataPayload>(chunk_value).map_err(|err| {
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to parse object data payload: {err}"),
            )
        })?;

        let mut bytes = decode_hex_bytes(&chunk.data_hex)?;
        if bytes.is_empty() {
            break;
        }

        if (bytes.len() as u64) > remaining {
            bytes.truncate(remaining as usize);
        }

        let consumed = bytes.len() as u64;
        out.extend_from_slice(&bytes);
        if consumed == 0 {
            break;
        }
        offset = offset.saturating_add(consumed);
    }

    if out.len() as u64 != total {
        return Err(api_error_with(
            StatusCode::INTERNAL_SERVER_ERROR,
            "SHORT_READ",
            format!(
                "short read while exporting object data (expected {total} bytes, got {})",
                out.len()
            ),
            Some(
                "Try smaller range requests; the object may be sparse or partially unreadable."
                    .to_string(),
            ),
            false,
        ));
    }

    Ok(out)
}

fn sanitize_download_filename(raw: &str) -> String {
    let mut cleaned = raw.replace(['"', '\\', '/'], "_");
    if cleaned.is_empty() {
        cleaned = "download.bin".to_string();
    }
    cleaned
}

/// GET /api/pools/{pool}/zpl/path/{*zpl_path}
/// (supports single HTTP Range request)
pub async fn zpl_path_download(
    State(state): State<AppState>,
    Path((pool, zpl_path)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response<Body>, ApiError> {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let ctx = resolve_zpl_path_context(pool_ptr, &pool, &zpl_path)?;

    if ctx.file_size == 0 {
        let filename = sanitize_download_filename(&ctx.filename);
        let content_type = mime_guess::from_path(&filename)
            .first_or_octet_stream()
            .essence_str()
            .to_string();
        let mut response = Response::new(Body::from(Vec::<u8>::new()));
        *response.status_mut() = StatusCode::OK;
        response
            .headers_mut()
            .insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        response.headers_mut().insert(
            CONTENT_TYPE,
            HeaderValue::from_str(&content_type)
                .unwrap_or(HeaderValue::from_static("application/octet-stream")),
        );
        response
            .headers_mut()
            .insert(CONTENT_LENGTH, HeaderValue::from_static("0"));
        response.headers_mut().insert(
            CONTENT_DISPOSITION,
            HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
                .unwrap_or(HeaderValue::from_static("attachment")),
        );
        return Ok(response);
    }

    let (start, end, partial) = parse_range_header(&headers, ctx.file_size)?;
    let bytes = read_objset_bytes(pool_ptr, ctx.objset_id, ctx.objid, start, end)?;
    let filename = sanitize_download_filename(&ctx.filename);
    let content_type = mime_guess::from_path(&filename)
        .first_or_octet_stream()
        .essence_str()
        .to_string();

    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };

    response
        .headers_mut()
        .insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_str(&content_type)
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    response.headers_mut().insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&(end - start + 1).to_string())
            .unwrap_or(HeaderValue::from_static("0")),
    );
    response.headers_mut().insert(
        CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
            .unwrap_or(HeaderValue::from_static("attachment")),
    );
    response.headers_mut().insert(
        HeaderName::from_static("x-zfs-dataset"),
        HeaderValue::from_str(&ctx.dataset_name).unwrap_or(HeaderValue::from_static("unknown")),
    );
    response.headers_mut().insert(
        HeaderName::from_static("x-zfs-relpath"),
        HeaderValue::from_str(&ctx.rel_path).unwrap_or(HeaderValue::from_static("/")),
    );

    if partial {
        response.headers_mut().insert(
            CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{}", ctx.file_size))
                .unwrap_or(HeaderValue::from_static("bytes */0")),
        );
    }

    Ok(response)
}

#[derive(Debug, Deserialize)]
pub struct SpacemapRangesQuery {
    pub cursor: Option<u64>,
    pub limit: Option<u64>,
    pub op: Option<String>,
    pub min_length: Option<u64>,
    pub txg_min: Option<u64>,
    pub txg_max: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct SpacemapBinsQuery {
    pub bin_size: Option<u64>,
    pub cursor: Option<u64>,
    pub limit: Option<u64>,
    pub op: Option<String>,
    pub min_length: Option<u64>,
    pub txg_min: Option<u64>,
    pub txg_max: Option<u64>,
}

/// GET /api/pools/:pool/spacemap/:objid/summary
pub async fn spacemap_summary(
    State(state): State<AppState>,
    Path((pool, objid)): Path<(String, u64)>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::spacemap_summary(pool_ptr, objid);
    if !result.is_ok() {
        let err_msg = result.error_msg().unwrap_or("Unknown error");
        let status = if is_spacemap_user_input_error(err_msg) {
            StatusCode::BAD_REQUEST
        } else {
            tracing::error!("FFI error: {}", err_msg);
            StatusCode::INTERNAL_SERVER_ERROR
        };
        return Err(api_error(status, err_msg.to_string()));
    }

    let json_str = result
        .json()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result"))?;
    let value = parse_json_value(json_str)?;
    Ok(Json(value))
}

/// GET /api/pools/:pool/spacemap/:objid/ranges?cursor=&limit=&op=&min_length=&txg_min=&txg_max=
pub async fn spacemap_ranges(
    State(state): State<AppState>,
    Path((pool, objid)): Path<(String, u64)>,
    Query(params): Query<SpacemapRangesQuery>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let (cursor, limit) = normalize_spacemap_cursor_limit(params.cursor, params.limit);
    let op_filter = parse_spacemap_op_filter(params.op.as_deref())?;
    let min_length = params.min_length.unwrap_or(0);
    let txg_min = params.txg_min.unwrap_or(0);
    let txg_max = params.txg_max.unwrap_or(0);
    if txg_min != 0 && txg_max != 0 && txg_min > txg_max {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "txg_min must be <= txg_max",
        ));
    }

    let result = crate::ffi::spacemap_ranges(
        pool_ptr, objid, cursor, limit, op_filter, min_length, txg_min, txg_max,
    );
    if !result.is_ok() {
        let err_msg = result.error_msg().unwrap_or("Unknown error");
        let status = if is_spacemap_user_input_error(err_msg) {
            StatusCode::BAD_REQUEST
        } else {
            tracing::error!("FFI error: {}", err_msg);
            StatusCode::INTERNAL_SERVER_ERROR
        };
        return Err(api_error(status, err_msg.to_string()));
    }

    let json_str = result
        .json()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result"))?;
    let value = parse_json_value(json_str)?;
    Ok(Json(value))
}

/// GET /api/pools/:pool/spacemap/:objid/bins?bin_size=&cursor=&limit=&op=&min_length=&txg_min=&txg_max=
pub async fn spacemap_bins(
    State(state): State<AppState>,
    Path((pool, objid)): Path<(String, u64)>,
    Query(params): Query<SpacemapBinsQuery>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let bin_size = normalize_spacemap_bin_size(params.bin_size);
    let (cursor, limit) = normalize_spacemap_bins_cursor_limit(params.cursor, params.limit);
    let op_filter = parse_spacemap_op_filter(params.op.as_deref())?;
    let min_length = params.min_length.unwrap_or(0);
    let txg_min = params.txg_min.unwrap_or(0);
    let txg_max = params.txg_max.unwrap_or(0);
    if txg_min != 0 && txg_max != 0 && txg_min > txg_max {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "txg_min must be <= txg_max",
        ));
    }

    let result = crate::ffi::spacemap_bins(
        pool_ptr, objid, bin_size, cursor, limit, op_filter, min_length, txg_min, txg_max,
    );
    if !result.is_ok() {
        let err_msg = result.error_msg().unwrap_or("Unknown error");
        let status = if is_spacemap_user_input_error(err_msg) {
            StatusCode::BAD_REQUEST
        } else {
            tracing::error!("FFI error: {}", err_msg);
            StatusCode::INTERNAL_SERVER_ERROR
        };
        return Err(api_error(status, err_msg.to_string()));
    }

    let json_str = result
        .json()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result"))?;
    let value = parse_json_value(json_str)?;
    Ok(Json(value))
}

#[derive(Debug, Deserialize)]
pub struct GraphQuery {
    pub depth: Option<u8>,
    pub include: Option<String>,
}

/// GET /api/pools/:pool/graph/from/:objid
pub async fn graph_from(
    State(state): State<AppState>,
    Path((pool, objid)): Path<(String, u64)>,
    Query(params): Query<GraphQuery>,
) -> ApiResult {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let include = params
        .include
        .unwrap_or_else(|| "semantic,physical".to_string());
    let _depth = params.depth.unwrap_or(1);
    let (include_semantic, include_physical, include_zap) = parse_graph_include(Some(&include));

    let result = crate::ffi::obj_get(pool_ptr, objid);
    if !result.is_ok() {
        let err_msg = result.error_msg().unwrap_or("Unknown error");
        tracing::error!("FFI error: {}", err_msg);
        return Err(api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            err_msg.to_string(),
        ));
    }

    let json_str = result
        .json()
        .ok_or_else(|| api_error(StatusCode::INTERNAL_SERVER_ERROR, "Missing JSON in result"))?;
    let value = parse_json_value(json_str)?;

    let object = &value["object"];
    let source_obj = object["id"].as_u64().unwrap_or(objid);
    let source_type = object["type"]["id"].as_u64();
    let source_bonus = object["bonus_type"]["id"].as_u64();

    let mut nodes = Vec::new();
    let mut node_ids = HashSet::new();
    let mut add_node = |objid: u64, type_id: Option<u64>, bonus_id: Option<u64>| {
        if node_ids.insert(objid) {
            nodes.push(serde_json::json!({
                "objid": objid,
                "type": type_id,
                "bonus_type": bonus_id
            }));
        }
    };

    add_node(source_obj, source_type, source_bonus);

    let mut edges: Vec<Value> = Vec::new();

    if include_semantic {
        if let Some(edge_list) = object["semantic_edges"].as_array() {
            for edge in edge_list {
                if let Some(target) = edge["target_obj"].as_u64() {
                    add_node(target, None, None);
                }
                edges.push(edge.clone());
            }
        }
    }

    if include_zap {
        if let Some(entries) = value["zap_entries"]["entries"].as_array() {
            for entry in entries {
                let maybe_ref = entry["maybe_object_ref"].as_bool().unwrap_or(false);
                let target = entry["target_obj"].as_u64().unwrap_or(0);
                let name = entry["name"].as_str().unwrap_or("zap");
                if maybe_ref && target != 0 {
                    add_node(target, None, None);
                    edges.push(serde_json::json!({
                        "source_obj": source_obj,
                        "target_obj": target,
                        "label": name,
                        "kind": "zap",
                        "confidence": 0.7
                    }));
                }
            }
        }
    }

    if include_physical {
        if let Some(blkptrs) = value["blkptrs"]["blkptrs"].as_array() {
            for (idx, bp) in blkptrs.iter().enumerate() {
                let pseudo_id = (1u64 << 63) | (source_obj << 8) | (idx as u64);
                add_node(pseudo_id, None, None);

                edges.push(serde_json::json!({
                    "source_obj": source_obj,
                    "target_obj": pseudo_id,
                    "label": format!("blkptr {}", idx),
                    "kind": "blkptr",
                    "confidence": 1.0,
                    "notes": bp.get("dvas")
                }));
            }
        }
    }

    let response = serde_json::json!({
        "nodes": nodes,
        "edges": edges
    });

    Ok(Json(response))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_limit_uses_default_and_bounds() {
        assert_eq!(normalize_limit(None), DEFAULT_PAGE_LIMIT);
        assert_eq!(normalize_limit(Some(0)), 1);
        assert_eq!(normalize_limit(Some(17)), 17);
        assert_eq!(normalize_limit(Some(MAX_PAGE_LIMIT + 1)), MAX_PAGE_LIMIT);
    }

    #[test]
    fn normalize_cursor_limit_defaults_cursor_and_limit() {
        assert_eq!(normalize_cursor_limit(None, None), (0, DEFAULT_PAGE_LIMIT));
        assert_eq!(normalize_cursor_limit(Some(42), Some(64)), (42, 64));
    }

    #[test]
    fn normalize_spacemap_limit_uses_default_and_bounds() {
        assert_eq!(normalize_spacemap_limit(None), SPACEMAP_DEFAULT_LIMIT);
        assert_eq!(normalize_spacemap_limit(Some(0)), 1);
        assert_eq!(normalize_spacemap_limit(Some(17)), 17);
        assert_eq!(
            normalize_spacemap_limit(Some(SPACEMAP_MAX_LIMIT + 1)),
            SPACEMAP_MAX_LIMIT
        );
    }

    #[test]
    fn normalize_spacemap_bins_limit_uses_default_and_bounds() {
        assert_eq!(
            normalize_spacemap_bins_limit(None),
            SPACEMAP_BINS_DEFAULT_LIMIT
        );
        assert_eq!(normalize_spacemap_bins_limit(Some(0)), 1);
        assert_eq!(normalize_spacemap_bins_limit(Some(64)), 64);
        assert_eq!(
            normalize_spacemap_bins_limit(Some(SPACEMAP_BINS_MAX_LIMIT + 1)),
            SPACEMAP_BINS_MAX_LIMIT
        );
    }

    #[test]
    fn normalize_spacemap_bin_size_uses_default_and_bounds() {
        assert_eq!(
            normalize_spacemap_bin_size(None),
            SPACEMAP_BINS_DEFAULT_SIZE
        );
        assert_eq!(normalize_spacemap_bin_size(Some(1)), SPACEMAP_BINS_MIN_SIZE);
        assert_eq!(normalize_spacemap_bin_size(Some(4096)), 4096);
        assert_eq!(
            normalize_spacemap_bin_size(Some(SPACEMAP_BINS_MAX_SIZE + 1)),
            SPACEMAP_BINS_MAX_SIZE
        );
    }

    #[test]
    fn normalize_block_tree_depth_uses_default_and_bounds() {
        assert_eq!(normalize_block_tree_depth(None), BLOCK_TREE_DEFAULT_DEPTH);
        assert_eq!(normalize_block_tree_depth(Some(0)), 0);
        assert_eq!(
            normalize_block_tree_depth(Some(BLOCK_TREE_MAX_DEPTH + 3)),
            BLOCK_TREE_MAX_DEPTH
        );
    }

    #[test]
    fn normalize_block_tree_nodes_uses_default_and_bounds() {
        assert_eq!(normalize_block_tree_nodes(None), BLOCK_TREE_DEFAULT_NODES);
        assert_eq!(normalize_block_tree_nodes(Some(0)), 1);
        assert_eq!(normalize_block_tree_nodes(Some(77)), 77);
        assert_eq!(
            normalize_block_tree_nodes(Some(BLOCK_TREE_MAX_NODES + 1)),
            BLOCK_TREE_MAX_NODES
        );
    }

    #[test]
    fn parse_spacemap_op_filter_accepts_expected_values() {
        assert_eq!(parse_spacemap_op_filter(None).unwrap(), 0);
        assert_eq!(parse_spacemap_op_filter(Some("all")).unwrap(), 0);
        assert_eq!(parse_spacemap_op_filter(Some("alloc")).unwrap(), 1);
        assert_eq!(parse_spacemap_op_filter(Some("free")).unwrap(), 2);
    }

    #[test]
    fn parse_spacemap_op_filter_rejects_invalid_values() {
        let err = parse_spacemap_op_filter(Some("bogus")).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn parse_graph_include_handles_defaults_and_flags() {
        assert_eq!(parse_graph_include(None), (true, true, false));
        assert_eq!(
            parse_graph_include(Some("semantic,zap")),
            (true, false, true)
        );
        assert_eq!(parse_graph_include(Some("physical")), (false, true, false));
    }

    #[test]
    fn parse_json_value_maps_errors_to_http_500() {
        let err = parse_json_value("{bad json").unwrap_err();
        assert_eq!(err.0, StatusCode::INTERNAL_SERVER_ERROR);
        let msg = err
            .1
             .0
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert!(msg.starts_with("JSON parse error:"));
    }

    #[test]
    fn api_error_returns_json_envelope() {
        let err = api_error(StatusCode::BAD_REQUEST, "boom");
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1 .0["error"], "boom");
        assert_eq!(err.1 .0["message"], "boom");
        assert_eq!(err.1 .0["code"], "HTTP_400");
        assert_eq!(err.1 .0["recoverable"], true);
    }

    #[test]
    fn pool_open_error_code_maps_libzfs_names() {
        assert_eq!(pool_open_error_code(2009), "EZFS_NOENT");
        assert_eq!(pool_open_error_code(libc::EACCES), "ERRNO_13");
        assert_eq!(pool_open_error_code(-3), "ZDX_-3");
    }

    #[test]
    fn offline_pool_open_hint_is_user_friendly() {
        let noent = offline_pool_open_hint("tank", 2009).unwrap_or_default();
        assert!(noent.contains("offline search paths"));
        let perm = offline_pool_open_hint("tank", libc::EACCES).unwrap_or_default();
        assert!(perm.contains("Run the backend as root"));
        assert!(offline_pool_open_hint("tank", libc::EIO).is_none());
    }

    #[test]
    fn dataset_objset_response_shape_is_stable() {
        let payload = build_dataset_objset_response(
            32,
            54,
            &json!({
                "objset_id": 54,
                "rootbp": {
                    "ndvas": 2
                }
            }),
        );

        assert_eq!(payload["dsl_dir_obj"], 32);
        assert_eq!(payload["head_dataset_obj"], 54);
        assert_eq!(payload["objset_id"], 54);
        assert_eq!(payload["rootbp"]["ndvas"], 2);
    }

    #[test]
    fn zap_unreadable_error_detection_matches_invalid_exchange() {
        assert!(is_zap_unreadable_error(
            "zap_get_stats failed: Invalid exchange"
        ));
        assert!(is_zap_unreadable_error(
            "zap_cursor_retrieve failed: Invalid exchange"
        ));
        assert!(!is_zap_unreadable_error(
            "zap_get_stats failed: Invalid argument"
        ));
    }

    #[test]
    fn objset_error_maps_encrypted_zap_hint() {
        let err = api_error_for_objset("zap_get_stats failed: Invalid exchange");
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1 .0["code"], "ZAP_UNREADABLE");
        let hint = err
            .1
             .0
            .get("hint")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert!(hint.contains("encrypted dataset contents"));
    }

    #[test]
    fn spacemap_user_input_error_detection() {
        assert!(is_spacemap_user_input_error(
            "object 265 is type \"object array\" (11); expected \"space map\""
        ));
        assert!(is_spacemap_user_input_error(
            "object 265 bonus is too small for space map payload (bonus=0, need>=24)"
        ));
        assert!(is_spacemap_user_input_error(
            "failed to inspect spacemap object 999999: No such file or directory"
        ));
        assert!(!is_spacemap_user_input_error(
            "failed to iterate spacemap object 264"
        ));
    }

    #[test]
    fn parse_dsl_children_handles_missing_and_invalid_entries() {
        let payload = json!({
            "children": [
                { "name": "local", "dir_objid": 3 },
                { "name": "bad-zero", "dir_objid": 0 },
                { "name": "bad-type", "dir_objid": "oops" },
                { "dir_objid": 7 }
            ]
        });

        let parsed = parse_dsl_children(&payload);
        assert_eq!(
            parsed,
            vec![("local".to_string(), 3), ("dataset".to_string(), 7)]
        );
    }

    #[test]
    fn version_payload_includes_required_fields() {
        let payload = build_version_payload(&crate::PoolOpenConfig {
            mode: crate::PoolOpenMode::Live,
            offline_search_paths: None,
            offline_pool_names: Vec::new(),
        });
        assert_eq!(payload["project"], "zfs-explorer");
        assert_eq!(payload["backend"]["name"], BACKEND_NAME);
        assert_eq!(payload["backend"]["version"], BACKEND_VERSION);
        assert!(payload["backend"]["git_sha"].as_str().is_some());
        assert!(payload["openzfs"]["commit"].as_str().is_some());
        assert_eq!(payload["runtime"]["os"], std::env::consts::OS);
        assert_eq!(payload["runtime"]["arch"], std::env::consts::ARCH);
        assert_eq!(payload["pool_open"]["mode"], "live");
    }

    #[test]
    fn parse_pool_open_mode_accepts_expected_values() {
        assert!(matches!(
            parse_pool_open_mode("live"),
            Some(crate::PoolOpenMode::Live)
        ));
        assert!(matches!(
            parse_pool_open_mode("OFFLINE"),
            Some(crate::PoolOpenMode::Offline)
        ));
        assert!(parse_pool_open_mode("invalid").is_none());
    }

    #[test]
    fn mode_payload_shape_is_stable() {
        let payload = build_mode_payload(&crate::PoolOpenConfig {
            mode: crate::PoolOpenMode::Offline,
            offline_search_paths: Some("/tmp/fixtures".to_string()),
            offline_pool_names: vec!["tank".to_string(), "backup".to_string()],
        });

        assert_eq!(payload["mode"], "offline");
        assert_eq!(payload["offline_search_paths"], "/tmp/fixtures");
        assert_eq!(payload["offline_pools"][0], "tank");
        assert_eq!(payload["offline_pools"][1], "backup");
    }

    #[test]
    fn parse_dsl_children_returns_empty_for_missing_children() {
        let payload = json!({ "not_children": [] });
        let parsed = parse_dsl_children(&payload);
        assert!(parsed.is_empty());
    }

    #[test]
    fn parse_arcstats_skips_headers_and_parses_counters() {
        let sample = r#"
13 1 0x01 120 5760 123456 654321
name                            type data
hits                            4    100
misses                          4    25
c                               4    4096
c_min                           4    1024
c_max                           4    8192
"#;
        let counters = parse_arcstats(sample);
        assert_eq!(counters.get("hits"), Some(&100));
        assert_eq!(counters.get("misses"), Some(&25));
        assert_eq!(counters.get("c"), Some(&4096));
        assert!(!counters.contains_key("13"));
        assert!(!counters.contains_key("name"));
    }

    #[test]
    fn build_arc_payload_computes_ratios() {
        let mut counters = HashMap::new();
        counters.insert("hits".to_string(), 90);
        counters.insert("misses".to_string(), 10);
        counters.insert("demand_data_hits".to_string(), 45);
        counters.insert("demand_data_misses".to_string(), 5);
        counters.insert("demand_metadata_hits".to_string(), 18);
        counters.insert("demand_metadata_misses".to_string(), 2);
        counters.insert("prefetch_data_hits".to_string(), 27);
        counters.insert("prefetch_data_misses".to_string(), 3);
        counters.insert("prefetch_metadata_hits".to_string(), 0);
        counters.insert("prefetch_metadata_misses".to_string(), 0);
        counters.insert("l2_hits".to_string(), 12);
        counters.insert("l2_misses".to_string(), 3);

        let payload = build_arc_payload(&counters);
        assert_eq!(payload["arc"]["hits"], 90);
        assert_eq!(payload["arc"]["misses"], 10);
        assert_eq!(payload["l2arc"]["hits"], 12);
        assert_eq!(payload["l2arc"]["misses"], 3);
        assert_eq!(payload["ratios"]["arc_hit_ratio"], 0.9);
        assert_eq!(payload["ratios"]["demand_hit_ratio"], 0.9);
        assert_eq!(payload["ratios"]["prefetch_hit_ratio"], 0.9);
        assert_eq!(payload["ratios"]["l2arc_hit_ratio"], 0.8);
    }

    #[test]
    fn parse_vdev_iostat_output_parses_rows() {
        let sample = "tank\t100\t900\t1\t2\t4096\t8192\n mirror-0\t100\t900\t1\t2\t4096\t8192\n";
        let rows = parse_vdev_iostat_output(sample);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "tank");
        assert_eq!(rows[0].depth, 0);
        assert_eq!(rows[0].read_ops, Some(1));
        assert_eq!(rows[1].name, "mirror-0");
        assert_eq!(rows[1].depth, 1);
        assert_eq!(rows[1].write_bytes, Some(8192));
    }

    #[test]
    fn parse_iostat_counter_handles_dash_values() {
        assert_eq!(parse_iostat_counter("1234"), Some(1234));
        assert_eq!(parse_iostat_counter("-"), None);
        assert_eq!(parse_iostat_counter(""), None);
    }

    #[test]
    fn parse_range_header_supports_standard_and_suffix_forms() {
        let empty_headers = HeaderMap::new();
        let (start, end, partial) = parse_range_header(&empty_headers, 100).unwrap();
        assert_eq!((start, end, partial), (0, 99, false));

        let mut headers = HeaderMap::new();
        headers.insert(RANGE, HeaderValue::from_static("bytes=10-19"));
        let (start, end, partial) = parse_range_header(&headers, 100).unwrap();
        assert_eq!((start, end, partial), (10, 19, true));

        headers.insert(RANGE, HeaderValue::from_static("bytes=-20"));
        let (start, end, partial) = parse_range_header(&headers, 100).unwrap();
        assert_eq!((start, end, partial), (80, 99, true));
    }

    #[test]
    fn dataset_and_mountpoint_path_match_handles_prefixes() {
        assert_eq!(
            dataset_path_match("tank/data", "tank/data/file.bin"),
            Some("file.bin".to_string())
        );
        assert_eq!(
            mountpoint_path_match("/tank/data", "/tank/data/file.bin"),
            Some("file.bin".to_string())
        );
        assert_eq!(dataset_path_match("tank/data", "tank/other/file.bin"), None);
        assert_eq!(
            mountpoint_path_match("/tank/data", "/tank/other/file.bin"),
            None
        );
    }

    #[test]
    fn parse_txgs_rows_parses_headers_and_rows() {
        let sample = r#"
2 1 0x01 6 288 1234
txg birth state ndirty nread nwritten
42 1770590000 C 0 0 0
43 1770590001 O 4096 2 8192
"#;
        let (columns, rows) = parse_txgs_rows(sample);
        assert_eq!(
            columns,
            vec!["txg", "birth", "state", "ndirty", "nread", "nwritten"]
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["txg"], 42);
        assert_eq!(rows[0]["state"], "C");
        assert_eq!(rows[1]["ndirty"], 4096);
    }

    #[test]
    fn parse_zpool_space_summary_parses_core_fields() {
        let sample = "1099511627776\t549755813888\t549755813888\t23%\t1.14x\n";
        let parsed = parse_zpool_space_summary(sample);
        assert_eq!(
            parsed,
            Some((
                Some(1099511627776),
                Some(549755813888),
                Some(549755813888),
                Some(23.0),
                Some(1.14),
            ))
        );
    }

    #[test]
    fn parse_zfs_space_rows_handles_optional_values() {
        let sample = concat!(
            "tank\tfilesystem\t100\t200\t80\t150\t2.00x\n",
            "tank/vol\tvolume\t50\t-\t40\t-\t1.10x\n"
        );
        let rows = parse_zfs_space_rows(sample);
        assert_eq!(rows.len(), 2);

        assert_eq!(rows[0].name, "tank");
        assert_eq!(rows[0].kind, "filesystem");
        assert_eq!(rows[0].used_bytes, Some(100));
        assert_eq!(rows[0].logical_used_bytes, Some(200));
        assert_eq!(rows[0].compress_ratio, Some(2.0));
        assert_eq!(rows[0].logical_vs_physical_ratio, Some(2.0));
        assert_eq!(rows[0].physical_vs_logical_ratio, Some(0.5));
        assert_eq!(rows[0].physical_minus_logical_bytes, Some(-100));

        assert_eq!(rows[1].name, "tank/vol");
        assert_eq!(rows[1].logical_used_bytes, None);
        assert_eq!(rows[1].logical_vs_physical_ratio, None);
    }

    #[test]
    fn parse_ddt_summary_extracts_header_and_rows() {
        let sample = r#"
pool: tank
 dedup: DDT entries 123, size 4567 on disk, 890 in core

DDT histogram (aggregated over all DDTs):

refcnt blocks lsize psize dsize blocks lsize psize dsize
------ ------ ----- ----- ----- ------ ----- ----- -----
1      10     40960 40960 81920  10    40960 40960 81920
2      5      20480 10240 12288  10    40960 20480 24576
Total  15     61440 51200 94208  20    81920 61440 106496
"#;

        let summary = parse_ddt_summary(sample);
        assert_eq!(summary.entries, Some(123));
        assert_eq!(summary.size_on_disk, Some(4567));
        assert_eq!(summary.size_in_core, Some(890));
        assert_eq!(summary.classes.len(), 2);
        assert_eq!(summary.classes[0].refcount, 1);
        assert_eq!(summary.classes[1].refcount, 2);
        assert!(summary.totals.is_some());
        assert_eq!(summary.totals.as_ref().map(|row| row.blocks), Some(15));
        assert_eq!(
            summary.totals.as_ref().map(|row| row.referenced_blocks),
            Some(20)
        );
    }

    #[test]
    fn parse_scaled_u64_handles_binary_suffixes() {
        assert_eq!(parse_scaled_u64("64"), Some(64));
        assert_eq!(parse_scaled_u64("8M"), Some(8 * 1024 * 1024));
        assert_eq!(parse_scaled_u64("60KiB"), Some(60 * 1024));
        assert_eq!(parse_scaled_u64("64KB"), Some(64 * 1024));
        assert_eq!(parse_scaled_u64("1.88K"), Some(1925));
        assert_eq!(parse_scaled_u64("-"), None);
        assert_eq!(parse_scaled_u64("n/a"), None);
    }

    #[test]
    fn parse_ddt_summary_parses_humanized_rows() {
        let sample = r#"
 dedup: DDT entries 64, size 61440 on disk, 65536 in core

bucket              allocated                       referenced
______   ______________________________   ______________________________
refcnt   blocks   LSIZE   PSIZE   DSIZE   blocks   LSIZE   PSIZE   DSIZE
------   ------   -----   -----   -----   ------   -----   -----   -----
    16       64      8M      8M      8M    1.88K    240M    240M    240M
 Total       64      8M      8M      8M    1.88K    240M    240M    240M
"#;

        let summary = parse_ddt_summary(sample);
        assert_eq!(summary.entries, Some(64));
        assert_eq!(summary.size_on_disk, Some(61440));
        assert_eq!(summary.size_in_core, Some(65536));
        assert_eq!(summary.classes.len(), 1);
        assert_eq!(summary.classes[0].refcount, 16);
        assert_eq!(summary.classes[0].blocks, 64);
        assert_eq!(summary.classes[0].lsize, 8 * 1024 * 1024);
        assert_eq!(summary.classes[0].referenced_blocks, 1925);
        assert_eq!(
            summary.totals.as_ref().map(|row| row.referenced_dsize),
            Some(240 * 1024 * 1024)
        );
    }
}
