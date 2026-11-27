package main

import (
	"strings"
	"testing"
)

func TestGenRUMSpecFromRealRegistry(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	src, err := genRUMSpec(m)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"package rumspec",
		`const SpecVersion = "` + m.specVersion + `"`,
		`"o11y.rum.element.text": PII,`,
		`"session.id": Unbounded,`,
		`"o11y.rum.view.name": Bounded,`,
		`"o11y.rum.platform": Enum,`,
		`"o11y.rum.summary.seq": "int",`,
		`"o11y.rum.summary.lcp.value": "double",`,
		`"o11y.rum.vital.rating": {"good", "needs-improvement", "poor"},`,
		`"o11y.rum.view.summary": {`,
		`"o11y.telemetry.configured": {"o11y.config"},`,
		`"view": {"o11y.rum.platform", "o11y.rum.view.name", "o11y.rum.view.id", "o11y.rum.view.kind", "session.id"},`,
		`"o11y.rum.vital.lcp": {Instrument: "histogram", Unit: "s",`,
	} {
		if !strings.Contains(src, want) {
			t.Errorf("generated rumspec lacks %s", want)
		}
	}
}

func TestRenderIncludesRUMSpec(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	outputs, err := render(m)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(outputs[rumSpecPath], "package rumspec") {
		t.Fatalf("render does not produce %s", rumSpecPath)
	}
}
