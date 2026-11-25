//! Helpers the integration tests share.

#![allow(dead_code, reason = "each test binary uses a different part")]

use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use opentelemetry::{Context, Value};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::error::OTelSdkResult;
use opentelemetry_sdk::metrics::InMemoryMetricExporter;
use opentelemetry_sdk::metrics::data::{AggregatedMetrics, MetricData, ResourceMetrics};
use opentelemetry_sdk::metrics::exporter::PushMetricExporter;
use opentelemetry_sdk::trace::{Span, SpanData, SpanExporter, SpanProcessor};

use libo11y::{Builder, Environment, Sdk};

/// A span exporter that keeps every span and the resource it was given,
/// through shutdown.
#[derive(Debug, Clone, Default)]
pub struct Spans {
    spans: Arc<Mutex<Vec<SpanData>>>,
    resource: Arc<Mutex<Option<Resource>>>,
}

impl Spans {
    pub fn spans(&self) -> Vec<SpanData> {
        self.spans.lock().expect("spans").clone()
    }

    pub fn named(&self, name: &str) -> SpanData {
        self.spans()
            .into_iter()
            .find(|span| span.name == name)
            .unwrap_or_else(|| panic!("no span {name} in {:?}", self.names()))
    }

    pub fn names(&self) -> Vec<String> {
        self.spans().iter().map(|s| s.name.to_string()).collect()
    }

    pub fn resource(&self) -> Option<Resource> {
        self.resource.lock().expect("resource").clone()
    }
}

impl SpanExporter for Spans {
    async fn export(&self, batch: Vec<SpanData>) -> OTelSdkResult {
        self.spans.lock().expect("spans").extend(batch);
        Ok(())
    }

    fn set_resource(&mut self, resource: &Resource) {
        *self.resource.lock().expect("resource") = Some(resource.clone());
    }
}

/// A span processor that keeps every ended span.
#[derive(Debug, Clone, Default)]
pub struct Ended(Arc<Mutex<Vec<SpanData>>>);

impl Ended {
    pub fn spans(&self) -> Vec<SpanData> {
        self.0.lock().expect("ended").clone()
    }
}

impl SpanProcessor for Ended {
    fn on_start(&self, _: &mut Span, _: &Context) {}

    fn on_end(&self, span: SpanData) {
        self.0.lock().expect("ended").push(span);
    }

    fn force_flush(&self) -> OTelSdkResult {
        Ok(())
    }

    fn shutdown_with_timeout(&self, _: Duration) -> OTelSdkResult {
        Ok(())
    }
}

/// A gate a hung export waits on until the test opens it, which it does
/// when dropped.
#[derive(Debug, Clone, Default)]
pub struct Gate(Arc<(Mutex<bool>, Condvar)>);

impl Gate {
    pub fn wait(&self) {
        let (open, cv) = &*self.0;
        let guard = open.lock().expect("gate");
        let _open = cv.wait_while(guard, |open| !*open).expect("gate");
    }

    pub fn open(&self) {
        let (open, cv) = &*self.0;
        *open.lock().expect("gate") = true;
        cv.notify_all();
    }
}

/// Opens its gate when dropped, so a hung export ends with the test.
pub struct Release(pub Gate);

impl Drop for Release {
    fn drop(&mut self) {
        self.0.open();
    }
}

/// A span exporter whose exports hang until the gate opens.
#[derive(Debug, Clone)]
pub struct HangingSpans(pub Gate);

impl SpanExporter for HangingSpans {
    async fn export(&self, _: Vec<SpanData>) -> OTelSdkResult {
        self.0.wait();
        Ok(())
    }
}

/// A metric exporter whose exports hang until the gate opens.
#[derive(Debug, Clone)]
pub struct HangingMetrics(pub Gate);

impl PushMetricExporter for HangingMetrics {
    async fn export(&self, _: &ResourceMetrics) -> OTelSdkResult {
        self.0.wait();
        Ok(())
    }

    fn force_flush(&self) -> OTelSdkResult {
        Ok(())
    }

    fn shutdown_with_timeout(&self, _: Duration) -> OTelSdkResult {
        Ok(())
    }

    fn temporality(&self) -> opentelemetry_sdk::metrics::Temporality {
        opentelemetry_sdk::metrics::Temporality::Cumulative
    }
}

/// A builder for a hermetic SDK named `name` that reports errors nowhere.
pub fn hermetic(name: &str) -> Builder {
    Sdk::builder()
        .service_name(name.to_owned())
        .environment(Environment::Test)
        .without_otel_env()
        .with_error_handler(|_| {})
}

/// The `o11y.schema.violations` points of the last export, as (signal,
/// rule, count), sorted.
pub fn violations(metrics: &InMemoryMetricExporter) -> Vec<(String, String, u64)> {
    let exported = metrics.get_finished_metrics().expect("metrics");
    let mut points = Vec::new();
    for metric in exported
        .last()
        .into_iter()
        .flat_map(ResourceMetrics::scope_metrics)
        .flat_map(opentelemetry_sdk::metrics::data::ScopeMetrics::metrics)
        .filter(|m| m.name() == "o11y.schema.violations")
    {
        if let AggregatedMetrics::U64(MetricData::Sum(sum)) = metric.data() {
            for point in sum.data_points() {
                let value = |key: &str| {
                    point
                        .attributes()
                        .find(|kv| kv.key.as_str() == key)
                        .map(|kv| kv.value.to_string())
                        .unwrap_or_default()
                };
                points.push((value("o11y.signal"), value("o11y.rule"), point.value()));
            }
        }
    }
    points.sort();
    points
}

/// The value of `key` among `attrs`, as a string.
pub fn attr(attrs: &[opentelemetry::KeyValue], key: &str) -> Option<String> {
    attrs
        .iter()
        .find(|kv| kv.key.as_str() == key)
        .map(|kv| match &kv.value {
            Value::String(s) => s.to_string(),
            other => other.to_string(),
        })
}
