//! Hermetic test harness for asserting the telemetry a Rust service emits
//! through [`libo11y`]: spans, metrics (with exemplars), and structured log
//! records, plus conformance, correlation, and correlation-triangle checks and
//! in-process OTLP HTTP and gRPC receivers.
//!
//! [`Recorder::start`] builds a fully in-memory [`libo11y::Sdk`] with
//! [`libo11y::Builder::without_otel_env`]: no process globals are touched, no
//! exporter dials out, and no ambient `OTEL_*` variable affects behavior, so
//! harnesses are deterministic and safe under parallel tests.
//!
//! ```
//! use libo11y_test::Recorder;
//!
//! let rec = Recorder::start("checkout");
//! rec.in_scope(|| {
//!     let _span = tracing::info_span!("checkout.place").entered();
//!     tracing::info!(order.id = "ord-1", "order placed");
//!     rec.sdk()
//!         .meter("checkout")
//!         .u64_counter("orders.placed")
//!         .build()
//!         .add(1, &[]);
//! });
//!
//! rec.assert_conforms();
//! rec.assert_correlated();
//! rec.assert_triangle("orders.placed");
//! ```

mod conformance;
pub mod otlp_receiver;
mod recorder;

pub use conformance::check_event;
pub use otlp_receiver::{OtlpGrpcReceiver, OtlpHttpReceiver};
pub use recorder::{CapturedLog, RecordedExemplar, Recorder};
