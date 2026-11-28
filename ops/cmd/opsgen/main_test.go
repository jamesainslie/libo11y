package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jamesainslie/libo11y/ops/internal/pack"
	"github.com/jamesainslie/libo11y/ops/internal/thresholds"
)

// fakeBuild stands in for the pack while it has no artifacts of its own.
func fakeBuild(t thresholds.Thresholds, version string) ([]pack.Artifact, error) {
	return []pack.Artifact{
		{Path: "dashboards/libo11y-x.json", Data: []byte(version + "\n")},
		{Path: "alerts/x.rules.yaml", Data: []byte(t.GatewaySelector + "\n")},
	}, nil
}

func TestWriteThenCheck(t *testing.T) {
	dir := t.TempDir()
	var out, errOut bytes.Buffer
	if code := run([]string{"-check", "-out", dir}, &out, &errOut, fakeBuild); code != 1 {
		t.Fatalf("-check on an empty dir: exit %d, want 1\n%s", code, errOut.String())
	}
	if !strings.Contains(errOut.String(), "dashboards/libo11y-x.json (missing)") {
		t.Errorf("-check did not list the missing file:\n%s", errOut.String())
	}
	if code := run([]string{"-out", dir, "-version", "9.9.9"}, &out, &errOut, fakeBuild); code != 0 {
		t.Fatalf("write: exit %d\n%s", code, errOut.String())
	}
	b, err := os.ReadFile(filepath.Join(dir, "dashboards/libo11y-x.json"))
	if err != nil || string(b) != "9.9.9\n" {
		t.Fatalf("written file %q, %v", b, err)
	}
	if code := run([]string{"-check", "-out", dir, "-version", "9.9.9"}, &out, &errOut, fakeBuild); code != 0 {
		t.Fatalf("-check after write: exit %d\n%s", code, errOut.String())
	}
	if entries, _ := filepath.Glob(filepath.Join(dir, "*", "*.tmp")); len(entries) > 0 {
		t.Errorf("temporary files left behind: %v", entries)
	}
}

func TestThresholdsFlag(t *testing.T) {
	dir := t.TempDir()
	custom := filepath.Join(dir, "my.yaml")
	body := strings.Replace(string(mustRead(t, "../../thresholds.yaml")), `job=~"(.*/)?o11yrum-gateway"`, `job="rum"`, 1)
	if err := os.WriteFile(custom, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	if code := run([]string{"-out", dir, "-thresholds", custom}, &out, &errOut, fakeBuild); code != 0 {
		t.Fatalf("exit %d\n%s", code, errOut.String())
	}
	if b := mustRead(t, filepath.Join(dir, "alerts/x.rules.yaml")); string(b) != "job=\"rum\"\n" {
		t.Fatalf("thresholds not used: %q", b)
	}
	bad := filepath.Join(dir, "bad.yaml")
	if err := os.WriteFile(bad, []byte("regression_ratio: 0.5\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if code := run([]string{"-out", dir, "-thresholds", bad}, &out, &errOut, fakeBuild); code != 1 {
		t.Fatalf("invalid thresholds: exit %d, want 1", code)
	}
	if code := run([]string{"-nope"}, &out, &errOut, fakeBuild); code != 2 {
		t.Fatalf("unknown flag: exit %d, want 2", code)
	}
}

// The real pack builds and checks clean against a directory it wrote.
func TestRealPack(t *testing.T) {
	dir := t.TempDir()
	var out, errOut bytes.Buffer
	if code := run([]string{"-out", dir}, &out, &errOut, pack.Build); code != 0 {
		t.Fatalf("write: exit %d\n%s", code, errOut.String())
	}
	if code := run([]string{"-check", "-out", dir}, &out, &errOut, pack.Build); code != 0 {
		t.Fatalf("check: exit %d\n%s", code, errOut.String())
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// Writing removes generated files the pack no longer produces, and leaves
// every hand-written file alone.
func TestWriteRemovesStaleFiles(t *testing.T) {
	dir := t.TempDir()
	keep := []string{"thresholds.yaml", "alerts/tests/x.test.yaml", "datasources/example.yaml"}
	for _, p := range append([]string{"dashboards/libo11y-old.json"}, keep...) {
		full := filepath.Join(dir, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("x\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	var out, errOut bytes.Buffer
	if code := run([]string{"-out", dir}, &out, &errOut, fakeBuild); code != 0 {
		t.Fatalf("write: exit %d\n%s", code, errOut.String())
	}
	if _, err := os.Stat(filepath.Join(dir, "dashboards/libo11y-old.json")); !os.IsNotExist(err) {
		t.Errorf("the stale dashboard is still there: %v", err)
	}
	for _, p := range keep {
		if _, err := os.Stat(filepath.Join(dir, p)); err != nil {
			t.Errorf("%s was removed: %v", p, err)
		}
	}
	if code := run([]string{"-check", "-out", dir}, &out, &errOut, fakeBuild); code != 0 {
		t.Fatalf("-check after write: exit %d\n%s", code, errOut.String())
	}
}
