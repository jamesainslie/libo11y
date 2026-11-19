package o11y_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/baggage"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11ytest"
)

// withBaggage returns ctx carrying one baggage member per key, value pair.
func withBaggage(ctx context.Context, t *testing.T, pairs ...string) context.Context {
	t.Helper()
	var members []baggage.Member
	for i := 0; i+1 < len(pairs); i += 2 {
		m, err := baggage.NewMember(pairs[i], pairs[i+1])
		if err != nil {
			t.Fatalf("baggage.NewMember(%q, %q): %v", pairs[i], pairs[i+1], err)
		}
		members = append(members, m)
	}
	bag, err := baggage.New(members...)
	if err != nil {
		t.Fatalf("baggage.New: %v", err)
	}
	return baggage.ContextWithBaggage(ctx, bag)
}

// spanNamed returns the one recorded span with the given name.
func spanNamed(t *testing.T, spans []sdktrace.ReadOnlySpan, name string) sdktrace.ReadOnlySpan {
	t.Helper()
	for _, s := range spans {
		if s.Name() == name {
			return s
		}
	}
	t.Fatalf("no span named %q", name)
	return nil
}

func TestCarrierRoundTripsThroughText(t *testing.T) {
	rec := o11ytest.Start(t)
	ctx, span := rec.SDK.TracerProvider().Tracer("test").Start(context.Background(), "request")
	defer span.End()

	carrier := rec.SDK.Capture(withBaggage(ctx, t, "tenant", "acme"))
	if carrier.IsZero() {
		t.Fatal("Capture inside a span returned the zero Carrier")
	}
	text, err := carrier.MarshalText()
	if err != nil {
		t.Fatalf("MarshalText: %v", err)
	}
	var back o11y.Carrier
	if err := back.UnmarshalText(text); err != nil {
		t.Fatalf("UnmarshalText(%q): %v", text, err)
	}
	got, want := back.SpanContext(), span.SpanContext()
	if got.TraceID() != want.TraceID() || got.SpanID() != want.SpanID() {
		t.Errorf("restored span context %v, want %v", got, want)
	}
	if !got.IsRemote() {
		t.Error("restored span context is not marked remote")
	}
	if back.String() != string(text) {
		t.Errorf("String() = %q, want %q", back.String(), text)
	}
	if !strings.Contains(string(text), "tenant%3Dacme") {
		t.Errorf("carrier text %q lacks the captured baggage", text)
	}
}

func TestCarrierInJSONAndSQL(t *testing.T) {
	rec := o11ytest.Start(t)
	ctx, span := rec.SDK.TracerProvider().Tracer("test").Start(context.Background(), "request")
	defer span.End()
	carrier := rec.SDK.Capture(ctx)

	type job struct {
		Trace o11y.Carrier `json:"trace"`
	}
	raw, err := json.Marshal(job{Trace: carrier})
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	var decoded job
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("json.Unmarshal(%s): %v", raw, err)
	}
	if decoded.Trace.SpanContext().SpanID() != span.SpanContext().SpanID() {
		t.Errorf("JSON round trip lost the span: %s", raw)
	}

	value, err := carrier.Value()
	if err != nil {
		t.Fatalf("Value: %v", err)
	}
	text, ok := value.(string)
	if !ok {
		t.Fatalf("Value() = %T, want string", value)
	}
	for _, src := range []any{text, []byte(text)} {
		var scanned o11y.Carrier
		if err := scanned.Scan(src); err != nil {
			t.Fatalf("Scan(%T): %v", src, err)
		}
		if scanned.String() != carrier.String() {
			t.Errorf("Scan(%T) = %q, want %q", src, scanned.String(), carrier.String())
		}
	}
}

func TestZeroCarrier(t *testing.T) {
	carrier := o11y.Capture(context.Background())
	if !carrier.IsZero() {
		t.Fatalf("Capture outside any span = %q, want the zero Carrier", carrier.String())
	}
	if text, err := carrier.MarshalText(); err != nil || len(text) != 0 {
		t.Errorf("MarshalText() = %q, %v, want empty", text, err)
	}
	if value, err := carrier.Value(); err != nil || value != nil {
		t.Errorf("Value() = %v, %v, want nil (SQL NULL)", value, err)
	}
	scanned := o11y.Carrier{}
	if err := scanned.Scan(nil); err != nil || !scanned.IsZero() {
		t.Errorf("Scan(nil) = %v, zero %v, want the zero Carrier", err, scanned.IsZero())
	}
	if err := scanned.UnmarshalText(nil); err != nil || !scanned.IsZero() {
		t.Errorf("UnmarshalText(nil) = %v, zero %v, want the zero Carrier", err, scanned.IsZero())
	}
}

