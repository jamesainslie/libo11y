//! Telemetry configuration, semconv attributes, and span/metric recording for
//! `libo11y-sqlx`.

use std::sync::Arc;
use std::time::{Instant, SystemTime};

use libo11y::Sdk;
use libo11y::opentelemetry_sdk::trace::SdkTracer;
use opentelemetry::metrics::{Histogram, MeterProvider as _};
use opentelemetry::trace::{
    Span as _, SpanBuilder, SpanKind, Status, TraceContextExt as _, Tracer as _,
    TracerProvider as _,
};
use opentelemetry::{Context, InstrumentationScope, KeyValue};

use crate::sqltext::{Dialect, MAX_QUERY_TEXT, sanitize, summarize, truncate_utf8};

/// Instrumentation scope name for telemetry emitted by `libo11y-sqlx`.
pub(crate) const SCOPE_NAME: &str = "libo11y-sqlx";

/// Default `db.system.name` when the database system is not known.
pub const OTHER_SQL: &str = "other_sql";

/// Explicit histogram bucket boundaries advised by OpenTelemetry database
/// semantic conventions (1.41.0) for `db.client.operation.duration`, in
/// seconds.
pub const DURATION_BUCKETS: [f64; 9] = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 10.0];

// OpenTelemetry database semantic convention 1.41.0 attribute & metric names.
pub(crate) const ATTR_DB_SYSTEM_NAME: &str = "db.system.name";
pub(crate) const ATTR_DB_NAMESPACE: &str = "db.namespace";
pub(crate) const ATTR_DB_OPERATION_NAME: &str = "db.operation.name";
pub(crate) const ATTR_DB_COLLECTION_NAME: &str = "db.collection.name";
pub(crate) const ATTR_DB_QUERY_TEXT: &str = "db.query.text";
pub(crate) const ATTR_DB_RESPONSE_STATUS_CODE: &str = "db.response.status_code";
pub(crate) const ATTR_ERROR_TYPE: &str = "error.type";
pub(crate) const ATTR_SERVER_ADDRESS: &str = "server.address";
pub(crate) const ATTR_SERVER_PORT: &str = "server.port";
pub(crate) const ATTR_POOL_NAME: &str = "db.client.connection.pool.name";
pub(crate) const ATTR_CONNECTION_STATE: &str = "db.client.connection.state";

pub(crate) const METRIC_OPERATION_DURATION: &str = "db.client.operation.duration";
pub(crate) const METRIC_CONNECTION_COUNT: &str = "db.client.connection.count";
pub(crate) const METRIC_CONNECTION_MAX: &str = "db.client.connection.max";

pub(crate) fn scope() -> InstrumentationScope {
    InstrumentationScope::builder(SCOPE_NAME)
        .with_version(env!("CARGO_PKG_VERSION"))
        .build()
}

/// Associates a `sqlx::Database` type with its OpenTelemetry semantic
/// convention `db.system.name`.
pub trait KnownDatabase: sqlx::Database {
    /// Semantic convention `db.system.name` value for this database.
    const DB_SYSTEM: &'static str;
}

#[cfg(feature = "sqlite")]
impl KnownDatabase for sqlx::Sqlite {
    const DB_SYSTEM: &'static str = "sqlite";
}

#[cfg(feature = "postgres")]
impl KnownDatabase for sqlx::Postgres {
    const DB_SYSTEM: &'static str = "postgresql";
}

#[cfg(feature = "mysql")]
impl KnownDatabase for sqlx::MySql {
    const DB_SYSTEM: &'static str = "mysql";
}

