mod ffi;
mod api;

use axum::{routing::get, Router};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tower_http::cors::CorsLayer;
use tracing_subscriber;

#[derive(Clone)]
pub struct AppState {
    pub pool: Arc<Mutex<Option<ffi::PoolHandle>>>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing with INFO level by default
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"))
        )
        .init();

    // Initialize ZFS
    tracing::info!("Initializing ZFS library...");
    ffi::init()?;

    let version = ffi::version();
    tracing::info!("ZFS Explorer starting (OpenZFS {})", version);

    let state = AppState {
        pool: Arc::new(Mutex::new(None)),
    };

    // Build the router
    let app = Router::new()
        .route("/api/pools", get(api::list_pools))
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
        .route("/api/pools/{pool}/dataset/{objid}/head", get(api::dataset_head))
        .route("/api/pools/{pool}/dataset/{objid}/objset", get(api::dataset_objset))
        .route("/api/pools/{pool}/objset/{objset_id}/root", get(api::objset_root))
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
