//! The propagator every SDK hands out: W3C Trace Context and W3C Baggage by
//! default, replaceable, and always wrapped by the baggage egress filter.

use std::fmt;
use std::sync::Arc;

use opentelemetry::Context;
use opentelemetry::baggage::{Baggage, BaggageExt};
use opentelemetry::propagation::text_map_propagator::FieldIter;
use opentelemetry::propagation::{Extractor, Injector, TextMapPropagator};
use opentelemetry_sdk::propagation::{BaggagePropagator, TraceContextPropagator};

use crate::{EnvLookup, Error};

/// A boxed propagator, as the SDK builder takes them.
pub type BoxedPropagator = Box<dyn TextMapPropagator + Send + Sync>;

/// Decides which baggage keys leave the process on inject.
pub(crate) type BaggageAllow = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// The standard variable that names the propagators.
const PROPAGATORS: &str = "OTEL_PROPAGATORS";

/// The propagator that carries nothing, as `OTEL_PROPAGATORS` names it.
const NO_PROPAGATION: &str = "none";

/// What the effective configuration reports for propagators that name no
/// fields but are not the none propagator. An empty value would be easy to
/// misread.
const FIELDLESS_PROPAGATION: &str = "custom";

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
    /// What the effective configuration reports: the fields joined by
    /// commas, `none` for the none propagator, `custom` for propagators
    /// that name no fields.
    reported: String,
    allow: BaggageAllow,
}

impl Propagator {
    /// Builds the propagator from the configured list: none gives the
    /// default composite, one is used as it is, several form a composite in
    /// order. `allow` is the egress predicate, every key when `None`.
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
        let reported = if fields.is_empty() {
            FIELDLESS_PROPAGATION.to_owned()
        } else {
            fields.join(",")
        };
        Self(Arc::new(Inner {
            propagators,
            fields,
            reported,
            allow: allow.unwrap_or_else(|| Arc::new(|_| true)),
        }))
    }

    /// Resolves the propagator as Go does: the configured propagators win;
    /// otherwise `OTEL_PROPAGATORS` is read as a comma-separated list, each
    /// entry trimmed and empty entries dropped, so a value with no names is
    /// unset. Names are case-sensitive. `tracecontext`, `baggage` and
    /// `none` are shipped; a name Go resolves through its contrib registry
    /// but the Rust library does not ship, or a name nobody knows, is an
    /// error, checked in order, even next to known names or `none`. A list
    /// that names `none` carries nothing. With no names the default applies.
    pub(crate) fn resolve(
        configured: Vec<BoxedPropagator>,
        env: &EnvLookup,
        allow: Option<BaggageAllow>,
    ) -> Result<Self, Error> {
        if !configured.is_empty() {
            return Ok(Self::new(configured, allow));
        }
        let raw = env.get(PROPAGATORS).unwrap_or_default();
        let names: Vec<&str> = raw
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .collect();
        let mut propagators: Vec<BoxedPropagator> = Vec::with_capacity(names.len());
        for name in &names {
            match *name {
                "tracecontext" => propagators.push(Box::new(TraceContextPropagator::new())),
                "baggage" => propagators.push(Box::new(BaggagePropagator::new())),
                NO_PROPAGATION => {}
                "b3" | "b3multi" | "jaeger" | "xray" | "ottrace" => {
                    return Err(Error::UnsupportedPropagator {
                        name: (*name).to_owned(),
                    });
                }
                other => {
                    return Err(Error::UnknownPropagator {
                        name: other.to_owned(),
                    });
                }
            }
        }
        if names.contains(&NO_PROPAGATION) {
            return Ok(Self(Arc::new(Inner {
                propagators: Vec::new(),
                fields: Vec::new(),
                reported: NO_PROPAGATION.to_owned(),
                allow: allow.unwrap_or_else(|| Arc::new(|_| true)),
            })));
        }
        Ok(Self::new(propagators, allow))
    }

    /// The propagators as the effective configuration reports them: their
    /// fields in configured order, each once, `none` for the none
    /// propagator, and `custom` for propagators that name no fields.
    pub(crate) fn reported_fields(&self) -> &str {
        &self.0.reported
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
        let allow: BaggageAllow = Arc::new(|key| key != "drop");
        let propagator = Propagator::new(vec![Box::new(BaggagePropagator::new())], Some(allow));
        let inbound = HashMap::from([("baggage".to_owned(), "k=v;prop=1,drop=x".to_owned())]);
        let cx = propagator.extract_with_context(&Context::new(), &inbound);
        let carrier = carrier_after_inject(&propagator, &cx);
        assert_eq!(
            carrier.get("baggage").map(String::as_str),
            Some("k=v;prop=1")
        );
    }
}