/// Configuration for [`O11yPool`](crate::O11yPool) instrumentation.
///
/// Build one with [`DbConfig::new`] or [`DbConfig::for_database`] and the
/// `with_*` and `without_*` setters. The fields are private so every value
/// passes through the setters' normalization:
///
/// ```compile_fail,E0616
/// let mut cfg = libo11y_sqlx::DbConfig::new("postgresql");
/// cfg.db_system = String::new();
/// ```
///
/// Query text is on by default and is turned off with
/// [`DbConfig::without_query_text`]. There is no boolean setter:
///
/// ```compile_fail,E0599
/// let _ = libo11y_sqlx::DbConfig::new("postgresql").with_query_text(false);
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbConfig {
    /// OpenTelemetry `db.system.name` (for example `"postgresql"`, `"sqlite"`,
    /// `"mysql"`, `"mariadb"`, or `"other_sql"`).
    ///
    /// Also selects the lexical dialect used to sanitize `db.query.text`.
    /// `db.query.text` is only recorded for `postgresql`, `sqlite`, `mysql`,
    /// and `mariadb`.
    db_system: String,
    /// Optional `db.namespace` (database/schema name).
    db_namespace: Option<String>,
    /// Optional `db.client.connection.pool.name` on pool metrics. Defaults to
    /// `db_system` when unset or empty.
    pool_name: Option<String>,
    /// Optional `server.address` (host name or IP).
    server_address: Option<String>,
    /// Optional `server.port`.
    server_port: Option<u16>,
    /// Whether to record sanitized `db.query.text` on spans (default `true`).
    /// Ignored for dialects the sanitizer has no lexer for.
    include_query_text: bool,
    /// Whether to emit client spans when no valid parent span is active in the
    /// current context (default `false`, matching Go `o11ysql` so pool
    /// maintenance and background queries do not create stray root spans).
    record_unparented_spans: bool,
}

impl Default for DbConfig {
    fn default() -> Self {
        Self::new(OTHER_SQL)
    }
}

impl DbConfig {
    /// Creates a `DbConfig` for the OpenTelemetry `db.system.name`
    /// `db_system`, for example `"postgresql"`, `"sqlite"`, `"mysql"`,
    /// `"mariadb"`, or `"other_sql"`. An empty `db_system` becomes
    /// [`OTHER_SQL`].
    ///
    /// `db_system` also selects the lexical dialect that sanitizes
    /// `db.query.text`, which is recorded only for `postgresql`, `sqlite`,
    /// `mysql`, and `mariadb`. Query text is on and unparented spans are off
    /// by default.
    #[must_use]
    pub fn new(db_system: impl Into<String>) -> Self {
        let mut system = db_system.into();
        if system.is_empty() {
            OTHER_SQL.clone_into(&mut system);
        }
        Self {
            db_system: system,
            db_namespace: None,
            pool_name: None,
            server_address: None,
            server_port: None,
            include_query_text: true,
            record_unparented_spans: false,
        }
    }

    /// Creates a `DbConfig` whose `db_system` is inferred from `DB`.
    #[must_use]
    pub fn for_database<DB: KnownDatabase>() -> Self {
        Self::new(DB::DB_SYSTEM)
    }

    /// Overrides `db.system.name`. An empty value becomes [`OTHER_SQL`].
    #[must_use]
    pub fn with_db_system(mut self, db_system: impl Into<String>) -> Self {
        let system = db_system.into();
        self.db_system = if system.is_empty() {
            OTHER_SQL.to_owned()
        } else {
            system
        };
        self
    }

    /// Sets `db.namespace`.
    #[must_use]
    pub fn with_db_namespace(mut self, db_namespace: impl Into<String>) -> Self {
        let ns = db_namespace.into();
        self.db_namespace = (!ns.is_empty()).then_some(ns);
        self
    }

    /// Sets `db.client.connection.pool.name` for pool metrics.
    #[must_use]
    pub fn with_pool_name(mut self, pool_name: impl Into<String>) -> Self {
        let name = pool_name.into();
        self.pool_name = (!name.is_empty()).then_some(name);
        self
    }

    /// Sets `server.address`.
    #[must_use]
    pub fn with_server_address(mut self, server_address: impl Into<String>) -> Self {
        let addr = server_address.into();
        self.server_address = (!addr.is_empty()).then_some(addr);
        self
    }

    /// Sets `server.port`.
    #[must_use]
    pub fn with_server_port(mut self, server_port: u16) -> Self {
        self.server_port = Some(server_port);
        self
    }

    /// Disables recording sanitized `db.query.text` on spans. It is recorded
    /// by default. See the [`sanitize`](crate::sqltext::sanitize) docs for
    /// the server settings under which the sanitizer can keep part of a
    /// literal.
    #[must_use]
    pub fn without_query_text(mut self) -> Self {
        self.include_query_text = false;
        self
    }

    /// Enables or disables creating root client spans when no active parent
    /// span exists in the current context.
    #[must_use]
    pub fn with_record_unparented_spans(mut self, record: bool) -> Self {
        self.record_unparented_spans = record;
        self
    }

    /// Effective `db.client.connection.pool.name` (defaults to `db_system`).
    pub(crate) fn effective_pool_name(&self) -> &str {
        self.pool_name
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(&self.db_system)
    }

    /// Returns the configured `db.system.name`.
    #[must_use]
    pub fn db_system(&self) -> &str {
        &self.db_system
    }

