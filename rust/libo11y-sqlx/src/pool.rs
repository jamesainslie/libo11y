//! Instrumented `sqlx` pool, connection, and transaction wrappers implementing
//! [`sqlx::Executor`].

use std::fmt;
use std::pin::Pin;
use std::sync::{Arc, Weak};
use std::task::{Context as TaskContext, Poll};

use futures_core::Stream;
use futures_core::future::BoxFuture;
use futures_core::stream::BoxStream;
use futures_util::StreamExt as _;
use opentelemetry::metrics::{MeterProvider as _, ObservableUpDownCounter};
use opentelemetry::{Context, KeyValue};
use sqlx::pool::PoolConnection;
use sqlx::{Database, Either, Error, Execute, Executor, Pool, SqlStr, Transaction};

use libo11y::Sdk;

use crate::telemetry::{
    ATTR_CONNECTION_STATE, ATTR_POOL_NAME, DbConfig, ErrorInfo, InFlight, Instrumenter,
    KnownDatabase, METRIC_CONNECTION_COUNT, METRIC_CONNECTION_MAX, scope,
};

/// Pool metrics observable handles kept alive alongside the pool.
struct PoolMetricHandles {
    _count: ObservableUpDownCounter<i64>,
    _max: ObservableUpDownCounter<i64>,
}

struct PoolState<DB: Database> {
    pool: Pool<DB>,
    ins: Arc<Instrumenter>,
    _metrics: PoolMetricHandles,
}

/// An instrumented [`sqlx::Pool`] bound to a [`libo11y::Sdk`].
///
/// Cloning is cheap: clones share the underlying pool, instrumenter, and pool
/// metric registration. Implements [`sqlx::Executor`] on `&O11yPool<DB>` so
/// standard `sqlx::query(...)` calls execute with tracing and metrics
/// unchanged.
///
/// Pool metrics (`db.client.connection.count` and `db.client.connection.max`)
/// stop reporting once the pool is closed via [`O11yPool::close`] or all
/// `O11yPool` handles are dropped.
pub struct O11yPool<DB: Database> {
    state: Arc<PoolState<DB>>,
}

impl<DB: Database> Clone for O11yPool<DB> {
    fn clone(&self) -> Self {
        Self {
            state: Arc::clone(&self.state),
        }
    }
}

impl<DB: Database> fmt::Debug for O11yPool<DB> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("O11yPool")
            .field("config", self.state.ins.config())
            .field("size", &self.state.pool.size())
            .field("num_idle", &self.state.pool.num_idle())
            .field("is_closed", &self.state.pool.is_closed())
            .finish()
    }
}

impl<DB: KnownDatabase> O11yPool<DB> {
    /// Wraps `pool` with instrumentation bound to `sdk`, inferring
    /// `db.system.name` from `DB`.
    #[must_use]
    pub fn new(pool: Pool<DB>, sdk: &Sdk) -> Self {
        Self::with_config(pool, sdk, DbConfig::for_database::<DB>())
    }
}

