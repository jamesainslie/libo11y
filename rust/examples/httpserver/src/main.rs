//! Runnable HTTP server demonstrating `libo11y` setup and graceful shutdown.
//!
//! Run with a deployment environment and optional collector:
//!
//! ```sh
//! OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=development \
//!   OTEL_TRACES_EXPORTER=none OTEL_METRICS_EXPORTER=none OTEL_LOGS_EXPORTER=none \
//!   cargo run -p httpserver-example
//! ```

use std::error::Error;
use std::net::SocketAddr;

use libo11y::Sdk;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let registry = httpserver_example::load_registry()?;
    let sdk = Sdk::builder()
        .service_name("httpserver-example")
        .build_info(libo11y::build_info!())
        .app_registry(registry)
        .setup()?;

    let addr: SocketAddr = std::env::var("ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8080".to_owned())
        .parse()?;
    let listener = TcpListener::bind(addr).await?;
    tracing::info!(addr = %listener.local_addr()?, "listening");

    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let router = httpserver_example::app(&sdk);
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stop_rx.await;
            })
            .await;
    });

    #[cfg(unix)]
    let shutdown_res = sdk.shutdown_on_signals().await;
    #[cfg(not(unix))]
    let shutdown_res = sdk.shutdown_async().await;

    let _ = stop_tx.send(());
    let _ = server.await;
    shutdown_res?;
    Ok(())
}