func TestCarrierRejectsInvalidText(t *testing.T) {
	for name, text := range map[string]string{
		"not a query string": "%zz",
		"bad traceparent":    "traceparent=00-xyz",
		"no traceparent":     "baggage=a%3Db",
		"too long":           "traceparent=" + strings.Repeat("a", 40<<10),
	} {
		t.Run(name, func(t *testing.T) {
			var c o11y.Carrier
			if err := c.UnmarshalText([]byte(text)); !errors.Is(err, o11y.ErrInvalidCarrier) {
				t.Errorf("UnmarshalText error = %v, want ErrInvalidCarrier", err)
			}
		})
	}
	var c o11y.Carrier
	if err := c.Scan(42); !errors.Is(err, o11y.ErrInvalidCarrier) {
		t.Errorf("Scan(42) error = %v, want ErrInvalidCarrier", err)
	}
}

func TestCaptureAppliesBaggageEgressFilter(t *testing.T) {
	rec := o11ytest.Start(t, o11y.WithBaggageEgressForTest(func(key string) bool { return key != "session" }))
	ctx, span := rec.SDK.TracerProvider().Tracer("test").Start(context.Background(), "request")
	defer span.End()

	text := rec.SDK.Capture(withBaggage(ctx, t, "tenant", "acme", "session", "s-1")).String()
	if strings.Contains(text, "session") {
		t.Errorf("carrier %q carries baggage the egress filter refuses", text)
	}
	if !strings.Contains(text, "tenant") {
		t.Errorf("carrier %q lost baggage the egress filter allows", text)
	}
}

func TestStartLinkedStartsALinkedRoot(t *testing.T) {
	rec := o11ytest.Start(t)
	tracer := rec.SDK.TracerProvider().Tracer("test")
	ctx, origin := tracer.Start(context.Background(), "request")
	carrier := rec.SDK.Capture(withBaggage(ctx, t, "tenant", "acme"))
	origin.End()

	// A worker picks the job up later, inside a span of its own.
	workerCtx, loop := tracer.Start(context.Background(), "worker-loop")
	jobCtx, job := rec.SDK.StartLinked(workerCtx, carrier, "send-email", trace.WithSpanKind(trace.SpanKindConsumer))
	job.End()
	loop.End()

	span := spanNamed(t, rec.Spans(), "send-email")
	if span.Parent().IsValid() {
		t.Errorf("detached span has parent %v, want a new root", span.Parent())
	}
	if span.SpanContext().TraceID() == origin.SpanContext().TraceID() {
		t.Error("detached span joined the captured trace, want a trace of its own")
	}
	links := span.Links()
	if len(links) != 1 || links[0].SpanContext.SpanID() != origin.SpanContext().SpanID() {
		t.Errorf("links = %v, want one link to the captured span", links)
	}
	if span.SpanKind() != trace.SpanKindConsumer {
		t.Errorf("span kind = %v, want consumer (caller options apply)", span.SpanKind())
	}
	if got := baggage.FromContext(jobCtx).Member("tenant").Value(); got != "acme" {
		t.Errorf("baggage tenant = %q in the job context, want acme", got)
	}
}

func TestStartLinkedWithZeroCarrierStartsUnlinkedRoot(t *testing.T) {
	rec := o11ytest.Start(t)
	_, span := rec.SDK.StartLinked(context.Background(), o11y.Carrier{}, "job")
	span.End()
	got := spanNamed(t, rec.Spans(), "job")
	if got.Parent().IsValid() || len(got.Links()) != 0 {
		t.Errorf("parent %v, links %v, want an unlinked root", got.Parent(), got.Links())
	}
}

func TestPackageLevelCaptureUsesGlobals(t *testing.T) {
	restoreGlobals(t)
	rec := o11ytest.Start(t)
	otel.SetTracerProvider(rec.SDK.TracerProvider())
	otel.SetTextMapPropagator(rec.SDK.Propagator())

	ctx, origin := otel.Tracer("test").Start(context.Background(), "request")
	carrier := o11y.Capture(ctx)
	origin.End()
	_, job := o11y.StartLinked(context.Background(), carrier, "job")
	job.End()

	links := spanNamed(t, rec.Spans(), "job").Links()
	if len(links) != 1 || links[0].SpanContext.SpanID() != origin.SpanContext().SpanID() {
		t.Errorf("links = %v, want one link to the captured span", links)
	}
}