impl<DB: Database> O11yPool<DB> {
    /// Wraps `pool` with instrumentation bound to `sdk` using `config`.
    #[must_use]
    pub fn with_config(pool: Pool<DB>, sdk: &Sdk, config: DbConfig) -> Self {
        let pool_name = config.effective_pool_name().to_owned();
        let ins = Instrumenter::new(sdk, config);
        let meter = sdk.meter_provider().meter_with_scope(scope());

        // Use Arc::new_cyclic so the observable metric callbacks hold only a
        // Weak reference to the pool state: dropping all O11yPool handles or
        // closing the pool immediately stops reporting metrics without keeping
        // the pool alive.
        let state = Arc::new_cyclic(|weak: &Weak<PoolState<DB>>| {
            let weak_count = Weak::clone(weak);
            let pool_kv_count = KeyValue::new(ATTR_POOL_NAME, pool_name.clone());
            let idle_attrs = [
                pool_kv_count.clone(),
                KeyValue::new(ATTR_CONNECTION_STATE, "idle"),
            ];
            let used_attrs = [pool_kv_count, KeyValue::new(ATTR_CONNECTION_STATE, "used")];
            let count = meter
                .i64_observable_up_down_counter(METRIC_CONNECTION_COUNT)
                .with_unit("{connection}")
                .with_description(
                    "The number of connections that are currently in state described by the `state` attribute.",
                )
                .with_callback(move |observer| {
                    let Some(state) = weak_count.upgrade() else {
                        return;
                    };
                    if state.pool.is_closed() {
                        return;
                    }
                    let total = i64::from(state.pool.size());
                    let idle = i64::try_from(state.pool.num_idle()).unwrap_or(i64::MAX);
                    let used = total.saturating_sub(idle).max(0);
                    observer.observe(idle, &idle_attrs);
                    observer.observe(used, &used_attrs);
                })
                .build();

            let weak_max = Weak::clone(weak);
            let max_attrs = [KeyValue::new(ATTR_POOL_NAME, pool_name)];
            let max = meter
                .i64_observable_up_down_counter(METRIC_CONNECTION_MAX)
                .with_unit("{connection}")
                .with_description("The maximum number of open connections allowed.")
                .with_callback(move |observer| {
                    let Some(state) = weak_max.upgrade() else {
                        return;
                    };
                    if state.pool.is_closed() {
                        return;
                    }
                    let max_conns = i64::from(state.pool.options().get_max_connections());
                    if max_conns > 0 {
                        observer.observe(max_conns, &max_attrs);
                    }
                })
                .build();

            PoolState {
                pool,
                ins,
                _metrics: PoolMetricHandles {
                    _count: count,
                    _max: max,
                },
            }
        });

        Self { state }
    }

    /// Returns a reference to the underlying [`sqlx::Pool`].
    #[must_use]
    pub fn inner(&self) -> &Pool<DB> {
        &self.state.pool
    }

    /// Returns the instrumentation [`DbConfig`].
    #[must_use]
    pub fn config(&self) -> &DbConfig {
        self.state.ins.config()
    }

    /// Returns the number of connections currently open in the pool (idle and
    /// in use).
    #[must_use]
    pub fn size(&self) -> u32 {
        self.state.pool.size()
    }

    /// Returns the number of idle connections currently in the pool.
    #[must_use]
    pub fn num_idle(&self) -> usize {
        self.state.pool.num_idle()
    }

    /// Reports whether [`O11yPool::close`] has been called on the pool.
    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.state.pool.is_closed()
    }

    /// Closes the underlying connection pool and stops pool metric reporting.
    pub async fn close(&self) {
        self.state.pool.close().await;
    }

    /// Acquires an instrumented connection from the pool.
    ///
    /// # Errors
    ///
    /// Returns any [`sqlx::Error`] from [`Pool::acquire`].
    pub async fn acquire(&self) -> Result<O11yConnection<DB>, Error> {
        let conn = self.state.pool.acquire().await?;
        Ok(O11yConnection {
            conn,
            ins: Arc::clone(&self.state.ins),
        })
    }

    /// Acquires a connection and begins an instrumented transaction, recording
    /// a `BEGIN` client span (when under a parent span) and duration metric.
    ///
    /// # Errors
    ///
    /// Returns any [`sqlx::Error`] from [`Pool::begin`].
    pub async fn begin(&self) -> Result<O11yTransaction<'static, DB>, Error> {
        let caller_cx = Context::current();
        let in_flight = self
            .state
            .ins
            .begin(self.state.ins.named("BEGIN", ""), caller_cx);
        let res = self.state.pool.begin().await;
        match res {
            Ok(tx) => {
                in_flight.finish(None);
                Ok(O11yTransaction {
                    tx,
                    ins: Arc::clone(&self.state.ins),
                })
            }
            Err(err) => {
                let info = ErrorInfo::from_sqlx(&err);
                in_flight.finish(Some(&info));
                Err(err)
            }
        }
    }
}

