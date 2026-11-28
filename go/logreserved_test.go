package o11y_test

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	o11y "github.com/jamesainslie/libo11y/go"
)

// renameTo returns a replacer that renames the attribute "alias" to key.
func renameTo(key string) o11y.AttrReplacer {
	return func(_ []string, a slog.Attr) slog.Attr {
		if a.Key == "alias" {
			a.Key = key
		}
		return a
	}
}

// reservedSinks runs emit inside a span and returns the span's trace ID and
// what each slog sink received (see groupSinks).
func reservedSinks(t *testing.T, replacer o11y.AttrReplacer, emit func(context.Context, *o11y.SDK)) (traceID string, sinks map[string]string) {
	t.Helper()
	var sdk *o11y.SDK
	sinks = groupSinksSDK(t, &sdk, func(*slog.Logger) {
		ctx, span := sdk.TracerProvider().Tracer("test").Start(context.Background(), "op")
		traceID = span.SpanContext().TraceID().String()
		emit(ctx, sdk)
		span.End()
	}, o11y.WithAttrReplacer(replacer))
	return traceID, sinks
}

// trace_id and span_id are reserved top-level keys that only the correlation
// layer writes. A replacer that renames an attribute to one of them must not
// put a second, caller-chosen identity on the record.
func TestReplacerCannotSetCorrelationKeys(t *testing.T) {
	t.Parallel()
	for _, key := range []string{"trace_id", "span_id"} {
		t.Run(key, func(t *testing.T) {
			t.Parallel()
			traceID, sinks := reservedSinks(t, renameTo(key), func(ctx context.Context, sdk *o11y.SDK) {
				sdk.Logger().InfoContext(ctx, "own", "alias", "ffffffffffffffffffffffffffffffff", "kept", "yes")
			})
			for sink, got := range sinks {
				if strings.Contains(got, "ffffffffffffffff") {
					t.Errorf("%s carries the caller's %s: %s", sink, key, got)
				}
				if !strings.Contains(got, "kept") {
					t.Errorf("%s lost the ordinary attribute: %s", sink, got)
				}
			}
			if got := sinks["console"]; strings.Count(got, `"trace_id"`) != 1 || !strings.Contains(got, traceID) {
				t.Errorf("console wants exactly one trace_id, %s: %s", traceID, got)
			}
		})
	}
}

// SDK.Event sets event.name itself. No caller attribute may add a second
// one: not directly, not through an inline group, and not through a
// replacer that renames an attribute to it or rewrites the name.
func TestEventNameIsSetOnlyByTheSDK(t *testing.T) {
	t.Parallel()
	rewriteName := func(_ []string, a slog.Attr) slog.Attr {
		if a.Key == "event.name" {
			return slog.String(a.Key, "forged.by.replacer")
		}
		return a
	}
	cases := map[string]struct {
		replacer o11y.AttrReplacer
		attrs    []slog.Attr
	}{
		"direct attribute":   {nil, []slog.Attr{slog.String("event.name", "forged.name")}},
		"inline group":       {nil, []slog.Attr{slog.Group("", slog.String("event.name", "forged.name"))}},
		"nested inline":      {nil, []slog.Attr{slog.Group("", slog.Group("", slog.String("event.name", "forged.name")))}},
		"renaming replacer":  {renameTo("event.name"), []slog.Attr{slog.String("alias", "forged.name")}},
		"rewriting replacer": {rewriteName, nil},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, sinks := reservedSinks(t, tc.replacer, func(ctx context.Context, sdk *o11y.SDK) {
				sdk.Event(ctx, "app.order.placed", append(tc.attrs, slog.String("kept", "yes"))...)
			})
			for sink, got := range sinks {
				if strings.Contains(got, "forged") {
					t.Errorf("%s carries a forged event name: %s", sink, got)
				}
				if !strings.Contains(got, "app.order.placed") || !strings.Contains(got, "kept") {
					t.Errorf("%s lost the event name or an ordinary attribute: %s", sink, got)
				}
			}
			if got := sinks["console"]; strings.Count(got, `"event.name"`) != 1 {
				t.Errorf("console wants exactly one event.name: %s", got)
			}
		})
	}
}

// An ordinary record may carry its own event.name attribute. It is not an
// event, so the level gate still applies to it and nothing rewrites it.
func TestOrdinaryRecordKeepsItsEventNameAttribute(t *testing.T) {
	t.Parallel()
	_, sinks := reservedSinks(t, nil, func(ctx context.Context, sdk *o11y.SDK) {
		sdk.Logger().DebugContext(ctx, "gated", "event.name", "app.below.the.gate")
		sdk.Logger().InfoContext(ctx, "own", "event.name", "app.plain.record")
	})
	for sink, got := range sinks {
		if strings.Contains(got, "app.below.the.gate") {
			t.Errorf("%s emitted a Debug record past the Info gate: %s", sink, got)
		}
		if !strings.Contains(got, "app.plain.record") {
			t.Errorf("%s lost the record's own event.name: %s", sink, got)
		}
	}
}