// remoteContext returns a context carrying a valid remote span context with
// the given tracestate.
func remoteContext(t *testing.T, tracestate string) (context.Context, trace.SpanContext) {
	t.Helper()
	ts, err := trace.ParseTraceState(tracestate)
	if err != nil {
		t.Fatalf("trace.ParseTraceState: %v", err)
	}
	sc := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    trace.TraceID{0x0a, 0xf7, 0x65, 0x19, 0x16, 0xcd, 0x43, 0xdd, 0x84, 0x48, 0xeb, 0x21, 0x1c, 0x80, 0x31, 0x9c},
		SpanID:     trace.SpanID{0xb7, 0xad, 0x6b, 0x71, 0x69, 0x20, 0x33, 0x31},
		TraceFlags: trace.FlagsSampled,
		TraceState: ts,
		Remote:     true,
	})
	return trace.ContextWithRemoteSpanContext(context.Background(), sc), sc
}

func TestCarrierRoundTripsTracestate(t *testing.T) {
	rec := o11ytest.Start(t)
	ctx, _ := remoteContext(t, "vendor=abc,other=xyz")

	var back o11y.Carrier
	if err := back.UnmarshalText([]byte(rec.SDK.Capture(ctx).String())); err != nil {
		t.Fatalf("UnmarshalText: %v", err)
	}
	if got := back.SpanContext().TraceState().Get("vendor"); got != "abc" {
		t.Errorf("restored tracestate vendor = %q, want abc", got)
	}
}

func TestCaptureOfMaximalTracestateReadsBack(t *testing.T) {
	// The largest tracestate W3C allows: 32 members whose keys and values
	// are 256 characters that URL encoding triples in size.
	members := make([]string, 0, 32)
	for i := range 32 {
		members = append(members, fmt.Sprintf("k%02d%s=%s", i, strings.Repeat("/", 253), strings.Repeat("/", 256)))
	}
	ctx, sc := remoteContext(t, strings.Join(members, ","))
	rec := o11ytest.Start(t)

	text, err := rec.SDK.Capture(withBaggage(ctx, t, "tenant", "acme")).MarshalText()
	if err != nil {
		t.Fatalf("MarshalText: %v", err)
	}
	var back o11y.Carrier
	if err := back.UnmarshalText(text); err != nil {
		t.Fatalf("UnmarshalText of a captured carrier (%d bytes): %v", len(text), err)
	}
	if back.SpanContext().SpanID() != sc.SpanID() {
		t.Errorf("restored span %v, want %v", back.SpanContext().SpanID(), sc.SpanID())
	}
	if !strings.Contains(string(text), "tenant%3Dacme") {
		t.Errorf("carrier %q dropped the baggage, want only the tracestate dropped", text)
	}
}

func TestFailedUnmarshalLeavesCarrierUnchanged(t *testing.T) {
	rec := o11ytest.Start(t)
	ctx, _ := remoteContext(t, "vendor=abc")
	carrier := rec.SDK.Capture(ctx)
	want := carrier.String()

	if err := carrier.UnmarshalText([]byte("traceparent=00-xyz")); !errors.Is(err, o11y.ErrInvalidCarrier) {
		t.Fatalf("UnmarshalText error = %v, want ErrInvalidCarrier", err)
	}
	if carrier.String() != want {
		t.Errorf("after failed UnmarshalText carrier = %q, want %q", carrier.String(), want)
	}
	if err := carrier.Scan(42); !errors.Is(err, o11y.ErrInvalidCarrier) {
		t.Fatalf("Scan(42) error = %v, want ErrInvalidCarrier", err)
	}
	if carrier.String() != want {
		t.Errorf("after failed Scan carrier = %q, want %q", carrier.String(), want)
	}
	if err := carrier.Scan(""); err != nil || !carrier.IsZero() {
		t.Errorf(`Scan("") = %v, zero %v, want the zero Carrier`, err, carrier.IsZero())
	}
}

