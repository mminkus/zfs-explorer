use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;

use crate::AppState;

const DEFAULT_PAGE_LIMIT: u64 = 200;
const MAX_PAGE_LIMIT: u64 = 10_000;
const SPACEMAP_DEFAULT_LIMIT: u64 = 200;
const SPACEMAP_MAX_LIMIT: u64 = 2_000;
const BACKEND_NAME: &str = env!("CARGO_PKG_NAME");
const BACKEND_VERSION: &str = env!("CARGO_PKG_VERSION");
const BUILD_GIT_SHA: &str = match option_env!("ZFS_EXPLORER_GIT_SHA") {
    Some(v) => v,
    None => "unknown",
};
type ApiError = (StatusCode, Json<Value>);
type ApiResult = Result<Json<Value>, ApiError>;

fn api_error(status: StatusCode, message: impl Into<String>) -> ApiError {
    (status, Json(json!({ "error": message.into() })))
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

/// GET /api/version - Build/runtime info for support bundles
pub async fn api_version(State(state): State<AppState>) -> ApiResult {
    let config = pool_open_config(&state);
    Ok(Json(build_version_payload(&config)))
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
    .map_err(|(_code, msg)| {
        tracing::error!("Failed to open pool {} (mode={}): {}", pool, mode_name, msg);
        api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("pool open failed ({mode_name}): {msg}"),
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

#[derive(Debug, Deserialize)]
pub struct SpacemapRangesQuery {
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
}
