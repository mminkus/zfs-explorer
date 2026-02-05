mod ffi;
mod api;

use axum::{routing::get, Router};
use std::net::SocketAddr;
use tower_http::cors::CorsLayer;
use tracing_subscriber;

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

    // Build the router
    let app = Router::new()
        .route("/api/pools", get(api::list_pools))
        .layer(CorsLayer::permissive());

    // Bind to localhost only (per security model in plan)
    let addr = SocketAddr::from(([127, 0, 0, 1], 9000));
    tracing::info!("API server listening on {}", addr);

    // Start the server
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
