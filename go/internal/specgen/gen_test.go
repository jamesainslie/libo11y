package main

import (
	"strings"
	"testing"
)

// TestEventTemplatesGenerated pins that a required template attribute on an
// event is emitted as a template requirement, not as a literal key.
func TestEventTemplatesGenerated(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	src := genTables(m)
	want := `"o11y.telemetry.configured": {RequiredTemplates: []attribute.Key{"o11y.config"}}`
	if !strings.Contains(src, want) {
		t.Errorf("generated tables missing %s", want)
	}
	if docRow := "| `o11y.telemetry.configured` | `o11y.config.<key>` |"; !strings.Contains(genDocs(m), docRow) {
		t.Errorf("generated docs missing %s", docRow)
	}
}