func TestCarrierDropsInvalidBaggage(t *testing.T) {
	rec := o11ytest.Start(t)
	ctx, sc := remoteContext(t, "vendor=abc")
	text := rec.SDK.Capture(ctx).String() + "&baggage=%3D%3D%3D"

	var c o11y.Carrier
	if err := c.UnmarshalText([]byte(text)); err != nil {
		t.Fatalf("UnmarshalText(%q): %v, want the link kept", text, err)
	}
	if strings.Contains(c.String(), "baggage") {
		t.Errorf("carrier %q kept baggage that does not parse", c.String())
	}
	if c.SpanContext().SpanID() != sc.SpanID() {
		t.Errorf("restored span %v, want %v", c.SpanContext().SpanID(), sc.SpanID())
	}
}

func TestStartLinkedMergesBaggageAndUsesLibraryScope(t *testing.T) {
	rec := o11ytest.Start(t)
	ctx, _ := remoteContext(t, "")
	carrier := rec.SDK.Capture(withBaggage(ctx, t, "tenant", "acme", "region", "eu"))

	workerCtx := withBaggage(context.Background(), t, "worker", "pool-1", "region", "us")
	jobCtx, job := rec.SDK.StartLinked(workerCtx, carrier, "job")
	job.End()

	bag := baggage.FromContext(jobCtx)
	for key, want := range map[string]string{"tenant": "acme", "region": "eu", "worker": "pool-1"} {
		if got := bag.Member(key).Value(); got != want {
			t.Errorf("baggage %s = %q in the job context, want %q", key, got, want)
		}
	}
	if got := spanNamed(t, rec.Spans(), "job").InstrumentationScope().Name; got != "github.com/jamesainslie/libo11y/go" {
		t.Errorf("instrumentation scope = %q, want libo11y's", got)
	}
}

func TestPackageLevelCaptureAppliesGlobalEgressFilter(t *testing.T) {
	restoreGlobals(t)
	rec := o11ytest.Start(t, o11y.WithBaggageEgressForTest(func(key string) bool { return key != "session" }))
	otel.SetTextMapPropagator(rec.SDK.Propagator())
	ctx, _ := remoteContext(t, "")

	text := o11y.Capture(withBaggage(ctx, t, "tenant", "acme", "session", "s-1")).String()
	if strings.Contains(text, "session") || !strings.Contains(text, "tenant") {
		t.Errorf("carrier %q, want tenant kept and session filtered", text)
	}
}

func TestCarrierKeepsValidBaggageMembers(t *testing.T) {
	rec := o11ytest.Start(t)
	ctx, _ := remoteContext(t, "")
	// tenant=acme is valid; "===" is not.
	text := rec.SDK.Capture(ctx).String() + "&baggage=tenant%3Dacme%2C%3D%3D%3D"

	var c o11y.Carrier
	if err := c.UnmarshalText([]byte(text)); err != nil {
		t.Fatalf("UnmarshalText(%q): %v", text, err)
	}
	if !strings.Contains(c.String(), "tenant%3Dacme") {
		t.Errorf("carrier %q dropped the valid baggage member", c.String())
	}
	if strings.Contains(c.String(), "%3D%3D%3D") {
		t.Errorf("carrier %q kept the invalid baggage member", c.String())
	}
	jobCtx, job := rec.SDK.StartLinked(context.Background(), c, "job")
	job.End()
	if got := baggage.FromContext(jobCtx).Member("tenant").Value(); got != "acme" {
		t.Errorf("baggage tenant = %q in the job context, want acme", got)
	}
	if n := baggage.FromContext(jobCtx).Len(); n != 1 {
		t.Errorf("job context holds %d baggage members, want only tenant", n)
	}
}

func TestStartLinkedKeepsBaggageUpToTheMemberLimit(t *testing.T) {
	rec := o11ytest.Start(t)
	ctx, _ := remoteContext(t, "")
	// SetMember does not enforce the W3C limit of 64 members; Parse does.
	bag := baggage.Baggage{}
	for i := range 70 {
		m, err := baggage.NewMember(fmt.Sprintf("k%02d", i), fmt.Sprintf("v%02d", i))
		if err != nil {
			t.Fatalf("baggage.NewMember: %v", err)
		}
		if bag, err = bag.SetMember(m); err != nil {
			t.Fatalf("SetMember: %v", err)
		}
	}
	carrier := rec.SDK.Capture(baggage.ContextWithBaggage(ctx, bag))

	jobCtx, job := rec.SDK.StartLinked(context.Background(), carrier, "job")
	job.End()
	restored := baggage.FromContext(jobCtx)
	if restored.Len() != 64 {
		t.Fatalf("job context holds %d baggage members, want the 64 Parse keeps", restored.Len())
	}
	for _, m := range restored.Members() {
		if want := bag.Member(m.Key()).Value(); m.Value() != want {
			t.Errorf("baggage %s = %q, want %q", m.Key(), m.Value(), want)
		}
	}

	var back o11y.Carrier
	if err := back.UnmarshalText([]byte(carrier.String())); err != nil {
		t.Fatalf("UnmarshalText: %v", err)
	}
	jobCtx, job = rec.SDK.StartLinked(context.Background(), back, "job")
	job.End()
	if n := baggage.FromContext(jobCtx).Len(); n != 64 {
		t.Errorf("after a text round trip the job context holds %d baggage members, want 64", n)
	}
}

