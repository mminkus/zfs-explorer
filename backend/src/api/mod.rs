use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;

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
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool_ptr = ensure_pool(&state, &pool)?;

    if params.asize == 0 {
        return Err((StatusCode::BAD_REQUEST, "asize must be > 0".to_string()));
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
        return Err((StatusCode::INTERNAL_SERVER_ERROR, err_msg.to_string()));
    }

    let json_str = result.json().ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "Missing JSON in result".to_string(),
    ))?;

    let mut value: Value = serde_json::from_str(json_str).map_err(|e| {
        tracing::error!("Failed to parse JSON: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("JSON parse error: {}", e),
        )
    })?;

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
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let max_depth = params.depth.unwrap_or(4);
    let limit = params.limit.unwrap_or(500);

    let root_result = crate::ffi::dsl_root_dir(pool_ptr);
    if !root_result.is_ok() {
        let err_msg = root_result.error_msg().unwrap_or("Unknown error");
        tracing::error!("FFI error: {}", err_msg);
        return Err((StatusCode::INTERNAL_SERVER_ERROR, err_msg.to_string()));
    }

    let root_json = root_result.json().ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "Missing JSON in result".to_string(),
    ))?;

    let root_value: Value = serde_json::from_str(root_json).map_err(|e| {
        tracing::error!("Failed to parse JSON: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("JSON parse error: {}", e),
        )
    })?;

    let root_dir = root_value["root_dir_obj"].as_u64().ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "root_dir_obj missing".to_string(),
    ))?;

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
    ) -> Result<Value, (StatusCode, String)> {
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
            return Err((StatusCode::INTERNAL_SERVER_ERROR, err_msg.to_string()));
        }
        let head_json = head_result.json().ok_or((
            StatusCode::INTERNAL_SERVER_ERROR,
            "Missing JSON in head result".to_string(),
        ))?;
        let head_value: Value = serde_json::from_str(head_json).map_err(|e| {
            tracing::error!("Failed to parse JSON: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("JSON parse error: {}", e),
            )
        })?;
        let head_dataset_obj = head_value["head_dataset_obj"].as_u64();

        let children_result = crate::ffi::dsl_dir_children(pool_ptr, objid);
        if !children_result.is_ok() {
            let err_msg = children_result.error_msg().unwrap_or("Unknown error");
            tracing::error!("FFI error: {}", err_msg);
            return Err((StatusCode::INTERNAL_SERVER_ERROR, err_msg.to_string()));
        }
        let children_json = children_result.json().ok_or((
            StatusCode::INTERNAL_SERVER_ERROR,
            "Missing JSON in children result".to_string(),
        ))?;
        let children_value: Value = serde_json::from_str(children_json).map_err(|e| {
            tracing::error!("Failed to parse JSON: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("JSON parse error: {}", e),
            )
        })?;
        let child_dir_zapobj = children_value["child_dir_zapobj"].as_u64();

        let mut children_nodes: Vec<Value> = Vec::new();
        if depth > 0 {
            if let Some(children) = children_value["children"].as_array() {
                for child in children {
                    let child_name = child["name"].as_str().unwrap_or("dataset").to_string();
                    let child_objid = child["dir_objid"].as_u64().unwrap_or(0);
                    if child_objid == 0 {
                        continue;
                    }
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
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool_ptr = ensure_pool(&state, &pool)?;

    let head_result = crate::ffi::dsl_dir_head(pool_ptr, dir_obj);
    if !head_result.is_ok() {
        let err_msg = head_result.error_msg().unwrap_or("Unknown error");
        tracing::error!("FFI error: {}", err_msg);
        return Err((StatusCode::INTERNAL_SERVER_ERROR, err_msg.to_string()));
    }

    let head_json = head_result.json().ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "Missing JSON in head result".to_string(),
    ))?;
    let head_value: Value = serde_json::from_str(head_json).map_err(|e| {
        tracing::error!("Failed to parse JSON: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("JSON parse error: {}", e),
        )
    })?;

    let head_obj = head_value["head_dataset_obj"].as_u64().unwrap_or(0);
    if head_obj == 0 {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "head_dataset_obj missing".to_string(),
        ));
    }

    let objset_result = crate::ffi::dataset_objset(pool_ptr, head_obj);
    if !objset_result.is_ok() {
        let err_msg = objset_result.error_msg().unwrap_or("Unknown error");
        tracing::error!("FFI error: {}", err_msg);
        return Err((StatusCode::INTERNAL_SERVER_ERROR, err_msg.to_string()));
    }

    let objset_json = objset_result.json().ok_or((
        StatusCode::INTERNAL_SERVER_ERROR,
        "Missing JSON in objset result".to_string(),
    ))?;
    let objset_value: Value = serde_json::from_str(objset_json).map_err(|e| {
        tracing::error!("Failed to parse JSON: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("JSON parse error: {}", e),
        )
    })?;

    let response = serde_json::json!({
        "dsl_dir_obj": dir_obj,
        "head_dataset_obj": head_obj,
        "objset_id": objset_value["objset_id"],
        "rootbp": objset_value["rootbp"]
    });

    Ok(Json(response))
}

/// GET /api/pools/:pool/objset/:objset_id/root
pub async fn objset_root(
    State(state): State<AppState>,
    Path((pool, objset_id)): Path<(String, u64)>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool_ptr = ensure_pool(&state, &pool)?;

    let result = crate::ffi::objset_root(pool_ptr, objset_id);
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
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let cursor = params.cursor.unwrap_or(0);
    let limit = params.limit.unwrap_or(200);
    let result = crate::ffi::objset_dir_entries(pool_ptr, objset_id, dir_obj, cursor, limit);
    json_from_result(result)
}

/// GET /api/pools/:pool/objset/:objset_id/walk?path=/a/b/c
pub async fn objset_walk(
    State(state): State<AppState>,
    Path((pool, objset_id)): Path<(String, u64)>,
    Query(params): Query<WalkQuery>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let path = params.path.unwrap_or_else(|| "/".to_string());
    let result = crate::ffi::objset_walk(pool_ptr, objset_id, &path)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    json_from_result(result)
}

/// GET /api/pools/:pool/objset/:objset_id/stat/:objid
pub async fn objset_stat(
    State(state): State<AppState>,
    Path((pool, objset_id, objid)): Path<(String, u64, u64)>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let pool_ptr = ensure_pool(&state, &pool)?;
    let result = crate::ffi::objset_stat(pool_ptr, objset_id, objid);
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
    let include_zap = include.contains("zap");

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