    /// Returns the configured `db.namespace`, if any.
    #[must_use]
    pub fn db_namespace(&self) -> Option<&str> {
        self.db_namespace.as_deref()
    }

    /// Returns the configured `db.client.connection.pool.name`, if explicitly set.
    #[must_use]
    pub fn pool_name(&self) -> Option<&str> {
        self.pool_name.as_deref()
    }

    /// Returns the configured `server.address`, if any.
    #[must_use]
    pub fn server_address(&self) -> Option<&str> {
        self.server_address.as_deref()
    }

    /// Returns the configured `server.port`, if any.
    #[must_use]
    pub const fn server_port(&self) -> Option<u16> {
        self.server_port
    }

    /// Reports whether sanitized `db.query.text` recording is enabled.
    #[must_use]
    pub const fn include_query_text(&self) -> bool {
        self.include_query_text
    }

    /// Reports whether client spans are created without an active parent span.
    #[must_use]
    pub const fn record_unparented_spans(&self) -> bool {
        self.record_unparented_spans
    }
}

/// Bounded error metadata extracted from a [`sqlx::Error`] without retaining
/// the raw error message (which may quote statement parameter values).
#[derive(Debug, Clone)]
pub(crate) struct ErrorInfo {
    pub(crate) error_type: &'static str,
    pub(crate) status_code: Option<String>,
}

impl ErrorInfo {
    pub(crate) fn from_sqlx(err: &sqlx::Error) -> Self {
        let status_code = err
            .as_database_error()
            .and_then(sqlx::error::DatabaseError::code)
            .map(std::borrow::Cow::into_owned)
            .filter(|code| !code.is_empty());
        Self {
            error_type: error_type_name(err),
            status_code,
        }
    }
}

fn error_type_name(err: &sqlx::Error) -> &'static str {
    match err {
        sqlx::Error::Configuration(_) => "sqlx::Error::Configuration",
        sqlx::Error::InvalidArgument(_) => "sqlx::Error::InvalidArgument",
        sqlx::Error::Database(_) => "sqlx::Error::Database",
        sqlx::Error::Io(_) => "sqlx::Error::Io",
        sqlx::Error::Tls(_) => "sqlx::Error::Tls",
        sqlx::Error::Protocol(_) => "sqlx::Error::Protocol",
        sqlx::Error::RowNotFound => "sqlx::Error::RowNotFound",
        sqlx::Error::TypeNotFound { .. } => "sqlx::Error::TypeNotFound",
        sqlx::Error::ColumnIndexOutOfBounds { .. } => "sqlx::Error::ColumnIndexOutOfBounds",
        sqlx::Error::ColumnNotFound(_) => "sqlx::Error::ColumnNotFound",
        sqlx::Error::ColumnDecode { .. } => "sqlx::Error::ColumnDecode",
        sqlx::Error::Encode(_) => "sqlx::Error::Encode",
        sqlx::Error::Decode(_) => "sqlx::Error::Decode",
        sqlx::Error::AnyDriverError(_) => "sqlx::Error::AnyDriverError",
        sqlx::Error::PoolTimedOut => "sqlx::Error::PoolTimedOut",
        sqlx::Error::PoolClosed => "sqlx::Error::PoolClosed",
        sqlx::Error::WorkerCrashed => "sqlx::Error::WorkerCrashed",
        sqlx::Error::InvalidSavePointStatement => "sqlx::Error::InvalidSavePointStatement",
        sqlx::Error::BeginFailed => "sqlx::Error::BeginFailed",
        _ => "sqlx::Error",
    }
}

/// Prepared telemetry description of one SQL statement or transaction action.
#[derive(Debug, Clone)]
pub(crate) struct StatementInfo {
    pub(crate) span_name: String,
    pub(crate) query_text: Option<String>,
    pub(crate) attrs: Vec<KeyValue>,
}

/// Turns `SQLx` calls into OpenTelemetry spans and duration histograms.
#[derive(Debug)]
pub(crate) struct Instrumenter {
    config: DbConfig,
    tracer: SdkTracer,
    duration: Histogram<f64>,
    dialect: Dialect,
    record_query_text: bool,
    base_attrs: Vec<KeyValue>,
}