/// An instrumented pooled connection returned by [`O11yPool::acquire`].
///
/// Implements [`sqlx::Executor`] on `&mut O11yConnection<DB>`.
pub struct O11yConnection<DB: Database> {
    conn: PoolConnection<DB>,
    ins: Arc<Instrumenter>,
}

impl<DB: Database> fmt::Debug for O11yConnection<DB> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("O11yConnection")
            .field("config", self.ins.config())
            .finish_non_exhaustive()
    }
}

impl<DB: Database> O11yConnection<DB> {
    /// Returns a reference to the underlying database connection.
    #[must_use]
    pub fn inner(&self) -> &DB::Connection {
        &self.conn
    }

    /// Returns a mutable reference to the underlying database connection.
    #[must_use]
    pub fn inner_mut(&mut self) -> &mut DB::Connection {
        &mut self.conn
    }

    /// Begins an instrumented transaction on this connection, recording a
    /// `BEGIN` span and duration metric.
    ///
    /// # Errors
    ///
    /// Returns any [`sqlx::Error`] from [`sqlx::Connection::begin`].
    pub async fn begin(&mut self) -> Result<O11yTransaction<'_, DB>, Error> {
        use sqlx::Connection as _;

        let caller_cx = Context::current();
        let in_flight = self.ins.begin(self.ins.named("BEGIN", ""), caller_cx);
        let res = self.conn.begin().await;
        match res {
            Ok(tx) => {
                in_flight.finish(None);
                Ok(O11yTransaction {
                    tx,
                    ins: Arc::clone(&self.ins),
                })
            }
            Err(err) => {
                let info = ErrorInfo::from_sqlx(&err);
                in_flight.finish(Some(&info));
                Err(err)
            }
        }
    }
}

/// An instrumented database transaction returned by [`O11yPool::begin`] or
/// [`O11yConnection::begin`].
///
/// Implements [`sqlx::Executor`] on `&mut O11yTransaction<'_, DB>`, and
/// instruments [`O11yTransaction::commit`] and [`O11yTransaction::rollback`]
/// with `COMMIT` and `ROLLBACK` spans and duration metrics.
pub struct O11yTransaction<'c, DB: Database> {
    tx: Transaction<'c, DB>,
    ins: Arc<Instrumenter>,
}

impl<DB: Database> fmt::Debug for O11yTransaction<'_, DB> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("O11yTransaction")
            .field("config", self.ins.config())
            .finish_non_exhaustive()
    }
}

impl<DB: Database> O11yTransaction<'_, DB> {
    /// Commits the transaction, recording a `COMMIT` span and duration metric.
    ///
    /// # Errors
    ///
    /// Returns any [`sqlx::Error`] from [`Transaction::commit`].
    pub async fn commit(self) -> Result<(), Error> {
        let caller_cx = Context::current();
        let in_flight = self.ins.begin(self.ins.named("COMMIT", ""), caller_cx);
        let res = self.tx.commit().await;
        match res {
            Ok(()) => {
                in_flight.finish(None);
                Ok(())
            }
            Err(err) => {
                let info = ErrorInfo::from_sqlx(&err);
                in_flight.finish(Some(&info));
                Err(err)
            }
        }
    }

    /// Rolls back the transaction, recording a `ROLLBACK` span and duration
    /// metric.
    ///
    /// # Errors
    ///
    /// Returns any [`sqlx::Error`] from [`Transaction::rollback`].
    pub async fn rollback(self) -> Result<(), Error> {
        let caller_cx = Context::current();
        let in_flight = self.ins.begin(self.ins.named("ROLLBACK", ""), caller_cx);
        let res = self.tx.rollback().await;
        match res {
            Ok(()) => {
                in_flight.finish(None);
                Ok(())
            }
            Err(err) => {
                let info = ErrorInfo::from_sqlx(&err);
                in_flight.finish(Some(&info));
                Err(err)
            }
        }
    }
}

