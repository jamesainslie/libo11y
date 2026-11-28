//! Live in-memory `SQLite` integration tests for `libo11y-sqlx`.

#![cfg(feature = "sqlite")]

use futures_util::TryStreamExt as _;
use libo11y::opentelemetry_proto::tonic::common::v1::{
    KeyValue as ProtoKv, any_value::Value as ProtoVal,
};
use libo11y::opentelemetry_proto::tonic::metrics::v1::{
    HistogramDataPoint, NumberDataPoint, metric::Data, number_data_point,
};
use opentelemetry::trace::{
    FutureExt as _, Span as _, SpanId, SpanKind, Status, TraceContextExt as _, Tracer as _,
};
use opentelemetry::{Context, Value};
use opentelemetry_sdk::trace::SpanData;
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::{AssertSqlSafe, Executor as _, Row as _};
use tracing::Instrument as _;

use libo11y_sqlx::{DbConfig, O11yPool};
use libo11y_test::Recorder;

async fn memory_pool(sdk: &libo11y::Sdk, config: Option<DbConfig>) -> O11yPool<sqlx::Sqlite> {
    // SQLite `:memory:` databases are per-connection, so cap the helper pool
    // at 1 connection so every query sees the `users` table deterministically.
    let raw = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("connect sqlite::memory:");
    let pool = match config {
        Some(cfg) => O11yPool::with_config(raw, sdk, cfg),
        None => O11yPool::new(raw, sdk),
    };
    sqlx::query(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, age INTEGER NOT NULL)",
    )
    .execute(&pool)
    .await
    .expect("create table");
    pool
}

fn span_named(spans: &[SpanData], name: &str) -> SpanData {
    spans
        .iter()
        .find(|s| s.name == name)
        .cloned()
        .unwrap_or_else(|| {
            let names: Vec<_> = spans.iter().map(|s| s.name.as_ref()).collect();
            panic!("no span named {name:?} among {names:?}");
        })
}

fn span_attr(span: &SpanData, key: &str) -> Option<String> {
    span.attributes
        .iter()
        .find(|kv| kv.key.as_str() == key)
        .map(|kv| match &kv.value {
            Value::String(s) => s.to_string(),
            other => other.to_string(),
        })
}

