use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::Value;

use crate::AppState;

/// GET /api/pools - List all imported pools
pub async fn list_pools() -> Result<Json<Value>, (StatusCode, String)> {
    let result = crate::ffi::list_pools();

    if !result.is_ok() {
        let err_msg = result.error_msg().unwrap_or("Unknown error");
        tracing::error!("Failed to list pools: {}", err_msg);
        return Err((StatusCode::INTERNAL_SERVER_ERROR, err_msg.to_string()));
    }

    let json_str = result.json().ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "Missing JSON in result".to_string(),
    ))?;

    let value: Value = serde_json::from_str(json_str).map_err(|e| {
        tracing::error!("Failed to parse JSON: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("JSON parse error: {}", e),
        )
    })?;

    Ok(Json(value))
}

#[derive(Debug, Deserialize)]
pub struct MosListQuery {
    #[serde(rename = "type")]
    pub type_filter: Option<i32>,
    pub start: Option<u64>,
    pub limit: Option<u64>,
}

fn json_from_result(result: crate::ffi::ZdxResult) -> Result<Json<Value>, (StatusCode, String)> {
    if !result.is_ok() {
        let err_msg = result.error_msg().unwrap_or("Unknown error");
        tracing::error!("FFI error: {}", err_msg);
        return Err((StatusCode::INTERNAL_SERVER_ERROR, err_msg.to_string()));
    }

    let json_str = result.json().ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "Missing JSON in result".to_string(),
    ))?;

    let value: Value = serde_json::from_str(json_str).map_err(|e| {
        tracing::error!("Failed to parse JSON: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("JSON parse error: {}", e),
        )
    })?;

    Ok(Json(value))
}

fn ensure_pool(
    state: &AppState,
    pool: &str,
) -> Result<*mut crate::ffi::zdx_pool_t, (StatusCode, String)> {
    let mut guard = state.pool.lock().unwrap();

    if let Some(existing) = guard.as_ref() {
        if existing.name == pool {
            return Ok(existing.ptr);
        }
    }

    if let Some(old) = guard.take() {
        crate::ffi::pool_close(old.ptr);
    }

    let handle = crate::ffi::pool_open(pool).map_err(|(_code, msg)| {
        tracing::error!("Failed to open pool {}: {}", pool, msg);
        (StatusCode::INTERNAL_SERVER_ERROR, msg)
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
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool_ptr = ensure_pool(&state, &pool)?;

    let type_filter = params.type_filter.unwrap_or(-1);
    let start = params.start.unwrap_or(0);
    let limit = params.limit.unwrap_or(200);

    let result = crate::ffi::mos_list_objects(pool_ptr, type_filter, start, limit);
    json_from_result(result)
}

/// GET /api/pools/:pool/obj/:objid
pub async fn mos_get_object(
    State(state): State<AppState>,
    Path((pool, objid)): Path<(String, u64)>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::mos_get_object(pool_ptr, objid);
    json_from_result(result)
}

/// GET /api/pools/:pool/obj/:objid/blkptrs
pub async fn mos_get_blkptrs(
    State(state): State<AppState>,
    Path((pool, objid)): Path<(String, u64)>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::mos_get_blkptrs(pool_ptr, objid);
    json_from_result(result)
}

/// GET /api/pools/:pool/obj/:objid/full
pub async fn obj_get_full(
    State(state): State<AppState>,
    Path((pool, objid)): Path<(String, u64)>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::obj_get(pool_ptr, objid);
    json_from_result(result)
}

/// GET /api/mos/types
pub async fn list_dmu_types() -> Result<Json<Value>, (StatusCode, String)> {
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
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::zap_info(pool_ptr, objid);
    json_from_result(result)
}

/// GET /api/pools/:pool/obj/:objid/zap
pub async fn zap_entries(
    State(state): State<AppState>,
    Path((pool, objid)): Path<(String, u64)>,
    Query(params): Query<ZapEntriesQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let cursor = params.cursor.unwrap_or(0);
    let limit = params.limit.unwrap_or(200);
    let result = crate::ffi::zap_entries(pool_ptr, objid, cursor, limit);
    json_from_result(result)
}

/// GET /api/pools/:pool/dsl/dir/:objid/children
pub async fn dsl_dir_children(
    State(state): State<AppState>,
    Path((pool, objid)): Path<(String, u64)>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::dsl_dir_children(pool_ptr, objid);
    json_from_result(result)
}

/// GET /api/pools/:pool/dsl/dir/:objid/head
pub async fn dsl_dir_head(
    State(state): State<AppState>,
    Path((pool, objid)): Path<(String, u64)>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::dsl_dir_head(pool_ptr, objid);
    json_from_result(result)
}

/// GET /api/pools/:pool/dsl/root
pub async fn dsl_root_dir(
    State(state): State<AppState>,
    Path(pool): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::dsl_root_dir(pool_ptr);
    json_from_result(result)
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
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let include = params.include.unwrap_or_else(|| "semantic,physical".to_string());
    let _depth = params.depth.unwrap_or(1);
    let include_semantic = include.contains("semantic");
    let include_physical = include.contains("physical");

    let result = crate::ffi::obj_get(pool_ptr, objid);
    if !result.is_ok() {
        let err_msg = result.error_msg().unwrap_or("Unknown error");
        tracing::error!("FFI error: {}", err_msg);
        return Err((StatusCode::INTERNAL_SERVER_ERROR, err_msg.to_string()));
    }

    let json_str = result.json().ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "Missing JSON in result".to_string(),
    ))?;

    let value: Value = serde_json::from_str(json_str).map_err(|e| {
        tracing::error!("Failed to parse JSON: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("JSON parse error: {}", e),
        )
    })?;

    let object = &value["object"];
    let source_obj = object["id"].as_u64().unwrap_or(objid);
    let source_type = object["type"]["id"].as_u64();
    let source_bonus = object["bonus_type"]["id"].as_u64();

    let mut nodes = vec![serde_json::json!({
        "objid": source_obj,
        "type": source_type,
        "bonus_type": source_bonus
    })];

    let mut edges: Vec<Value> = Vec::new();

    if include_semantic {
        if let Some(edge_list) = object["semantic_edges"].as_array() {
            for edge in edge_list {
                if let Some(target) = edge["target_obj"].as_u64() {
                    nodes.push(serde_json::json!({
                        "objid": target,
                        "type": null,
                        "bonus_type": null
                    }));
                }
                edges.push(edge.clone());
            }
        }
    }

    if include_physical {
        if let Some(blkptrs) = value["blkptrs"]["blkptrs"].as_array() {
            for (idx, bp) in blkptrs.iter().enumerate() {
                let pseudo_id = (1u64 << 63) | (source_obj << 8) | (idx as u64);
                nodes.push(serde_json::json!({
                    "objid": pseudo_id,
                    "type": null,
                    "bonus_type": null
                }));

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