/// Lossless wrapper around an [`Execute`] query whose SQL text has already
/// been inspected for telemetry.
struct CapturedExecute<DB: Database> {
    sql: SqlStr,
    statement: Option<DB::Statement>,
    arguments: Option<Result<Option<DB::Arguments>, sqlx::error::BoxDynError>>,
    persistent: bool,
}

impl<DB: Database> CapturedExecute<DB> {
    fn capture<'q, E: Execute<'q, DB>>(mut query: E) -> Self {
        let statement = query.statement().cloned();
        let persistent = query.persistent();
        let arguments = Some(query.take_arguments());
        let sql = query.sql();
        Self {
            sql,
            statement,
            arguments,
            persistent,
        }
    }

    fn sql_str(&self) -> &str {
        self.sql.as_str()
    }
}

impl<DB: Database> Execute<'_, DB> for CapturedExecute<DB> {
    fn sql(self) -> SqlStr {
        self.sql
    }

    fn statement(&self) -> Option<&DB::Statement> {
        self.statement.as_ref()
    }

    fn take_arguments(&mut self) -> Result<Option<DB::Arguments>, sqlx::error::BoxDynError> {
        match self.arguments.take() {
            Some(res) => res,
            None => Ok(None),
        }
    }

    fn persistent(&self) -> bool {
        self.persistent
    }
}

/// Stream wrapper that finishes an [`InFlight`] operation when the inner
/// `sqlx` stream completes or is dropped.
struct InstrumentedStream<'e, T> {
    inner: BoxStream<'e, Result<T, Error>>,
    in_flight: Option<InFlight>,
    first_error: Option<ErrorInfo>,
    panicked_in_poll: bool,
}

impl<T> Stream for InstrumentedStream<'_, T> {
    type Item = Result<T, Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        this.panicked_in_poll = true;
        let poll = this.inner.as_mut().poll_next(cx);
        this.panicked_in_poll = false;
        match poll {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Some(Ok(item))) => Poll::Ready(Some(Ok(item))),
            Poll::Ready(Some(Err(err))) => {
                if this.first_error.is_none() {
                    this.first_error = Some(ErrorInfo::from_sqlx(&err));
                }
                Poll::Ready(Some(Err(err)))
            }
            Poll::Ready(None) => {
                if let Some(in_flight) = this.in_flight.take() {
                    in_flight.finish(this.first_error.as_ref());
                }
                Poll::Ready(None)
            }
        }
    }
}

impl<T> Drop for InstrumentedStream<'_, T> {
    fn drop(&mut self) {
        // A row stream dropped before its end is recorded as finished: with
        // the first error it yielded, or as a success, unless the inner stream
        // itself panicked while being polled. Dropping a stream early is
        // ordinary use, such as taking only the first rows, and Go `o11ysql`
        // does not treat an early `rows.Close()` as an error. So this does not
        // let `InFlight` record a cancellation.
        if let Some(in_flight) = self.in_flight.take() {
            if self.panicked_in_poll {
                in_flight.finish_panic();
            } else {
                in_flight.finish(self.first_error.as_ref());
            }
        }
    }
}

/// Runs a future producing `Result<T, Error>` under an instrumented operation,
/// capturing `Context::current()` when the future begins executing.
fn instrument_future<'e, T, F>(
    ins: Arc<Instrumenter>,
    sql_info: crate::telemetry::StatementInfo,
    run: impl FnOnce() -> F + Send + 'e,
) -> BoxFuture<'e, Result<T, Error>>
where
    T: Send + 'e,
    F: std::future::Future<Output = Result<T, Error>> + Send + 'e,
{
    Box::pin(async move {
        let caller_cx = Context::current();
        let in_flight = ins.begin(sql_info, caller_cx);
        let result = run().await;
        match &result {
            Ok(_) => in_flight.finish(None),
            Err(err) => {
                let info = ErrorInfo::from_sqlx(err);
                in_flight.finish(Some(&info));
            }
        }
        result
    })
}

