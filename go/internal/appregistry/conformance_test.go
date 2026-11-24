package appregistry_test

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/jamesainslie/libo11y/go/internal/appregistry"
)

// conformanceDir holds the registry cases every libo11y validator must
// agree on. The TypeScript validator in @libo11y/spec reads the same files.
const conformanceDir = "../../../conformance/appregistry"

// parseKind names a Parse failure in a form every language can produce,
// so the cases never depend on one YAML library's wording. When a file has
// several decode problems, the first one the decoder meets wins. An error
// it does not recognise fails the case loudly instead of passing as syntax.
func parseKind(err error) string {
	var typeErr *yaml.TypeError
	msg := err.Error()
	switch {
	case errors.Is(err, appregistry.ErrEmpty):
		return "empty"
	case errors.Is(err, appregistry.ErrSecondDocument):
		return "second-document"
	case strings.Contains(msg, "already defined"):
		return "duplicate-key"
	case errors.As(err, &typeErr) && strings.Contains(msg, "not found in type"):
		return "unknown-key"
	case errors.As(err, &typeErr):
		return "type"
	case strings.HasPrefix(msg, "parsing application registry: yaml: "):
		return "syntax"
	default:
		return "unclassified: " + msg
	}
}

// outcome renders what the validator makes of one registry file, in the
// .want format described in conformance/README.md.
func outcome(raw []byte) string {
	reg, err := appregistry.Parse(raw)
	if err != nil {
		return "parse: " + parseKind(err)
	}
	vs := reg.Validate()
	if len(vs) == 0 {
		return fmt.Sprintf("ok %d %s", len(reg.Attributes), reg.Namespace)
	}
	lines := make([]string, len(vs))
	for i, v := range vs {
		lines[i] = v.String()
	}
	return strings.Join(lines, "\n")
}

// requireRepo skips when the test runs outside the repository, such as
// from the module cache, where the conformance directory beside the go
// module does not exist. Inside the repository a missing file still fails.
func requireRepo(t *testing.T) {
	t.Helper()
	if _, err := os.Stat("../../../go.work"); err != nil {
		t.Skip("conformance cases live beside the go module; skipped outside the repository")
	}
}

func TestConformanceCases(t *testing.T) {
	requireRepo(t)
	cases, err := filepath.Glob(filepath.Join(conformanceDir, "*.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if len(cases) < 20 {
		t.Fatalf("found %d conformance cases in %s, want at least 20", len(cases), conformanceDir)
	}
	for _, path := range cases {
		name := strings.TrimSuffix(filepath.Base(path), ".yaml")
		t.Run(name, func(t *testing.T) {
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			want, err := os.ReadFile(strings.TrimSuffix(path, ".yaml") + ".want")
			if err != nil {
				t.Fatal(err)
			}
			if got := outcome(raw); got != strings.TrimRight(string(want), "\n") {
				t.Errorf("%s:\n got: %s\nwant: %s", name, got, want)
			}
		})
	}
}

// TestConformanceWantsHaveCases catches a .want file whose .yaml was
// renamed or deleted, which TestConformanceCases would otherwise ignore.
func TestConformanceWantsHaveCases(t *testing.T) {
	requireRepo(t)
	wants, err := filepath.Glob(filepath.Join(conformanceDir, "*.want"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range wants {
		if _, err := os.Stat(strings.TrimSuffix(want, ".want") + ".yaml"); err != nil {
			t.Errorf("%s has no matching .yaml case", want)
		}
	}
}
