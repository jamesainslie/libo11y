//! The propagator every SDK hands out: W3C Trace Context and W3C Baggage by
//! default, replaceable, and always wrapped by the baggage egress filter.

use std::fmt;
use std::sync::Arc;

use opentelemetry::Context;
use opentelemetry::baggage::{Baggage, BaggageExt};
use opentelemetry::propagation::text_map_propagator::FieldIter;
use opentelemetry::propagation::{Extractor, Injector, TextMapPropagator};
use opentelemetry_sdk::propagation::{BaggagePropagator, TraceContextPropagator};

/// A boxed propagator, as the SDK builder takes them.
pub type BoxedPropagator = Box<dyn TextMapPropagator + Send + Sync>;

/// Decides which baggage keys leave the process on inject.
pub(crate) type BaggageAllow = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// The SDK's propagator.
///
/// It runs the configured propagators in order, the default being W3C
/// Trace Context then W3C Baggage, and lists their fields in that order,
/// each once. Every propagator the SDK hands out is wrapped by the baggage
/// egress filter, which removes the baggage members its predicate refuses
/// on inject only; extraction and the field list pass through. The
/// predicate allows every key: no option sets it yet. Cloning is cheap.
#[derive(Clone)]
pub struct Propagator(Arc<Inner>);

struct Inner {
    propagators: Vec<BoxedPropagator>,
    fields: Vec<String>,
    allow: BaggageAllow,
}

impl Propagator {
    /// Builds the propagator from the configured list: none gives the
    /// default composite, one is used as it is, several form a composite in
    /// order. `allow` is the egress predicate, every key when `None`.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the builder constructs the propagator")
    )]
    pub(crate) fn new(propagators: Vec<BoxedPropagator>, allow: Option<BaggageAllow>) -> Self {
        let propagators = if propagators.is_empty() {
            vec![
                Box::new(TraceContextPropagator::new()) as BoxedPropagator,
                Box::new(BaggagePropagator::new()),
            ]
        } else {
            propagators
        };
        // A composite's field order is its propagators' order, each field
        // once, as Go's composeInOrder lists them.
        let mut fields: Vec<String> = Vec::new();
        for field in propagators.iter().flat_map(|p| p.fields()) {
            if !fields.iter().any(|f| f == field) {
                fields.push(field.to_owned());
            }
        }
        Self(Arc::new(Inner {
            propagators,
            fields,
            allow: allow.unwrap_or_else(|| Arc::new(|_| true)),
        }))
    }
}

impl TextMapPropagator for Propagator {
    /// Injects through every propagator in order, with the baggage the
    /// egress predicate allows.
    fn inject_context(&self, cx: &Context, injector: &mut dyn Injector) {
        let baggage = cx.baggage();
        let filtered;
        let cx = if baggage.iter().all(|(key, _)| (self.0.allow)(key.as_str())) {
            cx
        } else {
            let kept: Baggage = baggage
                .iter()
                .filter(|(key, _)| (self.0.allow)(key.as_str()))
                .map(|(key, (value, metadata))| (key.clone(), (value.clone(), metadata.clone())))
                .collect();
            filtered = cx.with_baggage(kept);
            &filtered
        };
        for propagator in &self.0.propagators {
            propagator.inject_context(cx, injector);
        }
    }

    /// Extracts through every propagator in order; ingress is not filtered.
    fn extract_with_context(&self, cx: &Context, extractor: &dyn Extractor) -> Context {
        self.0
            .propagators
            .iter()
            .fold(cx.clone(), |cx, propagator| {
                propagator.extract_with_context(&cx, extractor)
            })
    }

    fn fields(&self) -> FieldIter<'_> {
        FieldIter::new(&self.0.fields)
    }
}

impl fmt::Debug for Propagator {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Propagator")
            .field("fields", &self.0.fields)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::HashMap;

    use opentelemetry::KeyValue;
    use opentelemetry::trace::{
        SpanContext, SpanId, TraceContextExt, TraceFlags, TraceId, TraceState,
    };

    fn carrier_after_inject(propagator: &Propagator, cx: &Context) -> HashMap<String, String> {
        let mut carrier = HashMap::new();
        propagator.inject_context(cx, &mut carrier);
        carrier
    }

    fn with_baggage(pairs: &[(&'static str, &'static str)]) -> Context {
        Context::new().with_baggage(pairs.iter().map(|(k, v)| KeyValue::new(*k, *v)))
    }

    fn sampled_span() -> Context {
        Context::new().with_remote_span_context(SpanContext::new(
            TraceId::from(0x0af7_6519_16cd_43dd_8448_eb21_1c80_319c_u128),
            SpanId::from(0xb7ad_6b71_6920_3331_u64),
            TraceFlags::SAMPLED,
            true,
            TraceState::default(),
        ))
    }

