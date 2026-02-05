use axum::{http::StatusCode, Json};
use serde_json::Value;

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