/// Lazily captures `Context::current()` on first poll before forwarding to an
/// [`InstrumentedStream`].
fn instrument_stream<'e, T, F>(
    ins: Arc<Instrumenter>,
    sql_info: crate::telemetry::StatementInfo,
    make_stream: F,
) -> BoxStream<'e, Result<T, Error>>
where
    T: Send + 'e,
    F: FnOnce() -> BoxStream<'e, Result<T, Error>> + Send + 'e,
{
    let fut = async move {
        let caller_cx = Context::current();
        let in_flight = ins.begin(sql_info, caller_cx);
        InstrumentedStream {
            inner: make_stream(),
            in_flight: Some(in_flight),
            first_error: None,
            panicked_in_poll: false,
        }
    };
    futures_util::stream::once(fut).flatten().boxed()
}

impl<'p, DB: Database> Executor<'p> for &'p O11yPool<DB>
where
    for<'c> &'c mut DB::Connection: Executor<'c, Database = DB>,
{
    type Database = DB;

    fn execute<'e, 'q: 'e, E>(self, query: E) -> BoxFuture<'e, Result<DB::QueryResult, Error>>
    where
        'p: 'e,
        E: 'q + Execute<'q, Self::Database>,
    {
        let captured = CapturedExecute::capture(query);
        let info = self.state.ins.describe(captured.sql_str());
        let pool = self.state.pool.clone();
        instrument_future(Arc::clone(&self.state.ins), info, move || async move {
            pool.execute(captured).await
        })
    }

    fn fetch_all<'e, 'q: 'e, E>(self, query: E) -> BoxFuture<'e, Result<Vec<DB::Row>, Error>>
    where
        'p: 'e,
        E: 'q + Execute<'q, Self::Database>,
    {
        let captured = CapturedExecute::capture(query);
        let info = self.state.ins.describe(captured.sql_str());
        let pool = self.state.pool.clone();
        instrument_future(Arc::clone(&self.state.ins), info, move || async move {
            pool.fetch_all(captured).await
        })
    }

    fn fetch_one<'e, 'q: 'e, E>(self, query: E) -> BoxFuture<'e, Result<DB::Row, Error>>
    where
        'p: 'e,
        E: 'q + Execute<'q, Self::Database>,
    {
        let captured = CapturedExecute::capture(query);
        let info = self.state.ins.describe(captured.sql_str());
        let pool = self.state.pool.clone();
        instrument_future(Arc::clone(&self.state.ins), info, move || async move {
            pool.fetch_one(captured).await
        })
    }

    fn fetch_optional<'e, 'q: 'e, E>(
        self,
        query: E,
    ) -> BoxFuture<'e, Result<Option<DB::Row>, Error>>
    where
        'p: 'e,
        E: 'q + Execute<'q, Self::Database>,
    {
        let captured = CapturedExecute::capture(query);
        let info = self.state.ins.describe(captured.sql_str());
        let pool = self.state.pool.clone();
        instrument_future(Arc::clone(&self.state.ins), info, move || async move {
            pool.fetch_optional(captured).await
        })
    }

    fn fetch_many<'e, 'q: 'e, E>(
        self,
        query: E,
    ) -> BoxStream<'e, Result<Either<DB::QueryResult, DB::Row>, Error>>
    where
        'p: 'e,
        E: 'q + Execute<'q, Self::Database>,
    {
        let captured = CapturedExecute::capture(query);
        let info = self.state.ins.describe(captured.sql_str());
        // Pool::fetch_many builds a lazy stream (no I/O until first poll).
        let stream = self.state.pool.fetch_many(captured);
        instrument_stream(Arc::clone(&self.state.ins), info, move || stream)
    }

    fn prepare_with<'e>(
        self,
        sql: SqlStr,
        parameters: &'e [DB::TypeInfo],
    ) -> BoxFuture<'e, Result<DB::Statement, Error>>
    where
        'p: 'e,
    {
        self.state.pool.prepare_with(sql, parameters)
    }
}

