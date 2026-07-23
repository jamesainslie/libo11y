package main

import "testing"

// TestLoadVersions pins that the manifest yields both version constants the
// generated artifacts embed.
func TestLoadVersions(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatalf("loading registry: %v", err)
	}
	if m.specVersion != "1.0.0" {
		t.Errorf("specVersion = %q, want %q", m.specVersion, "1.0.0")
	}
	if m.semconvVersion != "1.41.0" {
		t.Errorf("semconvVersion = %q, want %q", m.semconvVersion, "1.41.0")
	}
}
