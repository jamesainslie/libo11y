package o11y

import (
	"runtime/debug"
	"testing"

	"go.opentelemetry.io/otel/attribute"
)

func attrMap(attrs []attribute.KeyValue) map[string]string {
	m := make(map[string]string, len(attrs))
	for _, kv := range attrs {
		m[string(kv.Key)] = kv.Value.AsString()
	}
	return m
}

func TestBuildInfoAttrs(t *testing.T) {
	info := &debug.BuildInfo{
		Main: debug.Module{Version: "v1.2.3"},
		Settings: []debug.BuildSetting{
			{Key: "vcs.revision", Value: "abc123def456"},
			{Key: "vcs.time", Value: "2026-07-06T12:00:00Z"},
			{Key: "vcs.modified", Value: "false"},
			{Key: "CGO_ENABLED", Value: "0"}, // must be ignored
		},
	}
	got := attrMap(buildInfoAttrs(info))

	// The spec renames the bare Go build keys to their semconv/o11y forms.
	want := map[string]string{
		"service.version":       "v1.2.3",
		"vcs.ref.head.revision": "abc123def456",
		"o11y.build.time":       "2026-07-06T12:00:00Z",
	}
	for key, wantValue := range want {
		if got[key] != wantValue {
			t.Errorf("%s = %q, want %q", key, got[key], wantValue)
		}
	}
	if _, present := got["CGO_ENABLED"]; present {
		t.Error("non-VCS build setting leaked into resource attributes")
	}

	// o11y.build.modified is a boolean attribute.
	var foundModified bool
	for _, kv := range buildInfoAttrs(info) {
		if string(kv.Key) == "o11y.build.modified" {
			foundModified = true
			if kv.Value.AsBool() {
				t.Errorf("o11y.build.modified = true, want false")
			}
		}
	}
	if !foundModified {
		t.Error("o11y.build.modified absent")
	}
}

func TestBuildInfoAttrsSkipsDevelVersion(t *testing.T) {
	info := &debug.BuildInfo{Main: debug.Module{Version: "(devel)"}}
	if got := attrMap(buildInfoAttrs(info)); got["service.version"] != "" {
		t.Errorf("(devel) version must not become service.version, got %q", got["service.version"])
	}
}

func TestBuildInfoAttrsEmptyInfo(t *testing.T) {
	if got := buildInfoAttrs(&debug.BuildInfo{}); len(got) != 0 {
		t.Errorf("empty build info produced attributes: %v", got)
	}
}