func TestCarrierKeepsValidBaggageInOrder(t *testing.T) {
	rec := o11ytest.Start(t)
	ctx, _ := remoteContext(t, "")
	base := rec.SDK.Capture(ctx).String()
	text := base + "&baggage=c%3D3%2Ca%3D1%2C%3D%3D%3D%2Cb%3D2"

	for range 20 {
		var c o11y.Carrier
		if err := c.UnmarshalText([]byte(text)); err != nil {
			t.Fatalf("UnmarshalText(%q): %v", text, err)
		}
		if want := "baggage=c%3D3%2Ca%3D1%2Cb%3D2&" + base; c.String() != want {
			t.Fatalf("carrier = %q, want %q", c.String(), want)
		}
	}
}

func TestBaggageOverTheByteLimitIsDroppedWhole(t *testing.T) {
	// W3C caps baggage at 8192 bytes, and Parse refuses longer text whole,
	// as the W3C baggage propagator does on extract.
	rec := o11ytest.Start(t)
	ctx, sc := remoteContext(t, "")
	// baggage.New refuses text over the limit; SetMember does not.
	bag := baggage.Baggage{}
	for i := range 40 {
		m, err := baggage.NewMember(fmt.Sprintf("k%02d", i), strings.Repeat("v", 250))
		if err != nil {
			t.Fatalf("baggage.NewMember: %v", err)
		}
		if bag, err = bag.SetMember(m); err != nil {
			t.Fatalf("SetMember: %v", err)
		}
	}
	carrier := rec.SDK.Capture(baggage.ContextWithBaggage(ctx, bag))
	if !strings.Contains(carrier.String(), "baggage") {
		t.Fatalf("captured carrier %q has no baggage to drop", carrier.String())
	}

	var back o11y.Carrier
	if err := back.UnmarshalText([]byte(carrier.String())); err != nil {
		t.Fatalf("UnmarshalText: %v", err)
	}
	if strings.Contains(back.String(), "baggage") || back.SpanContext().SpanID() != sc.SpanID() {
		t.Errorf("carrier = %q, want the link kept and the baggage dropped", back.String())
	}
	jobCtx, job := rec.SDK.StartLinked(context.Background(), carrier, "job")
	job.End()
	if n := baggage.FromContext(jobCtx).Len(); n != 0 {
		t.Errorf("job context holds %d baggage members, want none", n)
	}
}

func TestCarrierKeepsTheMembersParseKeeps(t *testing.T) {
	rec := o11ytest.Start(t)
	ctx, _ := remoteContext(t, "")
	base := rec.SDK.Capture(ctx).String()
	for name, tc := range map[string]struct {
		bag  string
		want map[string]string
	}{
		"property with trailing space": {"a=1;p ,===,b=2", map[string]string{"a": "1", "b": "2"}},
		"spaces around members":        {" a = 1 ;p=x , === , b=2", map[string]string{"a": "1", "b": "2"}},
		"last duplicate wins":          {"a=1,a=2,===", map[string]string{"a": "2"}},
		"empty segment":                {"a=1,,===,b=2", map[string]string{"a": "1", "b": "2"}},
	} {
		t.Run(name, func(t *testing.T) {
			var c o11y.Carrier
			text := base + "&" + url.Values{"baggage": {tc.bag}}.Encode()
			if err := c.UnmarshalText([]byte(text)); err != nil {
				t.Fatalf("UnmarshalText(%q): %v", text, err)
			}
			jobCtx, job := rec.SDK.StartLinked(context.Background(), c, "job")
			job.End()
			bag := baggage.FromContext(jobCtx)
			if bag.Len() != len(tc.want) {
				t.Errorf("job baggage %q, want %v", bag.String(), tc.want)
			}
			for key, want := range tc.want {
				if got := bag.Member(key).Value(); got != want {
					t.Errorf("baggage %s = %q, want %q", key, got, want)
				}
			}
		})
	}
}
