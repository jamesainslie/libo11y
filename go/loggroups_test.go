package o11y_test

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"strings"
	"testing"

	"go.opentelemetry.io/contrib/bridges/otelslog"

	o11y "github.com/jamesainslie/libo11y/go"
)

// groupSinks runs emit against the SDK's own logger and returns what each
// slog sink received, rendered as text: the console line, the extra sink's
// record as JSON, and the OTLP record's attributes.
func groupSinks(t *testing.T, emit func(*slog.Logger), opts ...o11y.Option) map[string]string {
	t.Helper()
	var sdk *o11y.SDK
	return groupSinksSDK(t, &sdk, emit, opts...)
}

// groupSinksSDK is groupSinks for an emit function that needs the SDK
// itself, which it stores in *sdk before calling emit. emit must produce
// exactly one record.
func groupSinksSDK(t *testing.T, sdk **o11y.SDK, emit func(*slog.Logger), opts ...o11y.Option) map[string]string {
	t.Helper()
	exp := &memLogExporter{}
	extra, captured := newSlogCapture()
	opts = append([]o11y.Option{o11y.WithLogExporter(exp), o11y.WithExtraLogHandler(extra)}, opts...)
	built, _, _, console := newHermetic(t, opts...)
	*sdk = built
	emit(built.Logger())
	if err := built.ForceFlush(context.Background()); err != nil {
		t.Fatal(err)
	}
	recs, extras := exp.snapshot(), captured()
	if len(recs) != 1 || len(extras) != 1 {
		t.Fatalf("OTLP %d, extra %d records; want 1 each", len(recs), len(extras))
	}
	var extraLine bytes.Buffer
	if err := slog.NewJSONHandler(&extraLine, nil).Handle(context.Background(), extras[0]); err != nil {
		t.Fatal(err)
	}
	return map[string]string{
		"console": console.String(),
		"extra":   extraLine.String(),
		"otlp":    fmt.Sprint(logAttrs(recs[0])),
	}
}

// A slog group is a value under its own key, like a map: when that key is
// classified the group is judged whole, however the group was opened. A
// secret key drops it with every member.
func TestSlogGroupUnderSecretKeyIsDropped(t *testing.T) {
	t.Parallel()
	const key, secret = "http.request.header.authorization", "Bearer s3cr3t-value"
	forms := map[string]func(*slog.Logger){
		"inline group": func(l *slog.Logger) {
			l.Info("own", slog.Group(key, slog.String("value", secret)), slog.String("kept", "yes"))
		},
		"WithGroup": func(l *slog.Logger) {
			l.With("kept", "yes").WithGroup(key).Info("own", "value", secret)
		},
		"WithGroup and With": func(l *slog.Logger) {
			l.With("kept", "yes").WithGroup(key).With("value", secret).Info("own")
		},
		"nested under an open group": func(l *slog.Logger) {
			l.With("kept", "yes").WithGroup("http").WithGroup("request").WithGroup("header").
				Info("own", slog.Group("authorization", slog.String("value", secret)))
		},
		"group in a group": func(l *slog.Logger) {
			l.Info("own", slog.String("kept", "yes"),
				slog.Group(key, slog.Group("inner", slog.String("value", secret))))
		},
	}
	for name, emit := range forms {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			for sink, got := range groupSinks(t, emit) {
				if strings.Contains(got, "s3cr3t") {
					t.Errorf("%s leaked the secret group: %s", sink, got)
				}
				if !strings.Contains(got, "kept") {
					t.Errorf("%s lost the unclassified attribute: %s", sink, got)
				}
			}
		})
	}
}

// Under PIIHash a group under a PII key is one value. A log bridge renders
// the same group as a map under that key, so the slog pipeline and the
// bridge produce one token for it.
func TestSlogGroupUnderPIIKeyTokenMatchesBridge(t *testing.T) {
	t.Parallel()
	exp := &memLogExporter{}
	sdk, _, _, console := newHermetic(t, o11y.WithLogExporter(exp),
		o11y.WithPIIMode(o11y.PIIHash), o11y.WithPIIHashKey(testKey))
	group := slog.Group("host.ip",
		slog.String("v4", "10.9.9.9"), slog.Int("port", 22),
		slog.Group("route", slog.String("via", "10.9.9.1"), slog.Bool("default", true)),
		slog.Any("seen", map[string]any{"by": []string{"edge-1", "edge-2"}, "count": 3}),
		slog.Group("", slog.String("inlined", "yes")),
	)
	sdk.Logger().Info("own", group)
	otelslog.NewLogger("thirdparty", otelslog.WithLoggerProvider(sdk.LoggerProvider())).Info("bridged", group)
	if err := sdk.ForceFlush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := console.String(); strings.Contains(got, "10.9.9.9") {
		t.Fatalf("console leaked the PII group: %s", got)
	}
	consoleToken, _ := consoleRecords(t, console)[0]["host.ip"].(string)
	recs := exp.snapshot()
	if len(recs) != 2 {
		t.Fatalf("OTLP records = %d, want 2", len(recs))
	}
	ownToken, bridgeToken := logAttrs(recs[0])["host.ip"], logAttrs(recs[1])["host.ip"]
	if !strings.HasPrefix(consoleToken, "hmac-sha256:") || ownToken != consoleToken || bridgeToken != consoleToken {
		t.Errorf("console %q, OTLP leg %q, bridge %q: want one token", consoleToken, ownToken, bridgeToken)
	}
}

// A group under a PII key is dropped whole in the default mode.
func TestSlogGroupUnderPIIKeyIsDroppedByDefault(t *testing.T) {
	t.Parallel()
	sinks := groupSinks(t, func(l *slog.Logger) {
		l.Info("own", slog.Group("host.ip", slog.String("v4", "10.9.9.9")), slog.String("kept", "yes"))
	})
	for sink, got := range sinks {
		if strings.Contains(got, "10.9.9.9") {
			t.Errorf("%s leaked the PII group: %s", sink, got)
		}
	}
}