impl Instrumenter {
    pub(crate) fn new(sdk: &Sdk, config: DbConfig) -> Arc<Self> {
        let sc = scope();
        let tracer = sdk.tracer_provider().tracer_with_scope(sc.clone());
        let meter = sdk.meter_provider().meter_with_scope(sc);
        let duration = meter
            .f64_histogram(METRIC_OPERATION_DURATION)
            .with_unit("s")
            .with_description("Duration of database client operations.")
            .with_boundaries(DURATION_BUCKETS.to_vec())
            .build();
        let dialect = Dialect::from_system(&config.db_system);
        let record_query_text = config.include_query_text && dialect.supports_query_text();

        let mut base_attrs = Vec::with_capacity(4);
        base_attrs.push(KeyValue::new(ATTR_DB_SYSTEM_NAME, config.db_system.clone()));
        if let Some(ns) = &config.db_namespace {
            base_attrs.push(KeyValue::new(ATTR_DB_NAMESPACE, ns.clone()));
        }
        if let Some(addr) = &config.server_address {
            base_attrs.push(KeyValue::new(ATTR_SERVER_ADDRESS, addr.clone()));
        }
        if let Some(port) = config.server_port {
            base_attrs.push(KeyValue::new(ATTR_SERVER_PORT, i64::from(port)));
        }

        Arc::new(Self {
            config,
            tracer,
            duration,
            dialect,
            record_query_text,
            base_attrs,
        })
    }

    pub(crate) fn config(&self) -> &DbConfig {
        &self.config
    }

    pub(crate) fn describe(&self, sql: &str) -> StatementInfo {
        let sanitized = sanitize(sql, self.dialect);
        let summary = summarize(&sanitized);
        let mut info = self.named(&summary.operation, &summary.collection);
        if self.record_query_text && !sanitized.is_empty() {
            info.query_text = Some(truncate_utf8(&sanitized, MAX_QUERY_TEXT).to_owned());
        }
        info
    }

    pub(crate) fn named(&self, operation: &str, collection: &str) -> StatementInfo {
        let mut attrs = self.base_attrs.clone();
        let span_name = match (operation.is_empty(), collection.is_empty()) {
            (false, false) => {
                attrs.push(KeyValue::new(ATTR_DB_OPERATION_NAME, operation.to_owned()));
                attrs.push(KeyValue::new(
                    ATTR_DB_COLLECTION_NAME,
                    collection.to_owned(),
                ));
                format!("{operation} {collection}")
            }
            (false, true) => {
                attrs.push(KeyValue::new(ATTR_DB_OPERATION_NAME, operation.to_owned()));
                operation.to_owned()
            }
            (true, false) => {
                attrs.push(KeyValue::new(
                    ATTR_DB_COLLECTION_NAME,
                    collection.to_owned(),
                ));
                collection.to_owned()
            }
            (true, true) => self.config.db_system.clone(),
        };

        StatementInfo {
            span_name,
            query_text: None,
            attrs,
        }
    }

    pub(crate) fn begin(
        self: &Arc<Self>,
        statement: StatementInfo,
        caller_cx: Context,
    ) -> InFlight {
        InFlight {
            call: Some(Call {
                ins: Arc::clone(self),
                statement,
                caller_cx,
                start_time: SystemTime::now(),
                start_instant: Instant::now(),
            }),
        }
    }
}

/// `error.type` recorded when a database call's future is dropped before it
/// completes, for example under `tokio::time::timeout` or `tokio::select!`.
const ERROR_TYPE_CANCELED: &str = "canceled";

/// `error.type` recorded when a database call panics while it is polled.
/// Matches the panic paths of the other libo11y Rust instrumentation crates.
const ERROR_TYPE_PANIC: &str = "panic";

/// One database call currently in flight.
///
/// [`InFlight::finish`] records the client span and the
/// `db.client.operation.duration` measurement. If the `InFlight` is dropped
/// unfinished, because the future that owns it was cancelled or panicked,
/// `Drop` records them instead with an `error.type` of `canceled` or `panic`.
/// Either way the call is recorded exactly once.
pub(crate) struct InFlight {
    call: Option<Call>,
}

impl InFlight {
    pub(crate) fn finish(mut self, error: Option<&ErrorInfo>) {
        if let Some(call) = self.call.take() {
            call.record(error);
        }
    }

    pub(crate) fn finish_panic(mut self) {
        if let Some(call) = self.call.take() {
            call.record(Some(&ErrorInfo {
                error_type: ERROR_TYPE_PANIC,
                status_code: None,
            }));
        }
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        if let Some(call) = self.call.take() {
            let error_type = if std::thread::panicking() {
                ERROR_TYPE_PANIC
            } else {
                ERROR_TYPE_CANCELED
            };
            call.record(Some(&ErrorInfo {
                error_type,
                status_code: None,
            }));
        }
    }
}

