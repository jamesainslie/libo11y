package o11y

import (
	"context"
	"database/sql/driver"
	"fmt"
	"net/url"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

// maxCarrierText bounds the serialized form of a Carrier. URL encoding can
// triple a W3C tracestate at its largest (32 members with 256 byte keys and
// values), so a captured context can exceed it; capture then drops the
// tracestate, and then the baggage, to keep the text within the bound.
const maxCarrierText = 32 << 10

// Carrier field names in the serialized form: the W3C header names.
const (
	carrierTraceparent = "traceparent"
	carrierTracestate  = "tracestate"
	carrierBaggage     = "baggage"
)

// Carrier is the trace context of one operation, captured so that work it
// hands off (a job, a queued email, a message) can link back to it later,
// possibly in another process. It holds the W3C traceparent and tracestate
// and the baggage that would leave the process on an outbound request. The
// zero value means nothing was captured.
//
// A Carrier serializes to compact text, a URL-encoded query string such as
// "baggage=tenant%3Dacme&traceparent=00-...", so it can be stored with the
// work: in a database column ([Carrier.Value], [Carrier.Scan]), in JSON
// (through [Carrier.MarshalText]), or in a queue message. The zero Carrier
// serializes to empty text and to SQL NULL. The serialized form never
// exceeds 32 KiB: when the captured context would, the Carrier drops the
// tracestate, and then the baggage, and keeps the link.
type Carrier struct {
	traceparent string
	tracestate  string
	baggage     string
}

// Capture returns the trace context active in ctx as a [Carrier]. The
// baggage is what the global propagator injects, so after [Setup] it has
// passed the SDK's baggage egress filter; before Setup the global
// propagator injects nothing and the Carrier holds no baggage. Capture
// returns the zero Carrier when ctx holds no valid span context. With an
// SDK built by [New], use [SDK.Capture].
func Capture(ctx context.Context) Carrier {
	return capture(ctx, otel.GetTextMapPropagator())
}

// Capture is [Capture] bound to this SDK's propagator, for SDKs built with
// [New].
func (s *SDK) Capture(ctx context.Context) Carrier {
	return capture(ctx, s.propagator)
}

func capture(ctx context.Context, prop propagation.TextMapPropagator) Carrier {
	sc := trace.SpanContextFromContext(ctx)
	if !sc.IsValid() {
		return Carrier{}
	}
	out := propagation.MapCarrier{}
	prop.Inject(ctx, out)
	return newCarrier(sc, out[carrierBaggage])
}

// newCarrier returns the Carrier for the valid span context sc and the
// serialized baggage bag, with the traceparent and tracestate in canonical
// W3C form. When the serialized form would exceed maxCarrierText it drops
// the tracestate, and then the baggage, so whatever [Carrier.MarshalText]
// produces [Carrier.UnmarshalText] accepts.
func newCarrier(sc trace.SpanContext, bag string) Carrier {
	tc := propagation.MapCarrier{}
	propagation.TraceContext{}.Inject(trace.ContextWithSpanContext(context.Background(), sc), tc)
	c := Carrier{
		traceparent: tc[carrierTraceparent],
		tracestate:  tc[carrierTracestate],
		baggage:     bag,
	}
	if len(c.encode()) > maxCarrierText {
		c.tracestate = ""
	}
	if len(c.encode()) > maxCarrierText {
		c.baggage = ""
	}
	return c
}

// IsZero reports whether c holds no captured context.
func (c Carrier) IsZero() bool { return c.traceparent == "" }

// SpanContext returns the captured span context, marked remote. It is
// invalid for the zero Carrier.
func (c Carrier) SpanContext() trace.SpanContext {
	ctx := propagation.TraceContext{}.Extract(context.Background(), propagation.MapCarrier{
		carrierTraceparent: c.traceparent,
		carrierTracestate:  c.tracestate,
	})
	return trace.SpanContextFromContext(ctx)
}

// encode renders the serialized form: empty for the zero Carrier.
func (c Carrier) encode() string {
	if c.IsZero() {
		return ""
	}
	v := url.Values{}
	v.Set(carrierTraceparent, c.traceparent)
	if c.tracestate != "" {
		v.Set(carrierTracestate, c.tracestate)
	}
	if c.baggage != "" {
		v.Set(carrierBaggage, c.baggage)
	}
	return v.Encode()
}

// String returns the serialized form.
func (c Carrier) String() string { return c.encode() }

// MarshalText implements [encoding.TextMarshaler]. It never fails.
func (c Carrier) MarshalText() ([]byte, error) { return []byte(c.encode()), nil }

// UnmarshalText implements [encoding.TextUnmarshaler]. Empty text yields
// the zero Carrier. Text longer than 32 KiB, text that is not a query
// string, and text without a valid W3C traceparent fail with an error
// wrapping [ErrInvalidCarrier], and leave c unchanged. Baggage that does
// not parse as W3C baggage is dropped and the link kept, so damaged
// tracing data never makes stored work unreadable.
func (c *Carrier) UnmarshalText(text []byte) error {
	if len(text) == 0 {
		*c = Carrier{}
		return nil
	}
	if len(text) > maxCarrierText {
		return fmt.Errorf("%w: %d bytes exceeds the %d byte limit", ErrInvalidCarrier, len(text), maxCarrierText)
	}
	v, err := url.ParseQuery(string(text))
	if err != nil {
		return fmt.Errorf("%w: %w", ErrInvalidCarrier, err)
	}
	sc := Carrier{
		traceparent: v.Get(carrierTraceparent),
		tracestate:  v.Get(carrierTracestate),
	}.SpanContext()
	if !sc.IsValid() {
		return fmt.Errorf("%w: no valid traceparent", ErrInvalidCarrier)
	}
	bag := v.Get(carrierBaggage)
	if _, err := baggage.Parse(bag); err != nil {
		bag = ""
	}
	*c = newCarrier(sc, bag)
	return nil
}

// Value implements [driver.Valuer]: the serialized text, or nil (SQL NULL)
// for the zero Carrier.
func (c Carrier) Value() (driver.Value, error) {
	if c.IsZero() {
		return nil, nil
	}
	return c.encode(), nil
}

// Scan implements [database/sql.Scanner]. It accepts text columns (string
// or []byte) and NULL, which yields the zero Carrier.
func (c *Carrier) Scan(src any) error {
	switch v := src.(type) {
	case nil:
		*c = Carrier{}
		return nil
	case string:
		return c.UnmarshalText([]byte(v))
	case []byte:
		return c.UnmarshalText(v)
	default:
		return fmt.Errorf("%w: cannot scan %T", ErrInvalidCarrier, src)
	}
}

// StartLinked starts the span for detached work: a new root span with one
// link to the operation captured in carrier, so the work has a trace of its
// own and the two traces stay navigable both ways. The carrier's baggage
// members are added to the baggage in ctx, replacing members with the same
// key, so the returned context carries both. A zero carrier starts an unlinked
// root span. The span comes from the global tracer provider, under
// libo11y's instrumentation scope; with an SDK built by [New], use
// [SDK.StartLinked]. opts apply after the root and link options, so a
// caller can add attributes or a span kind, such as
// trace.WithSpanKind(trace.SpanKindConsumer) for a message consumer.
func StartLinked(ctx context.Context, carrier Carrier, name string, opts ...trace.SpanStartOption) (context.Context, trace.Span) {
	return startLinked(ctx, otel.GetTracerProvider(), carrier, name, opts)
}

// StartLinked is [StartLinked] bound to this SDK's tracer provider, for
// SDKs built with [New].
func (s *SDK) StartLinked(ctx context.Context, carrier Carrier, name string, opts ...trace.SpanStartOption) (context.Context, trace.Span) {
	return startLinked(ctx, s.tracerProvider, carrier, name, opts)
}

func startLinked(ctx context.Context, tp trace.TracerProvider, carrier Carrier, name string, opts []trace.SpanStartOption) (context.Context, trace.Span) {
	ctx = restoreBaggage(ctx, carrier.baggage)
	startOpts := make([]trace.SpanStartOption, 0, len(opts)+2)
	startOpts = append(startOpts, trace.WithNewRoot())
	if sc := carrier.SpanContext(); sc.IsValid() {
		startOpts = append(startOpts, trace.WithLinks(trace.Link{SpanContext: sc}))
	}
	startOpts = append(startOpts, opts...)
	return tp.Tracer(scopeName).Start(ctx, name, startOpts...)
}

// restoreBaggage adds the members of the serialized baggage bag to the
// baggage in ctx, replacing members with the same key. A Carrier only holds
// baggage that parses, so a parse failure leaves ctx unchanged.
func restoreBaggage(ctx context.Context, bag string) context.Context {
	if bag == "" {
		return ctx
	}
	restored, err := baggage.Parse(bag)
	if err != nil {
		return ctx
	}
	merged := baggage.FromContext(ctx)
	for _, m := range restored.Members() {
		next, err := merged.SetMember(m)
		if err != nil {
			// A parsed member cannot fail to set; skip defensively.
			continue
		}
		merged = next
	}
	return baggage.ContextWithBaggage(ctx, merged)
}