#[cfg(test)]
mod env_tests {
    use super::*;

    use std::collections::HashMap;

    use opentelemetry::KeyValue;
    use opentelemetry::trace::{
        SpanContext, SpanId, TraceContextExt, TraceFlags, TraceId, TraceState,
    };

    use crate::{EnvLookup, Error};

    fn env(value: &str) -> EnvLookup {
        EnvLookup::from_pairs([("OTEL_PROPAGATORS", value)])
    }

    /// Injects a sampled span with baggage `keep=1,drop=2`.
    fn inject(propagator: &Propagator) -> HashMap<String, String> {
        let cx = Context::new()
            .with_remote_span_context(SpanContext::new(
                TraceId::from(1_u128),
                SpanId::from(2_u64),
                TraceFlags::SAMPLED,
                true,
                TraceState::default(),
            ))
            .with_baggage([KeyValue::new("keep", "1"), KeyValue::new("drop", "2")]);
        let mut carrier = HashMap::new();
        propagator.inject_context(&cx, &mut carrier);
        carrier
    }

    /// A propagator that carries nothing and names no fields, but is not
    /// the none propagator.
    #[derive(Debug)]
    struct Fieldless;

    impl TextMapPropagator for Fieldless {
        fn inject_context(&self, _: &Context, _: &mut dyn Injector) {}
        fn extract_with_context(&self, cx: &Context, _: &dyn Extractor) -> Context {
            cx.clone()
        }
        fn fields(&self) -> FieldIter<'_> {
            FieldIter::new(&[])
        }
    }

    // go/propagatorenv_test.go TestPropagatorsFromEnvironment.
    #[test]
    #[allow(clippy::too_many_lines, reason = "one table of Go's cases")]
    fn the_variable_selects_the_propagators() {
        struct Case {
            name: &'static str,
            env: &'static str,
            configured: fn() -> Vec<BoxedPropagator>,
            ignore_env: bool,
            want: &'static [&'static str],
            absent: &'static [&'static str],
            reported: &'static str,
        }
        fn none() -> Vec<BoxedPropagator> {
            Vec::new()
        }
        let cases = [
            Case {
                name: "unset keeps the default",
                env: "",
                configured: none,
                ignore_env: false,
                want: &["traceparent", "baggage"],
                absent: &[],
                reported: "traceparent,tracestate,baggage",
            },
            Case {
                name: "tracecontext alone drops baggage",
                env: "tracecontext",
                configured: none,
                ignore_env: false,
                want: &["traceparent"],
                absent: &["baggage"],
                reported: "traceparent,tracestate",
            },
            Case {
                name: "none injects nothing",
                env: "none",
                configured: none,
                ignore_env: false,
                want: &[],
                absent: &["traceparent", "baggage"],
                reported: "none",
            },
            Case {
                name: "the option beats the variable",
                env: "baggage",
                configured: || vec![Box::new(TraceContextPropagator::new())],
                ignore_env: false,
                want: &["traceparent"],
                absent: &["baggage"],
                reported: "traceparent,tracestate",
            },
            Case {
                name: "the option beats an unknown name",
                env: "bogus",
                configured: || vec![Box::new(TraceContextPropagator::new())],
                ignore_env: false,
                want: &["traceparent"],
                absent: &[],
                reported: "traceparent,tracestate",
            },
            Case {
                name: "hermetic mode ignores the variable",
                env: "bogus",
                configured: none,
                ignore_env: true,
                want: &["traceparent", "baggage"],
                absent: &[],
                reported: "traceparent,tracestate,baggage",
            },
            Case {
                name: "spaces around entries are trimmed",
                env: " tracecontext , baggage ",
                configured: none,
                ignore_env: false,
                want: &["traceparent", "baggage"],
                absent: &[],
                reported: "traceparent,tracestate,baggage",
            },
            Case {
                name: "a trailing comma is ignored",
                env: "tracecontext,",
                configured: none,
                ignore_env: false,
                want: &["traceparent"],
                absent: &["baggage"],
                reported: "traceparent,tracestate",
            },
            Case {
                name: "an all-empty value is unset",
                env: " , ,",
                configured: none,
                ignore_env: false,
                want: &["traceparent", "baggage"],
                absent: &[],
                reported: "traceparent,tracestate,baggage",
            },
            Case {
                name: "the report keeps the configured order",
                env: "baggage,tracecontext",
                configured: none,
                ignore_env: false,
                want: &["traceparent", "baggage"],
                absent: &[],
                reported: "baggage,traceparent,tracestate",
            },
            Case {
                name: "a fieldless propagator is not none",
                env: "",
                configured: || vec![Box::new(Fieldless)],
                ignore_env: false,
                want: &[],
                absent: &["traceparent", "baggage"],
                reported: "custom",
            },
            Case {
                name: "duplicate entries are reported once",
                env: "tracecontext,tracecontext",
                configured: none,
                ignore_env: false,
                want: &["traceparent"],
                absent: &["baggage"],
                reported: "traceparent,tracestate",
            },
        ];
        for case in cases {
            let lookup = if case.ignore_env {
                EnvLookup::empty()
            } else {
                env(case.env)
            };
            let propagator = Propagator::resolve((case.configured)(), &lookup, None)
                .unwrap_or_else(|err| panic!("{}: {err}", case.name));
            let carrier = inject(&propagator);
            for key in case.want {
                assert!(
                    carrier.contains_key(*key),
                    "{}: {carrier:?} lacks {key}",
                    case.name
                );
            }
            for key in case.absent {
                assert!(
                    !carrier.contains_key(*key),
                    "{}: {carrier:?} holds {key}",
                    case.name
                );
            }
            if case.want.is_empty() {
                assert!(carrier.is_empty(), "{}: {carrier:?}", case.name);
            }
            assert_eq!(propagator.reported_fields(), case.reported, "{}", case.name);
        }
    }

    // TestUnknownPropagatorFailsFast.
    #[test]
    fn an_unknown_name_fails_fast() {
        for (value, name) in [
            ("bogus", "bogus"),
            ("tracecontext,bogus", "bogus"),
            ("tracecontext, bogus ", "bogus"),
            ("bogus,none", "bogus"),
            ("TraceContext", "TraceContext"),
            ("tracecontext,Baggage", "Baggage"),
        ] {
            let err = Propagator::resolve(Vec::new(), &env(value), None).expect_err(value);
            assert!(
                matches!(&err, Error::UnknownPropagator { name: n } if n == name),
                "{value}: {err}"
            );
            assert!(
                err.to_string().starts_with("o11y: building propagator: "),
                "{err}"
            );
        }
    }

    #[test]
    fn a_name_only_go_ships_is_unsupported() {
        for name in ["b3", "b3multi", "jaeger", "xray", "ottrace"] {
            let err = Propagator::resolve(Vec::new(), &env(&format!("tracecontext,{name}")), None)
                .expect_err(name);
            assert!(
                matches!(&err, Error::UnsupportedPropagator { name: n } if n == name),
                "{err}"
            );
        }
    }

    // TestEnvironmentPropagatorKeepsBaggageEgressFilter.
    #[test]
    fn the_egress_filter_wraps_a_propagator_from_the_variable() {
        let allow: BaggageAllow = Arc::new(|key| key == "keep");
        let propagator = Propagator::resolve(Vec::new(), &env("tracecontext,baggage"), Some(allow))
            .expect("known names");
        assert_eq!(
            inject(&propagator).get("baggage").map(String::as_str),
            Some("keep=1")
        );
    }
}