fn proto_attr(attrs: &[ProtoKv], key: &str) -> Option<String> {
    attrs.iter().find_map(|kv| {
        if kv.key != key {
            return None;
        }
        match kv.value.as_ref()?.value.as_ref()? {
            ProtoVal::StringValue(s) => Some(s.clone()),
            ProtoVal::IntValue(i) => Some(i.to_string()),
            _ => None,
        }
    })
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

fn pool_points(rec: &Recorder, metric_name: &str) -> Vec<NumberDataPoint> {
    // Take the latest exported batch containing `metric_name`.
    let mut latest = Vec::new();
    for req in rec.metrics() {
        let mut batch = Vec::new();
        for rm in req.resource_metrics {
            for sm in rm.scope_metrics {
                for m in sm.metrics {
                    if m.name == metric_name
                        && let Some(Data::Sum(sum)) = m.data
                    {
                        batch.extend(sum.data_points);
                    }
                }
            }
        }
        if !batch.is_empty() {
            latest = batch;
        }
    }
    latest
}

fn point_int_value(dp: &NumberDataPoint) -> i64 {
    match dp.value {
        Some(number_data_point::Value::AsInt(v)) => v,
        _ => panic!("expected integer data point, got {:?}", dp.value),
    }
}

#[tokio::test]
async fn parented_query_emits_conformed_client_span_with_sanitized_query_text() {
    let rec = Recorder::start("sqlx-parented");
    let cfg = DbConfig::for_database::<sqlx::Sqlite>()
        .with_db_namespace("app_db")
        .with_server_address("localhost")
        .with_server_port(5432);
    let pool = memory_pool(rec.sdk(), Some(cfg)).await;
    rec.reset();

    let parent = rec.sdk().tracer("test").start("handler");
    let parent_sc = parent.span_context().clone();
    let cx = Context::new().with_span(parent);

    async {
        sqlx::query("INSERT INTO users (id, email, age) VALUES (1, 'a@example.com', 35)")
            .execute(&pool)
            .await
            .expect("insert");
        let row = sqlx::query(
            "SELECT id, email FROM users WHERE email = 'a@example.com' AND age > 30 AND id IN (1, 2, 3)",
        )
        .fetch_one(&pool)
        .await
        .expect("select");
        let id: i64 = row.get("id");
        assert_eq!(id, 1);
    }
    .with_context(cx.clone())
    .await;
    cx.span().end();

    let spans = rec.spans();
    let select_span = span_named(&spans, "SELECT users");
    assert_eq!(select_span.span_kind, SpanKind::Client);
    assert_eq!(select_span.parent_span_id, parent_sc.span_id());
    assert_eq!(
        span_attr(&select_span, "db.system.name").as_deref(),
        Some("sqlite")
    );
    assert_eq!(
        span_attr(&select_span, "db.namespace").as_deref(),
        Some("app_db")
    );
    assert_eq!(
        span_attr(&select_span, "db.operation.name").as_deref(),
        Some("SELECT")
    );
    assert_eq!(
        span_attr(&select_span, "db.collection.name").as_deref(),
        Some("users")
    );
    assert_eq!(
        span_attr(&select_span, "server.address").as_deref(),
        Some("localhost")
    );
    assert_eq!(
        span_attr(&select_span, "server.port").as_deref(),
        Some("5432")
    );
    let query_text = span_attr(&select_span, "db.query.text").expect("db.query.text");
    assert_eq!(
        query_text,
        "SELECT id, email FROM users WHERE email = ? AND age > ? AND id IN (?)"
    );
    assert!(!query_text.contains("a@example.com"));

    // Duration metric carries collection and system, never db.query.text.
    let points = duration_points(&rec);
    assert!(
        points.iter().any(
            |dp| proto_attr(&dp.attributes, "db.operation.name").as_deref() == Some("SELECT")
                && proto_attr(&dp.attributes, "db.collection.name").as_deref() == Some("users")
                && proto_attr(&dp.attributes, "db.query.text").is_none()
        ),
        "unexpected duration points: {points:?}"
    );

    rec.assert_conforms();
}

#[tokio::test]
async fn unparented_query_produces_no_span_by_default_but_records_metric() {
    let rec = Recorder::start("sqlx-unparented-default");
    let pool = memory_pool(rec.sdk(), None).await;
    rec.reset();

    sqlx::query("INSERT INTO users (id, email, age) VALUES (1, 'nobody@example.com', 20)")
        .execute(&pool)
        .await
        .expect("insert");

    assert!(
        rec.spans().is_empty(),
        "expected no spans without parent, got {:?}",
        rec.spans()
    );
    let points = duration_points(&rec);
    assert!(
        points.iter().any(|dp| dp.count >= 1
            && proto_attr(&dp.attributes, "db.collection.name").as_deref() == Some("users")),
        "expected duration metric even without parent span"
    );
}

#[tokio::test]
async fn unparented_query_records_root_span_when_enabled() {
    let rec = Recorder::start("sqlx-unparented-enabled");
    let cfg = DbConfig::for_database::<sqlx::Sqlite>().with_record_unparented_spans(true);
    let pool = memory_pool(rec.sdk(), Some(cfg)).await;
    rec.reset();

    sqlx::query("INSERT INTO users (id, email, age) VALUES (1, 'root@example.com', 20)")
        .execute(&pool)
        .await
        .expect("insert");

    let span = span_named(&rec.spans(), "INSERT users");
    assert_eq!(span.parent_span_id, SpanId::INVALID);
    assert_eq!(span.span_kind, SpanKind::Client);
}

#[tokio::test]
async fn without_query_text_and_unknown_dialect_omit_query_text() {
    let rec = Recorder::start("sqlx-no-query-text");
    let pool_off = memory_pool(
        rec.sdk(),
        Some(DbConfig::for_database::<sqlx::Sqlite>().without_query_text()),
    )
    .await;
    let pool_other = memory_pool(rec.sdk(), Some(DbConfig::new("microsoft.sql_server"))).await;
    rec.reset();

    let parent = rec.sdk().tracer("test").start("handler");
    let cx = Context::new().with_span(parent);

    async {
        sqlx::query("DELETE FROM users WHERE id = 7")
            .execute(&pool_off)
            .await
            .expect("delete");
        sqlx::query("UPDATE users SET age = 40 WHERE id = 7")
            .execute(&pool_other)
            .await
            .expect("update");
    }
    .with_context(cx.clone())
    .await;
    cx.span().end();

    let spans = rec.spans();
    let del = span_named(&spans, "DELETE users");
    assert!(span_attr(&del, "db.query.text").is_none());
    assert_eq!(
        span_attr(&del, "db.operation.name").as_deref(),
        Some("DELETE")
    );

    let upd = span_named(&spans, "UPDATE users");
    assert!(span_attr(&upd, "db.query.text").is_none());
    assert_eq!(
        span_attr(&upd, "db.system.name").as_deref(),
        Some("microsoft.sql_server")
    );
}

#[tokio::test]
async fn query_text_is_bounded_to_4096_bytes_on_utf8_boundary() {
    let rec = Recorder::start("sqlx-bounded-query");
    let pool = memory_pool(rec.sdk(), None).await;
    rec.reset();

    let head = format!("SELECT '{}'", "a".repeat(4000));
    let long_cols = format!("SELECT {} FROM users", "id, ".repeat(1500) + "age");
    let parent = rec.sdk().tracer("test").start("handler");
    let cx = Context::new().with_span(parent);

    async {
        let _ = sqlx::query(AssertSqlSafe(head)).fetch_all(&pool).await;
        let _ = sqlx::query(AssertSqlSafe(long_cols)).fetch_all(&pool).await;
    }
    .with_context(cx.clone())
    .await;
    cx.span().end();

    let select_users = span_named(&rec.spans(), "SELECT users");
    let text = span_attr(&select_users, "db.query.text").expect("db.query.text");
    assert_eq!(text.len(), 4096);
}

#[tokio::test]
async fn error_queries_set_error_status_without_message_and_record_error_type() {
    let rec = Recorder::start("sqlx-errors");
    let pool = memory_pool(rec.sdk(), None).await;
    rec.reset();

    let parent = rec.sdk().tracer("test").start("handler");
    let cx = Context::new().with_span(parent);

    async {
        sqlx::query("INSERT INTO users (id, email, age) VALUES (1, 'dup@example.com', 25)")
            .execute(&pool)
            .await
            .expect("first insert");

        // Trigger a SQLite UNIQUE constraint error.
        let err =
            sqlx::query("INSERT INTO users (id, email, age) VALUES (2, 'dup@example.com', 26)")
                .execute(&pool)
                .await
                .expect_err("unique violation");
        assert!(err.as_database_error().is_some());

        // Trigger RowNotFound on fetch_one.
        let not_found = sqlx::query("SELECT id FROM users WHERE id = 999")
            .fetch_one(&pool)
            .await
            .expect_err("row not found");
        assert!(matches!(not_found, sqlx::Error::RowNotFound));
    }
    .with_context(cx.clone())
    .await;
    cx.span().end();

    let spans = rec.spans();
    let failed_insert = spans
        .iter()
        .find(|s| s.name == "INSERT users" && matches!(s.status, Status::Error { .. }))
        .expect("failed insert span");
    assert_eq!(
        failed_insert.status,
        Status::error(""),
        "status description must be empty so error messages cannot leak values"
    );
    assert!(failed_insert.events.is_empty());
    assert_eq!(
        span_attr(failed_insert, "error.type").as_deref(),
        Some("sqlx::Error::Database")
    );
    assert!(
        span_attr(failed_insert, "db.response.status_code").is_some(),
        "expected SQLite error code in db.response.status_code"
    );

    let failed_select = span_named(&spans, "SELECT users");
    assert_eq!(failed_select.status, Status::error(""));
    assert_eq!(
        span_attr(&failed_select, "error.type").as_deref(),
        Some("sqlx::Error::RowNotFound")
    );

    let points = duration_points(&rec);
    assert!(
        points
            .iter()
            .any(|dp| proto_attr(&dp.attributes, "error.type").as_deref()
                == Some("sqlx::Error::Database")),
        "expected error.type on duration metric: {points:?}"
    );
}

#[tokio::test]
async fn transactions_connections_and_streaming_queries_are_instrumented() {
    let rec = Recorder::start("sqlx-tx-conn");
    let pool = memory_pool(rec.sdk(), None).await;
    rec.reset();

    let parent = rec.sdk().tracer("test").start("handler");
    let parent_sc = parent.span_context().clone();
    let cx = Context::new().with_span(parent);

    async {
        // Transaction commit path.
        let mut tx = pool.begin().await.expect("begin");
        sqlx::query("INSERT INTO users (id, email, age) VALUES (10, 'tx@example.com', 28)")
            .execute(&mut tx)
            .await
            .expect("tx insert");
        tx.commit().await.expect("commit");

        // Transaction rollback path via acquired connection.
        let mut conn = pool.acquire().await.expect("acquire");
        let mut tx2 = conn.begin().await.expect("conn begin");
        sqlx::query("INSERT INTO users (id, email, age) VALUES (11, 'rb@example.com', 29)")
            .execute(&mut tx2)
            .await
            .expect("tx2 insert");
        tx2.rollback().await.expect("rollback");

        // Streaming fetch_many on acquired connection.
        let rows: Vec<_> = (&mut conn)
            .fetch("SELECT id FROM users")
            .try_collect()
            .await
            .expect("stream fetch");
        assert_eq!(rows.len(), 1);
    }
    .with_context(cx.clone())
    .await;
    cx.span().end();

    let spans = rec.spans();
    let names: Vec<_> = spans.iter().map(|s| s.name.as_ref()).collect();
    for expected in [
        "BEGIN",
        "INSERT users",
        "COMMIT",
        "ROLLBACK",
        "SELECT users",
    ] {
        assert!(
            names.contains(&expected),
            "missing span {expected:?} in {names:?}"
        );
    }
    for s in spans.iter().filter(|s| s.name != "handler") {
        assert_eq!(
            s.parent_span_id,
            parent_sc.span_id(),
            "span {} not parented under handler",
            s.name
        );
    }
}

#[tokio::test]
async fn pool_metrics_track_idle_used_max_and_stop_on_close() {
    let rec = Recorder::start("sqlx-pool-metrics");
    let raw = SqlitePoolOptions::new()
        .max_connections(4)
        .connect("sqlite::memory:")
        .await
        .expect("connect sqlite::memory:");
    let cfg = DbConfig::for_database::<sqlx::Sqlite>().with_pool_name("primary");
    let pool = O11yPool::with_config(raw, rec.sdk(), cfg);

    // Hold one checked-out connection so used == 1.
    let conn = pool.acquire().await.expect("acquire");
    let counts = pool_points(&rec, "db.client.connection.count");
    let used = counts
        .iter()
        .find(|dp| {
            proto_attr(&dp.attributes, "db.client.connection.pool.name").as_deref()
                == Some("primary")
                && proto_attr(&dp.attributes, "db.client.connection.state").as_deref()
                    == Some("used")
        })
        .expect("used count");
    assert_eq!(point_int_value(used), 1);

    let max_pts = pool_points(&rec, "db.client.connection.max");
    let max_pt = max_pts
        .iter()
        .find(|dp| {
            proto_attr(&dp.attributes, "db.client.connection.pool.name").as_deref()
                == Some("primary")
        })
        .expect("max count");
    assert_eq!(point_int_value(max_pt), 4);

    // Return connection -> wait for sqlx's async release to finish returning it to idle.
    drop(conn);
    for _ in 0..100 {
        if pool.num_idle() == usize::try_from(pool.size()).expect("size") && pool.num_idle() >= 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let counts = pool_points(&rec, "db.client.connection.count");
    let idle = counts
        .iter()
        .find(|dp| {
            proto_attr(&dp.attributes, "db.client.connection.state").as_deref() == Some("idle")
        })
        .expect("idle count");
    let used = counts
        .iter()
        .find(|dp| {
            proto_attr(&dp.attributes, "db.client.connection.state").as_deref() == Some("used")
        })
        .expect("used count");
    assert_eq!(point_int_value(idle), i64::from(pool.size()));
    assert_eq!(point_int_value(used), 0);

    // Close the pool -> subsequent collections must not emit pool points.
    pool.close().await;
    rec.reset();
    assert!(
        pool_points(&rec, "db.client.connection.count").is_empty(),
        "pool metrics must stop reporting after close"
    );
}

#[tokio::test]
async fn full_correlation_triangle_with_tracing_span_and_log() {
    let rec = Recorder::start("sqlx-triangle");
    let pool = memory_pool(rec.sdk(), None).await;
    rec.reset();

    let subscriber = rec.sdk().subscriber();
    let _guard = tracing::subscriber::set_default(subscriber);

    async {
        sqlx::query("INSERT INTO users (id, email, age) VALUES (42, 'tri@example.com', 33)")
            .execute(&pool)
            .await
            .expect("insert");
        tracing::info!(user.id = 42, "user inserted");
    }
    .instrument(tracing::info_span!("request"))
    .await;

    let stmt_span = span_named(&rec.spans(), "INSERT users");
    let exemplars = rec.exemplars("db.client.operation.duration");
    assert_eq!(exemplars.len(), 1);
    assert_eq!(
        exemplars[0].trace_id,
        stmt_span.span_context.trace_id().to_string()
    );
    assert_eq!(
        exemplars[0].span_id,
        stmt_span.span_context.span_id().to_string(),
        "exemplar must point to the statement span"
    );

    rec.assert_conforms();
    rec.assert_correlated();
    rec.assert_triangle("db.client.operation.duration");
}

#[tokio::test]
async fn query_cancelled_by_timeout_records_canceled_span_and_duration() {
    let rec = Recorder::start("sqlx-timeout");
    let pool = memory_pool(rec.sdk(), None).await;
    // The helper pool holds one connection. Keep it checked out so the query
    // below waits in the pool and the timeout cancels it deterministically.
    let held = pool.acquire().await.expect("acquire");
    rec.reset();

    let parent = rec.sdk().tracer("test").start("handler");
    let cx = Context::new().with_span(parent);

    async {
        let res = tokio::time::timeout(
            std::time::Duration::from_millis(20),
            sqlx::query("SELECT id FROM users WHERE id = 1").fetch_optional(&pool),
        )
        .await;
        assert!(res.is_err(), "query must time out while the pool is empty");
    }
    .with_context(cx.clone())
    .await;
    cx.span().end();
    drop(held);

    let spans = rec.spans();
    let selects: Vec<_> = spans.iter().filter(|s| s.name == "SELECT users").collect();
    assert_eq!(selects.len(), 1, "want one span, got {spans:?}");
    assert_eq!(selects[0].status, Status::error(""));
    assert_eq!(
        span_attr(selects[0], "error.type").as_deref(),
        Some("canceled")
    );

    let points = duration_points(&rec);
    let canceled: u64 = points
        .iter()
        .filter(|dp| proto_attr(&dp.attributes, "error.type").as_deref() == Some("canceled"))
        .map(|dp| dp.count)
        .sum();
    assert_eq!(canceled, 1, "unexpected duration points: {points:?}");
}

#[tokio::test]
async fn row_stream_dropped_before_its_end_records_success() {
    let rec = Recorder::start("sqlx-stream-early-drop");
    let pool = memory_pool(rec.sdk(), None).await;
    for id in 1..=3 {
        sqlx::query(AssertSqlSafe(format!(
            "INSERT INTO users (id, email, age) VALUES ({id}, 'u{id}@example.com', 30)"
        )))
        .execute(&pool)
        .await
        .expect("insert");
    }
    rec.reset();

    let parent = rec.sdk().tracer("test").start("handler");
    let cx = Context::new().with_span(parent);

    async {
        let mut rows = sqlx::query("SELECT id FROM users ORDER BY id").fetch(&pool);
        let first = rows.try_next().await.expect("first row").expect("a row");
        let id: i64 = first.get("id");
        assert_eq!(id, 1);
        // Dropping the stream here is ordinary use, not a failure.
        drop(rows);
    }
    .with_context(cx.clone())
    .await;
    cx.span().end();

    let spans = rec.spans();
    let selects: Vec<_> = spans.iter().filter(|s| s.name == "SELECT users").collect();
    assert_eq!(selects.len(), 1, "want one span, got {spans:?}");
    assert_eq!(selects[0].status, Status::Unset);
    assert!(span_attr(selects[0], "error.type").is_none());

    let points = duration_points(&rec);
    let selects: Vec<_> = points
        .iter()
        .filter(|dp| proto_attr(&dp.attributes, "db.operation.name").as_deref() == Some("SELECT"))
        .collect();
    assert_eq!(
        selects.iter().map(|dp| dp.count).sum::<u64>(),
        1,
        "unexpected duration points: {points:?}"
    );
    assert!(
        selects
            .iter()
            .all(|dp| proto_attr(&dp.attributes, "error.type").is_none())
    );
}
