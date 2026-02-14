mod api;
mod ffi;

use axum::{routing::get, Router};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tower_http::cors::CorsLayer;
use tracing_subscriber;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PoolOpenMode {
    Live,
    Offline,
}

#[derive(Clone, Debug)]
pub struct PoolOpenConfig {
    pub mode: PoolOpenMode,
    pub offline_search_paths: Option<String>,
    pub offline_pool_names: Vec<String>,
}

#[derive(Clone)]
pub struct AppState {
    pub pool: Arc<Mutex<Option<ffi::PoolHandle>>>,
    pub pool_open: Arc<Mutex<PoolOpenConfig>>,
}

fn parse_pool_open_mode() -> Result<PoolOpenMode, String> {
    let raw = std::env::var("ZFS_EXPLORER_POOL_MODE").unwrap_or_else(|_| "live".to_string());
    match raw.to_ascii_lowercase().as_str() {
        "live" => Ok(PoolOpenMode::Live),
        "offline" => Ok(PoolOpenMode::Offline),
        other => Err(format!(
            "invalid ZFS_EXPLORER_POOL_MODE '{}'; expected 'live' or 'offline'",
            other
        )),
    }
}

fn parse_offline_pool_names() -> Vec<String> {
    std::env::var("ZFS_EXPLORER_OFFLINE_POOLS")
        .ok()
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing with INFO level by default
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    // Initialize ZFS
    tracing::info!("Initializing ZFS library...");
    ffi::init()?;

    let version = ffi::version();
    tracing::info!("ZFS Explorer starting (OpenZFS {})", version);

    let mode = parse_pool_open_mode()?;
    let offline_search_paths = std::env::var("ZFS_EXPLORER_OFFLINE_PATHS")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let offline_pool_names = parse_offline_pool_names();

    match mode {
        PoolOpenMode::Live => {
            tracing::info!("Pool open mode: live (imported pools)");
            if offline_search_paths.is_some() {
                tracing::warn!("ZFS_EXPLORER_OFFLINE_PATHS is set but ignored in live mode");
            }
        }
        PoolOpenMode::Offline => {
            tracing::info!("Pool open mode: offline (exported pools)");
            if let Some(paths) = offline_search_paths.as_deref() {
                tracing::info!("Offline search paths: {}", paths);
            } else {
                tracing::info!("Offline search paths: OpenZFS defaults");
            }
            if offline_pool_names.is_empty() {
                tracing::warn!(
                    "ZFS_EXPLORER_OFFLINE_POOLS is empty; /api/pools will only show imported pools"
                );
            } else {
                tracing::info!("Offline pool names: {}", offline_pool_names.join(", "));
            }
        }
    }

    let state = AppState {
        pool: Arc::new(Mutex::new(None)),
        pool_open: Arc::new(Mutex::new(PoolOpenConfig {
            mode,
            offline_search_paths,
            offline_pool_names,
        })),
    };

    // Build the router
    let app = Router::new()
        .route("/api/version", get(api::api_version))
        .route("/api/mode", get(api::get_mode).put(api::set_mode))
        .route("/api/pools", get(api::list_pools))
        .route("/api/pools/{pool}/summary", get(api::pool_summary))
        .route("/api/pools/{pool}/errors", get(api::pool_errors))
        .route("/api/pools/{pool}/datasets", get(api::list_pool_datasets))
        .route("/api/pools/{pool}/mos/objects", get(api::mos_list_objects))
        .route("/api/pools/{pool}/obj/{objid}", get(api::mos_get_object))
        .route("/api/pools/{pool}/obj/{objid}/full", get(api::obj_get_full))
        .route(
            "/api/pools/{pool}/obj/{objid}/blkptrs",
            get(api::mos_get_blkptrs),
        )
        .route("/api/pools/{pool}/obj/{objid}/zap/info", get(api::zap_info))
        .route("/api/pools/{pool}/obj/{objid}/zap", get(api::zap_entries))
        .route(
            "/api/pools/{pool}/dsl/dir/{objid}/children",
            get(api::dsl_dir_children),
        )
        .route(
            "/api/pools/{pool}/dsl/dir/{objid}/head",
            get(api::dsl_dir_head),
        )
        .route("/api/pools/{pool}/dsl/root", get(api::dsl_root_dir))
        .route("/api/pools/{pool}/datasets/tree", get(api::dataset_tree))
        .route(
            "/api/pools/{pool}/dataset/{objid}/head",
            get(api::dataset_head),
        )
        .route(
            "/api/pools/{pool}/dataset/{objid}/objset",
            get(api::dataset_objset),
        )
        .route(
            "/api/pools/{pool}/dataset/{objid}/snapshots",
            get(api::dataset_snapshots),
        )
        .route(
            "/api/pools/{pool}/dataset/{objid}/snapshot-count",
            get(api::dataset_snapshot_count),
        )
        .route(
            "/api/pools/{pool}/snapshot/{dsobj}/objset",
            get(api::snapshot_objset),
        )
        .route(
            "/api/pools/{pool}/snapshot/{dsobj}/lineage",
            get(api::snapshot_lineage),
        )
        .route(
            "/api/pools/{pool}/objset/{objset_id}/root",
            get(api::objset_root),
        )
        .route(
            "/api/pools/{pool}/objset/{objset_id}/objects",
            get(api::objset_list_objects),
        )
        .route(
            "/api/pools/{pool}/objset/{objset_id}/dir/{dir_obj}/entries",
            get(api::objset_dir_entries),
        )
        .route(
            "/api/pools/{pool}/objset/{objset_id}/walk",
            get(api::objset_walk),
        )
        .route(
            "/api/pools/{pool}/objset/{objset_id}/stat/{objid}",
            get(api::objset_stat),
        )
        .route(
            "/api/pools/{pool}/objset/{objset_id}/obj/{objid}",
            get(api::objset_get_object),
        )
        .route(
            "/api/pools/{pool}/objset/{objset_id}/obj/{objid}/blkptrs",
            get(api::objset_get_blkptrs),
        )
        .route(
            "/api/pools/{pool}/objset/{objset_id}/obj/{objid}/zap/info",
            get(api::objset_zap_info),
        )
        .route(
            "/api/pools/{pool}/objset/{objset_id}/obj/{objid}/zap",
            get(api::objset_zap_entries),
        )
        .route(
            "/api/pools/{pool}/objset/{objset_id}/obj/{objid}/full",
            get(api::objset_get_full),
        )
        .route(
            "/api/pools/{pool}/objset/{objset_id}/obj/{objid}/data",
            get(api::objset_read_data),
        )
        .route(
            "/api/pools/{pool}/spacemap/{objid}/summary",
            get(api::spacemap_summary),
        )
        .route(
            "/api/pools/{pool}/spacemap/{objid}/ranges",
            get(api::spacemap_ranges),
        )
        .route(
            "/api/pools/{pool}/spacemap/{objid}/bins",
            get(api::spacemap_bins),
        )
        .route("/api/pools/{pool}/block", get(api::read_block))
        .route("/api/pools/{pool}/graph/from/{objid}", get(api::graph_from))
        .route("/api/mos/types", get(api::list_dmu_types))
        .with_state(state)
        .layer(CorsLayer::permissive());

    // Bind to localhost only (per security model in plan)
    let addr = SocketAddr::from(([127, 0, 0, 1], 9000));
    tracing::info!("API server listening on {}", addr);

    // Start the server
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