impl<'c, DB: Database> Executor<'c> for &'c mut O11yConnection<DB>
where
    for<'a> &'a mut DB::Connection: Executor<'a, Database = DB>,
{
    type Database = DB;

    fn execute<'e, 'q: 'e, E>(self, query: E) -> BoxFuture<'e, Result<DB::QueryResult, Error>>
    where
        'c: 'e,
        E: 'q + Execute<'q, Self::Database>,
    {
        let captured = CapturedExecute::capture(query);
        let info = self.ins.describe(captured.sql_str());
        let ins = Arc::clone(&self.ins);
        instrument_future(ins, info, move || (&mut *self.conn).execute(captured))
    }

    fn fetch_all<'e, 'q: 'e, E>(self, query: E) -> BoxFuture<'e, Result<Vec<DB::Row>, Error>>
    where
        'c: 'e,
        E: 'q + Execute<'q, Self::Database>,
    {
        let captured = CapturedExecute::capture(query);
        let info = self.ins.describe(captured.sql_str());
        let ins = Arc::clone(&self.ins);
        instrument_future(ins, info, move || (&mut *self.conn).fetch_all(captured))
    }

    fn fetch_one<'e, 'q: 'e, E>(self, query: E) -> BoxFuture<'e, Result<DB::Row, Error>>
    where
        'c: 'e,
        E: 'q + Execute<'q, Self::Database>,
    {
        let captured = CapturedExecute::capture(query);
        let info = self.ins.describe(captured.sql_str());
        let ins = Arc::clone(&self.ins);
        instrument_future(ins, info, move || (&mut *self.conn).fetch_one(captured))
    }

    fn fetch_optional<'e, 'q: 'e, E>(
        self,
        query: E,
    ) -> BoxFuture<'e, Result<Option<DB::Row>, Error>>
    where
        'c: 'e,
        E: 'q + Execute<'q, Self::Database>,
    {
        let captured = CapturedExecute::capture(query);
        let info = self.ins.describe(captured.sql_str());
        let ins = Arc::clone(&self.ins);
        instrument_future(ins, info, move || {
            (&mut *self.conn).fetch_optional(captured)
        })
    }

    fn fetch_many<'e, 'q: 'e, E>(
        self,
        query: E,
    ) -> BoxStream<'e, Result<Either<DB::QueryResult, DB::Row>, Error>>
    where
        'c: 'e,
        E: 'q + Execute<'q, Self::Database>,
    {
        let captured = CapturedExecute::capture(query);
        let info = self.ins.describe(captured.sql_str());
        let ins = Arc::clone(&self.ins);
        instrument_stream(ins, info, move || (&mut *self.conn).fetch_many(captured))
    }

    fn prepare_with<'e>(
        self,
        sql: SqlStr,
        parameters: &'e [DB::TypeInfo],
    ) -> BoxFuture<'e, Result<DB::Statement, Error>>
    where
        'c: 'e,
    {
        (&mut *self.conn).prepare_with(sql, parameters)
    }
}

