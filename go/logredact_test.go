package o11y

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestClassifyingHandlerDropsSecretPerLeg(t *testing.T) {
	var buf bytes.Buffer
	inner := slog.NewJSONHandler(&buf, nil)
	h := classifyingHandler(inner, sinkOTLP, dropPolicy())
	rec := slog.NewRecord(time.Now(), slog.LevelInfo, "m", 0)
	rec.AddAttrs(slog.String("host.ip", "10.0.0.1")) // PII
	if err := h.Handle(context.Background(), rec); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(buf.String(), "10.0.0.1") {
		t.Fatalf("PII reached the sink: %s", buf.String())
	}
}

func TestClassifierWithGroupClassifiesEffectiveKey(t *testing.T) {
	var buf bytes.Buffer
	h := classifyingHandler(slog.NewJSONHandler(&buf, nil), sinkConsole, dropPolicy())
	slog.New(h.WithGroup("host")).Info("m", "ip", "10.0.0.1")
	if strings.Contains(buf.String(), "10.0.0.1") {
		t.Fatalf("grouped PII leaked through WithGroup: %s", buf.String())
	}
}

func TestClassifierWithAttrsClassifies(t *testing.T) {
	var buf bytes.Buffer
	h := classifyingHandler(slog.NewJSONHandler(&buf, nil), sinkConsole, dropPolicy())
	slog.New(h.WithAttrs([]slog.Attr{slog.String("host.ip", "10.0.0.1")})).Info("m")
	if strings.Contains(buf.String(), "10.0.0.1") {
		t.Fatalf("PII leaked through WithAttrs: %s", buf.String())
	}
}

func TestClassifierUncomparableValueDoesNotPanic(t *testing.T) {
	var buf bytes.Buffer
	h := classifyingHandler(slog.NewJSONHandler(&buf, nil), sinkConsole, dropPolicy())
	slog.New(h).Info("m", "v", []string{"value"}, "w", map[string]int{"n": 1})
	if !strings.Contains(buf.String(), `["value"]`) {
		t.Fatalf("value not serialized: %s", buf.String())
	}
}

// dropPolicy is a PIIDrop policy with no violation recorder, built from
// the generated classification table.
func dropPolicy() *sensitivityPolicy {
	return newSensitivityPolicy(newSettings([]Option{WithPIIMode(PIIDrop)}), nil, nil)
}

// A group opened with WithGroup under a classified key is that key's value,
// so nothing logged inside it reaches the sink. The classifier cannot see
// the whole group at once, so it drops the members under PIIDrop and under
// PIIHash alike.
func TestClassifierWithGroupUnderClassifiedKeyDropsMembers(t *testing.T) {
	t.Parallel()
	const secretKey, value = "http.request.header.authorization", "s3cr3t-value"
	hashPolicy := func() *sensitivityPolicy {
		return newSensitivityPolicy(newSettings([]Option{
			WithPIIMode(PIIHash), WithPIIHashKey(bytes.Repeat([]byte("k"), 32)),
		}), nil, nil)
	}
	cases := map[string]struct {
		policy func() *sensitivityPolicy
		emit   func(slog.Handler)
	}{
		"record attribute": {dropPolicy, func(h slog.Handler) {
			slog.New(h.WithGroup(secretKey)).Info("m", "value", value)
		}},
		"bound attribute": {dropPolicy, func(h slog.Handler) {
			slog.New(h.WithGroup(secretKey).WithAttrs([]slog.Attr{slog.String("value", value)})).Info("m")
		}},
		"deeper group": {dropPolicy, func(h slog.Handler) {
			slog.New(h.WithGroup(secretKey).WithGroup("inner")).Info("m", "value", value)
		}},
		"bound in a deeper group": {dropPolicy, func(h slog.Handler) {
			inner := h.WithGroup(secretKey).WithAttrs([]slog.Attr{slog.String("a", value)}).WithGroup("inner")
			slog.New(inner.WithAttrs([]slog.Attr{slog.String("b", value)})).Info("m", "c", value)
		}},
		"split path": {dropPolicy, func(h slog.Handler) {
			slog.New(h.WithGroup("http.request.header").WithGroup("authorization")).Info("m", "value", value)
		}},
		"PII key under PIIDrop": {dropPolicy, func(h slog.Handler) {
			slog.New(h.WithGroup("host.ip")).Info("m", "v4", value)
		}},
		"PII key under PIIHash": {hashPolicy, func(h slog.Handler) {
			slog.New(h.WithGroup("host.ip")).Info("m", "v4", value)
		}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			var buf bytes.Buffer
			tc.emit(classifyingHandler(slog.NewJSONHandler(&buf, nil), sinkConsole, tc.policy()))
			if strings.Contains(buf.String(), value) {
				t.Fatalf("classified group leaked through WithGroup: %s", buf.String())
			}
			if !strings.Contains(buf.String(), `"msg":"m"`) {
				t.Fatalf("record lost: %s", buf.String())
			}
		})
	}
}

// Under PIIAllow a PII key is kept, so a group opened under one is not
// sealed and its members are judged on their own keys as usual.
func TestClassifierWithGroupUnderAllowedPIIKeyKeepsMembers(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	policy := newSensitivityPolicy(newSettings([]Option{WithPIIMode(PIIAllow)}), nil, nil)
	h := classifyingHandler(slog.NewJSONHandler(&buf, nil), sinkConsole, policy)
	slog.New(h.WithGroup("host.ip")).Info("m", "v4", "10.9.9.9")
	if !strings.Contains(buf.String(), `"host.ip":{"v4":"10.9.9.9"}`) {
		t.Fatalf("PIIAllow dropped the group: %s", buf.String())
	}
}