/// The recorded state of one database call.
struct Call {
    ins: Arc<Instrumenter>,
    statement: StatementInfo,
    caller_cx: Context,
    start_time: SystemTime,
    start_instant: Instant,
}

impl Call {
    fn record(self, error: Option<&ErrorInfo>) {
        let end_time = SystemTime::now();
        let elapsed_secs = self.start_instant.elapsed().as_secs_f64();

        let mut metric_attrs = self.statement.attrs;
        if let Some(err) = error {
            metric_attrs.push(KeyValue::new(ATTR_ERROR_TYPE, err.error_type));
            if let Some(code) = &err.status_code {
                metric_attrs.push(KeyValue::new(ATTR_DB_RESPONSE_STATUS_CODE, code.clone()));
            }
        }

        let has_parent = self.caller_cx.span().span_context().is_valid();
        if has_parent || self.ins.config.record_unparented_spans {
            let mut span_attrs = metric_attrs.clone();
            if let Some(query_text) = self.statement.query_text {
                span_attrs.push(KeyValue::new(ATTR_DB_QUERY_TEXT, query_text));
            }
            let builder = SpanBuilder::from_name(self.statement.span_name)
                .with_kind(SpanKind::Client)
                .with_start_time(self.start_time)
                .with_attributes(span_attrs);
            let mut span = self.ins.tracer.build_with_context(builder, &self.caller_cx);
            if error.is_some() {
                // Leave description empty: raw database error messages may
                // quote statement parameter values.
                span.set_status(Status::error(""));
            }
            let record_cx = self
                .caller_cx
                .with_remote_span_context(span.span_context().clone());
            span.end_with_timestamp(end_time);

            let _guard = record_cx.attach();
            self.ins.duration.record(elapsed_secs, &metric_attrs);
        } else {
            let _guard = Context::new().attach();
            self.ins.duration.record(elapsed_secs, &metric_attrs);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dialect_mapping_and_query_text_policy_match_go() {
        for (system, want_dialect, want_query_text) in [
            ("postgresql", Dialect::Postgres, true),
            ("sqlite", Dialect::Sqlite, true),
            ("mysql", Dialect::Mysql, true),
            ("mariadb", Dialect::Mariadb, true),
            ("other_sql", Dialect::Other, false),
            ("microsoft.sql_server", Dialect::Other, false),
            ("oracle.db", Dialect::Other, false),
            ("PostgreSQL", Dialect::Other, false),
        ] {
            let d = Dialect::from_system(system);
            assert_eq!(d, want_dialect, "{system}");
            assert_eq!(d.supports_query_text(), want_query_text, "{system}");
        }
    }

    #[test]
    fn empty_db_system_becomes_other_sql() {
        assert_eq!(DbConfig::new("").db_system, OTHER_SQL);
        assert_eq!(
            DbConfig::new("postgresql").with_db_system("").db_system,
            OTHER_SQL
        );
    }

    #[test]
    fn config_defaults_and_builders() {
        let cfg = DbConfig::default();
        assert_eq!(cfg.db_system, "other_sql");
        assert!(cfg.include_query_text);
        assert!(!cfg.record_unparented_spans);
        assert_eq!(cfg.effective_pool_name(), "other_sql");

        let cfg = DbConfig::new("postgresql")
            .with_db_namespace("orders")
            .with_pool_name("primary")
            .with_server_address("db.internal")
            .with_server_port(5432)
            .without_query_text()
            .with_record_unparented_spans(true);
        assert_eq!(cfg.db_system, "postgresql");
        assert_eq!(cfg.db_namespace.as_deref(), Some("orders"));
        assert_eq!(cfg.effective_pool_name(), "primary");
        assert_eq!(cfg.server_address.as_deref(), Some("db.internal"));
        assert_eq!(cfg.server_port, Some(5432));
        assert!(!cfg.include_query_text);
        assert!(cfg.record_unparented_spans);
    }

    #[test]
    fn empty_operation_and_collection_fall_back_to_db_system_name() {
        let rec = libo11y_test::Recorder::start("sqlx-fallback-name");
        let cfg = DbConfig::new("postgresql").with_db_namespace("orders");
        let ins = Instrumenter::new(rec.sdk(), cfg);
        let info = ins.named("", "");
        assert_eq!(info.span_name, "postgresql");
    }
}