impl<'t, DB: Database> Executor<'t> for &'t mut O11yTransaction<'_, DB>
where
    for<'a> &'a mut DB::Connection: Executor<'a, Database = DB>,
{
    type Database = DB;

    fn execute<'e, 'q: 'e, E>(self, query: E) -> BoxFuture<'e, Result<DB::QueryResult, Error>>
    where
        't: 'e,
        E: 'q + Execute<'q, Self::Database>,
    {
        let captured = CapturedExecute::capture(query);
        let info = self.ins.describe(captured.sql_str());
        let ins = Arc::clone(&self.ins);
        instrument_future(ins, info, move || (&mut *self.tx).execute(captured))
    }

    fn fetch_all<'e, 'q: 'e, E>(self, query: E) -> BoxFuture<'e, Result<Vec<DB::Row>, Error>>
    where
        't: 'e,
        E: 'q + Execute<'q, Self::Database>,
    {
        let captured = CapturedExecute::capture(query);
        let info = self.ins.describe(captured.sql_str());
        let ins = Arc::clone(&self.ins);
        instrument_future(ins, info, move || (&mut *self.tx).fetch_all(captured))
    }

    fn fetch_one<'e, 'q: 'e, E>(self, query: E) -> BoxFuture<'e, Result<DB::Row, Error>>
    where
        't: 'e,
        E: 'q + Execute<'q, Self::Database>,
    {
        let captured = CapturedExecute::capture(query);
        let info = self.ins.describe(captured.sql_str());
        let ins = Arc::clone(&self.ins);
        instrument_future(ins, info, move || (&mut *self.tx).fetch_one(captured))
    }

    fn fetch_optional<'e, 'q: 'e, E>(
        self,
        query: E,
    ) -> BoxFuture<'e, Result<Option<DB::Row>, Error>>
    where
        't: 'e,
        E: 'q + Execute<'q, Self::Database>,
    {
        let captured = CapturedExecute::capture(query);
        let info = self.ins.describe(captured.sql_str());
        let ins = Arc::clone(&self.ins);
        instrument_future(ins, info, move || (&mut *self.tx).fetch_optional(captured))
    }

    fn fetch_many<'e, 'q: 'e, E>(
        self,
        query: E,
    ) -> BoxStream<'e, Result<Either<DB::QueryResult, DB::Row>, Error>>
    where
        't: 'e,
        E: 'q + Execute<'q, Self::Database>,
    {
        let captured = CapturedExecute::capture(query);
        let info = self.ins.describe(captured.sql_str());
        let ins = Arc::clone(&self.ins);
        instrument_stream(ins, info, move || (&mut *self.tx).fetch_many(captured))
    }

    fn prepare_with<'e>(
        self,
        sql: SqlStr,
        parameters: &'e [DB::TypeInfo],
    ) -> BoxFuture<'e, Result<DB::Statement, Error>>
    where
        't: 'e,
    {
        (&mut *self.tx).prepare_with(sql, parameters)
    }
}

#[cfg(test)]
mod tests {
    use std::panic::{AssertUnwindSafe, catch_unwind};

    use futures_util::FutureExt as _;
    use libo11y::opentelemetry_proto::tonic::common::v1::any_value::Value as ProtoVal;
    use libo11y::opentelemetry_proto::tonic::metrics::v1::{HistogramDataPoint, metric::Data};
    use libo11y_test::Recorder;
    use opentelemetry::trace::{FutureExt as _, Status, TraceContextExt as _, Tracer as _};
    use opentelemetry_sdk::trace::SpanData;

    use super::*;

    fn instrumenter(rec: &Recorder) -> Arc<Instrumenter> {
        Instrumenter::new(rec.sdk(), DbConfig::new("sqlite"))
    }

    fn parent_cx(rec: &Recorder) -> Context {
        Context::new().with_span(rec.sdk().tracer("test").start("handler"))
    }

    fn statement_spans(rec: &Recorder) -> Vec<SpanData> {
        rec.spans()
            .into_iter()
            .filter(|s| s.name != "handler")
            .collect()
    }

    fn span_error_type(span: &SpanData) -> Option<String> {
        span.attributes
            .iter()
            .find(|kv| kv.key.as_str() == "error.type")
            .map(|kv| kv.value.to_string())
    }

    fn duration_points(rec: &Recorder) -> Vec<HistogramDataPoint> {
        let mut out = Vec::new();
        for req in rec.metrics() {
            for rm in req.resource_metrics {
                for sm in rm.scope_metrics {
                    for m in sm.metrics {
                        if m.name == "db.client.operation.duration"
                            && let Some(Data::Histogram(h)) = m.data
                        {
                            out.extend(h.data_points);
                        }
                    }
                }
            }
        }
        out
    }