    #[test]
    fn the_default_is_trace_context_then_baggage() {
        let propagator = Propagator::new(Vec::new(), None);
        assert_eq!(
            propagator.fields().collect::<Vec<_>>(),
            ["traceparent", "tracestate", "baggage"]
        );
        let carrier = carrier_after_inject(
            &propagator,
            &sampled_span().with_baggage([KeyValue::new("a", "1")]),
        );
        assert_eq!(
            carrier.get("traceparent").map(String::as_str),
            Some("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")
        );
        assert_eq!(carrier.get("baggage").map(String::as_str), Some("a=1"));
    }

    #[test]
    fn extraction_reads_both_formats() {
        let propagator = Propagator::new(Vec::new(), None);
        let carrier = HashMap::from([
            (
                "traceparent".to_owned(),
                "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01".to_owned(),
            ),
            ("baggage".to_owned(), "a=1,b=2".to_owned()),
        ]);
        let cx = propagator.extract_with_context(&Context::new(), &carrier);
        assert!(cx.span().span_context().is_remote());
        assert_eq!(
            cx.baggage().get("b").map(ToString::to_string).as_deref(),
            Some("2")
        );
    }

    #[test]
    fn one_propagator_is_used_as_it_is() {
        let propagator = Propagator::new(vec![Box::new(BaggagePropagator::new())], None);
        assert_eq!(propagator.fields().collect::<Vec<_>>(), ["baggage"]);
        let carrier = carrier_after_inject(&propagator, &sampled_span());
        assert!(!carrier.contains_key("traceparent"));
    }

    #[test]
    fn several_propagators_compose_in_order_with_fields_once() {
        let propagator = Propagator::new(
            vec![
                Box::new(BaggagePropagator::new()),
                Box::new(TraceContextPropagator::new()),
                Box::new(BaggagePropagator::new()),
            ],
            None,
        );
        assert_eq!(
            propagator.fields().collect::<Vec<_>>(),
            ["baggage", "traceparent", "tracestate"]
        );
    }

    // go/baggagefilter_test.go TestBaggageEgressFilterStripsOnInject.
    #[test]
    fn the_egress_filter_strips_on_inject() {
        let allow: BaggageAllow = Arc::new(|key| key == "keep");
        let propagator = Propagator::new(vec![Box::new(BaggagePropagator::new())], Some(allow));
        let carrier =
            carrier_after_inject(&propagator, &with_baggage(&[("keep", "1"), ("drop", "2")]));
        let baggage = carrier.get("baggage").cloned().unwrap_or_default();
        assert!(baggage.contains("keep=1"), "{baggage}");
        assert!(!baggage.contains("drop"), "{baggage}");
    }

    // TestEgressFilterWrapsCustomPropagator: a replacement is filtered too,
    // and extraction is not.
    #[test]
    fn the_egress_filter_wraps_a_replacement_and_spares_ingress() {
        let allow: BaggageAllow = Arc::new(|key| key != "internal.secret");
        let propagator = Propagator::new(
            vec![
                Box::new(TraceContextPropagator::new()),
                Box::new(BaggagePropagator::new()),
            ],
            Some(allow),
        );
        let carrier = carrier_after_inject(
            &propagator,
            &with_baggage(&[("keep", "1"), ("internal.secret", "2")]),
        );
        let baggage = carrier.get("baggage").cloned().unwrap_or_default();
        assert!(
            baggage.contains("keep=1") && !baggage.contains("internal.secret"),
            "{baggage}"
        );

        let inbound = HashMap::from([("baggage".to_owned(), "internal.secret=2".to_owned())]);
        let cx = propagator.extract_with_context(&Context::new(), &inbound);
        assert_eq!(
            cx.baggage()
                .get("internal.secret")
                .map(ToString::to_string)
                .as_deref(),
            Some("2")
        );
    }

    // TestDefaultEgressStillAllowsAll.
    #[test]
    fn the_default_egress_allows_every_key() {
        let propagator = Propagator::new(Vec::new(), None);
        let carrier = carrier_after_inject(&propagator, &with_baggage(&[("a", "1"), ("b", "2")]));
        let baggage = carrier.get("baggage").cloned().unwrap_or_default();
        assert!(
            baggage.contains("a=1") && baggage.contains("b=2"),
            "{baggage}"
        );
    }

    #[test]
    fn baggage_metadata_survives_the_filter() {
        let allow: BaggageAllow = Arc::new(|_| true);
        let propagator = Propagator::new(vec![Box::new(BaggagePropagator::new())], Some(allow));
        let inbound = HashMap::from([("baggage".to_owned(), "k=v;prop=1".to_owned())]);
        let cx = propagator.extract_with_context(&Context::new(), &inbound);
        let carrier = carrier_after_inject(&propagator, &cx);
        assert_eq!(
            carrier.get("baggage").map(String::as_str),
            Some("k=v;prop=1")
        );
        let _ = Baggage::new();
    }
}
