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
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stop_rx.await;
            })
            .await
    });

    // Wait for a termination signal, drain in-flight HTTP requests first, and
    // only then flush and shut down the telemetry SDK so spans, logs, and
    // metrics from drained requests are exported.
    shutdown_signal().await;
    let _ = stop_tx.send(());
    let serve_result = server.await?;
    let shutdown_result = sdk.shutdown_async().await;
    serve_result?;
    shutdown_result?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sigterm) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sigterm.recv().await;
        } else {
            std::future::pending::<()>().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
}