    fn point_error_type(dp: &HistogramDataPoint) -> Option<String> {
        dp.attributes.iter().find_map(|kv| {
            if kv.key != "error.type" {
                return None;
            }
            match kv.value.as_ref()?.value.as_ref()? {
                ProtoVal::StringValue(s) => Some(s.clone()),
                _ => None,
            }
        })
    }

    /// Asserts exactly one statement span and one duration measurement, both
    /// carrying `want_error_type`, with an error status when one is expected.
    fn assert_recorded_once(rec: &Recorder, want_error_type: Option<&str>) {
        let spans = statement_spans(rec);
        assert_eq!(spans.len(), 1, "want one statement span, got {spans:?}");
        let span = &spans[0];
        assert_eq!(span.name, "SELECT users");
        assert_eq!(span_error_type(span).as_deref(), want_error_type);
        let want_status = if want_error_type.is_some() {
            Status::error("")
        } else {
            Status::Unset
        };
        assert_eq!(span.status, want_status);

        let points = duration_points(rec);
        let count: u64 = points.iter().map(|dp| dp.count).sum();
        assert_eq!(count, 1, "want one duration measurement, got {points:?}");
        assert_eq!(point_error_type(&points[0]).as_deref(), want_error_type);
    }

    fn panics_in_driver() -> Result<(), Error> {
        panic!("driver panicked")
    }

    #[tokio::test]
    async fn dropped_future_records_span_and_duration_as_canceled() {
        let rec = Recorder::start("sqlx-cancel");
        let ins = instrumenter(&rec);
        let info = ins.describe("SELECT id FROM users");
        let mut fut = instrument_future::<(), _>(
            Arc::clone(&ins),
            info,
            std::future::pending::<Result<(), Error>>,
        );
        {
            let _guard = parent_cx(&rec).attach();
            assert!(fut.as_mut().now_or_never().is_none());
        }
        drop(fut);

        assert_recorded_once(&rec, Some("canceled"));
    }

    #[tokio::test]
    async fn panicking_future_records_span_and_duration_as_panic() {
        let rec = Recorder::start("sqlx-panic");
        let ins = instrumenter(&rec);
        let info = ins.describe("SELECT id FROM users");
        let mut fut =
            instrument_future::<(), _>(Arc::clone(&ins), info, || async { panics_in_driver() });
        let caught = {
            let _guard = parent_cx(&rec).attach();
            catch_unwind(AssertUnwindSafe(|| fut.as_mut().now_or_never()))
        };
        assert!(caught.is_err(), "the driver panic must propagate");
        drop(fut);

        assert_recorded_once(&rec, Some("panic"));
    }

    #[tokio::test]
    async fn completed_future_records_once() {
        let rec = Recorder::start("sqlx-complete");
        let ins = instrumenter(&rec);
        let info = ins.describe("SELECT id FROM users");
        let fut = instrument_future(Arc::clone(&ins), info, || async { Ok::<_, Error>(7) });
        let got = fut.with_context(parent_cx(&rec)).await;
        assert_eq!(got.expect("ok"), 7);

        assert_recorded_once(&rec, None);
    }

    #[tokio::test]
    async fn failed_future_records_once_with_sqlx_error_type() {
        let rec = Recorder::start("sqlx-failed");
        let ins = instrumenter(&rec);
        let info = ins.describe("SELECT id FROM users");
        let fut = instrument_future::<(), _>(Arc::clone(&ins), info, || async {
            Err(Error::RowNotFound)
        });
        let got = fut.with_context(parent_cx(&rec)).await;
        assert!(matches!(got, Err(Error::RowNotFound)));

        assert_recorded_once(&rec, Some("sqlx::Error::RowNotFound"));
    }
}
